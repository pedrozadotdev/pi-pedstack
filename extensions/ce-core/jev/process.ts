import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { JevRuntimeError } from "./errors";
import type { JevErrorCode } from "./errors";
import type {
	JevCreateProcessOptions,
	JevProcessInput,
	JevProcessOutput,
	JevProcessRunner,
} from "./types";

const DEFAULT_GRACE_MS = 2000;
const MAX_STREAM_BYTES = 1024 * 1024;
const STDIO: ["pipe", "pipe", "pipe"] = ["pipe", "pipe", "pipe"];

/**
 * The only spawner in the Jev subsystem: fixed flags, no shell, piped stdio,
 * stdin write+end, 1 MiB stream caps, SIGTERM→SIGKILL timeout, and abort.
 */
export function createJevProcess(
	options: JevCreateProcessOptions = {},
): JevProcessRunner {
	const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
	return {
		run(input: JevProcessInput): Promise<JevProcessOutput> {
			return runJevProcess(input, graceMs);
		},
	};
}

interface StreamCapture {
	stdout: string;
	stderr: string;
	stdoutTruncated: boolean;
	appendStdout(chunk: Buffer): void;
	appendStderr(chunk: Buffer): void;
}

function createStreamCapture(): StreamCapture {
	let stdout = "";
	let stderr = "";
	let stdoutBytes = 0;
	let stderrBytes = 0;
	let stdoutTruncated = false;

	const appendStdout = (chunk: Buffer): void => {
		if (stdoutTruncated) return;
		const take = Math.min(chunk.length, MAX_STREAM_BYTES - stdoutBytes);
		stdout += chunk.subarray(0, take).toString("utf8");
		stdoutBytes += take;
		if (take < chunk.length) stdoutTruncated = true;
	};

	const appendStderr = (chunk: Buffer): void => {
		const take = Math.min(chunk.length, MAX_STREAM_BYTES - stderrBytes);
		stderr += chunk.subarray(0, take).toString("utf8");
		stderrBytes += take;
	};

	return {
		get stdout() {
			return stdout;
		},
		get stderr() {
			return stderr;
		},
		get stdoutTruncated() {
			return stdoutTruncated;
		},
		appendStdout,
		appendStderr,
	};
}

function writeStdin(child: ChildProcess, data: string): void {
	try {
		child.stdin?.write(data);
		child.stdin?.end();
	} catch {
		// A synchronous stdin failure must not mask the process outcome.
	}
}

function runJevProcess(
	input: JevProcessInput,
	graceMs: number,
): Promise<JevProcessOutput> {
	if (input.signal?.aborted) {
		return Promise.reject(
			new JevRuntimeError({
				code: "aborted",
				message: "process aborted before start",
			}),
		);
	}

	const child = spawn(input.command, input.args, {
		cwd: input.cwd,
		shell: false,
		stdio: STDIO,
	});
	const capture = createStreamCapture();

	// ponytail: one cohesive Promise state machine (resolve-once + timeout/abort
	// interplay) rather than over-splitting shared lifecycle state.
	return new Promise<JevProcessOutput>((resolve, reject) => {
		let timedOut = false;
		let settled = false;
		let deadline: ReturnType<typeof setTimeout> | undefined;
		let killTimer: ReturnType<typeof setTimeout> | undefined;

		const cleanup = (): void => {
			if (deadline) clearTimeout(deadline);
			if (killTimer) clearTimeout(killTimer);
			input.signal?.removeEventListener("abort", onAbort);
		};
		const settle = (settleWith: () => void): void => {
			if (settled) return;
			settled = true;
			cleanup();
			settleWith();
		};
		const fail = (
			code: JevErrorCode,
			message: string,
			cause?: unknown,
		): void => {
			settle(() => reject(new JevRuntimeError({ code, message, cause })));
		};
		const kill = (signal: NodeJS.Signals): void => {
			try {
				child.kill(signal);
			} catch {
				// The child may already be gone; the close/error handlers own the result.
			}
		};
		const onAbort = (): void => {
			kill("SIGTERM");
			fail("aborted", "process aborted");
		};

		child.stdout?.on("data", (chunk: Buffer) => capture.appendStdout(chunk));
		child.stderr?.on("data", (chunk: Buffer) => capture.appendStderr(chunk));
		child.stdin?.on("error", (error: NodeJS.ErrnoException) => {
			// stdin EPIPE can fire after close; swallow it so it never masks the outcome.
			if (error.code !== "EPIPE") return;
		});

		child.on("error", (error: NodeJS.ErrnoException) => {
			const code: JevErrorCode =
				error.code === "ENOENT" ? "missing_executable" : "spawn_failed";
			fail(code, `${input.command} failed to spawn: ${error.message}`, error);
		});

		child.on("close", (code: number | null) => {
			if (timedOut) {
				fail("timeout", `process exceeded ${input.timeoutMs} ms`);
				return;
			}
			settle(() =>
				resolve({
					exitCode: code ?? 0,
					stdout: capture.stdout,
					stderr: capture.stderr,
					truncated: capture.stdoutTruncated,
				}),
			);
		});

		input.signal?.addEventListener("abort", onAbort);
		writeStdin(child, input.stdin);

		deadline = setTimeout(() => {
			timedOut = true;
			kill("SIGTERM");
			killTimer = setTimeout(() => {
				kill("SIGKILL");
				fail("timeout", `process exceeded ${input.timeoutMs} ms`);
			}, graceMs);
		}, input.timeoutMs);
	});
}
