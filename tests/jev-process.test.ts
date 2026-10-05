import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createJevProcess } from "../extensions/ce-core/jev/process.js";
import { createJevRuntime } from "../extensions/ce-core/jev/runtime.js";
import { JevRuntimeError } from "../extensions/ce-core/jev/errors.js";
import type { JevProcessInput, JevRequest } from "../extensions/ce-core/jev/types.js";

type Listener = (...args: never[]) => void;
type ListenerStore = Record<string, Listener[]>;

interface ProcessMockState {
	spawnCount: number;
	calls: Array<{ command: string; args: string[]; options: unknown }>;
	killed: string[];
	stdinData: string[];
	stdinEnded: boolean;
	stdout: ListenerStore;
	stderr: ListenerStore;
	stdin: ListenerStore;
	proc: ListenerStore;
}

const cp: ProcessMockState = {
	spawnCount: 0,
	calls: [],
	killed: [],
	stdinData: [],
	stdinEnded: false,
	stdout: {},
	stderr: {},
	stdin: {},
	proc: {},
};

function push(store: ListenerStore, event: string, cb: Listener): void {
	(store[event] ??= []).push(cb);
}

function fire(store: ListenerStore, event: string, ...args: unknown[]): void {
	for (const cb of store[event] ?? []) {
		(cb as (...innerArgs: unknown[]) => void)(...args);
	}
}

// Event-storage mock (see docs/solutions/testing/child-process-event-listener-mock-for-pi-extension-tests.md):
// `on` must retain callbacks or the runner's Promise never settles.
mock.module("node:child_process", () => ({
	spawn: (command: string, args: string[], options: unknown) => {
		cp.spawnCount += 1;
		cp.calls.push({ command, args, options });
		return {
			stdout: { on: (event: string, cb: Listener) => push(cp.stdout, event, cb) },
			stderr: { on: (event: string, cb: Listener) => push(cp.stderr, event, cb) },
			stdin: {
				on: (event: string, cb: Listener) => push(cp.stdin, event, cb),
				write: (data: string) => {
					cp.stdinData.push(data);
				},
				end: () => {
					cp.stdinEnded = true;
				},
			},
			on: (event: string, cb: Listener) => push(cp.proc, event, cb),
			kill: (signal?: string) => {
				cp.killed.push(signal ?? "SIGTERM");
				return true;
			},
			exitCode: null as number | null,
			signalCode: null as string | null,
		};
	},
}));

function resetMock(): void {
	cp.spawnCount = 0;
	cp.calls.length = 0;
	cp.killed.length = 0;
	cp.stdinData.length = 0;
	cp.stdinEnded = false;
	cp.stdout = {};
	cp.stderr = {};
	cp.stdin = {};
	cp.proc = {};
}

let spawnAllowed = false;

beforeEach(() => {
	resetMock();
	spawnAllowed = false;
});

// Offline guard (R9): no test spawns the runner unless it opts in explicitly.
afterEach(() => {
	if (!spawnAllowed) expect(cp.spawnCount).toBe(0);
});

const delay = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

function baseInput(overrides: Partial<JevProcessInput> = {}): JevProcessInput {
	return {
		command: "cmd",
		args: ["-p", "-m", "typesafe/jev"],
		stdin: "{}",
		cwd: "/work",
		timeoutMs: 1000,
		...overrides,
	};
}

async function captureError(promise: Promise<unknown>): Promise<JevRuntimeError> {
	const outcome = await promise.then(
		() => undefined,
		(error) => error,
	);
	expect(outcome).toBeInstanceOf(JevRuntimeError);
	return outcome as JevRuntimeError;
}

describe("jev process runner (Unit 4)", () => {
	beforeEach(() => {
		spawnAllowed = true;
	});

	test(
		"spawns with fixed args, shell:false, piped stdio, and cwd",
		async () => {
			const promise = createJevProcess().run(baseInput());

			expect(cp.calls).toHaveLength(1);
			expect(cp.calls[0].command).toBe("cmd");
			expect(cp.calls[0].args).toEqual(["-p", "-m", "typesafe/jev"]);
			expect(cp.calls[0].options).toEqual({
				cwd: "/work",
				shell: false,
				stdio: ["pipe", "pipe", "pipe"],
			});

			fire(cp.stdout, "data", Buffer.from('{"answers":{}}'));
			fire(cp.stderr, "data", Buffer.from("warn"));
			fire(cp.proc, "close", 0, null);
			const output = await promise;

			expect(output).toEqual({
				exitCode: 0,
				stdout: '{"answers":{}}',
				stderr: "warn",
				truncated: false,
			});
		},
		2000,
	);

	test(
		"writes the body to stdin, ends it, and swallows EPIPE",
		async () => {
			const promise = createJevProcess().run(baseInput({ stdin: '{"a":1}' }));

			expect(cp.stdinData.join("")).toBe('{"a":1}');
			expect(cp.stdinEnded).toBe(true);

			fire(
				cp.stdin,
				"error",
				Object.assign(new Error("write EPIPE"), { code: "EPIPE" }),
			);
			fire(cp.proc, "close", 3, null);
			const output = await promise;

			expect(output.exitCode).toBe(3);
		},
		2000,
	);

	test(
		"escalates SIGTERM to SIGKILL and raises timeout",
		async () => {
			const errorPromise = captureError(
				createJevProcess({ graceMs: 20 }).run(baseInput({ timeoutMs: 10 })),
			);

			await delay(25);
			expect(cp.killed).toContain("SIGTERM");
			await delay(40);

			expect(cp.killed).toContain("SIGKILL");
			expect((await errorPromise).code).toBe("timeout");
		},
		2000,
	);

	test(
		"clears the grace timer on a close during the grace window",
		async () => {
			const errorPromise = captureError(
				createJevProcess({ graceMs: 30 }).run(baseInput({ timeoutMs: 5 })),
			);

			await delay(12);
			expect(cp.killed).toContain("SIGTERM");
			fire(cp.proc, "close", 0, null);

			expect((await errorPromise).code).toBe("timeout");
			await delay(40);
			expect(cp.killed).not.toContain("SIGKILL");
		},
		2000,
	);

	test(
		"abort mid-flight kills the child and beats the timeout",
		async () => {
			const controller = new AbortController();
			const errorPromise = captureError(
				createJevProcess().run(
					baseInput({ timeoutMs: 100, signal: controller.signal }),
				),
			);

			controller.abort();
			expect(cp.killed).toContain("SIGTERM");
			expect((await errorPromise).code).toBe("aborted");
		},
		2000,
	);

	test(
		"abort during the grace window wins over timeout",
		async () => {
			const controller = new AbortController();
			const errorPromise = captureError(
				createJevProcess({ graceMs: 50 }).run(
					baseInput({ timeoutMs: 5, signal: controller.signal }),
				),
			);

			await delay(12);
			expect(cp.killed).toContain("SIGTERM");
			controller.abort();

			expect((await errorPromise).code).toBe("aborted");
			await delay(60);
			expect(cp.killed).not.toContain("SIGKILL");
		},
		2000,
	);

	test(
		"rejects a pre-aborted signal without spawning",
		async () => {
			const controller = new AbortController();
			controller.abort();

			const error = await captureError(
				createJevProcess().run(baseInput({ signal: controller.signal })),
			);

			expect(error.code).toBe("aborted");
			expect(cp.spawnCount).toBe(0);
		},
		2000,
	);

	test(
		"caps stdout at 1 MiB and marks truncation",
		async () => {
			const promise = createJevProcess().run(baseInput());

			fire(cp.stdout, "data", Buffer.alloc(1024 * 1024 + 10, 0x61));
			fire(cp.stdout, "data", Buffer.from("more"));
			fire(cp.proc, "close", 0, null);
			const output = await promise;

			expect(output.truncated).toBe(true);
			expect(Buffer.byteLength(output.stdout, "utf8")).toBeLessThanOrEqual(
				1024 * 1024,
			);
		},
		2000,
	);

	test(
		"caps stderr at 1 MiB",
		async () => {
			const promise = createJevProcess().run(baseInput());

			fire(cp.stderr, "data", Buffer.alloc(1024 * 1024 + 10, 0x62));
			fire(cp.proc, "close", 0, null);
			const output = await promise;

			expect(Buffer.byteLength(output.stderr, "utf8")).toBeLessThanOrEqual(
				1024 * 1024,
			);
		},
		2000,
	);

	test(
		"maps ENOENT to missing_executable and other spawn errors to spawn_failed",
		async () => {
			const enoent = captureError(createJevProcess().run(baseInput()));
			fire(
				cp.proc,
				"error",
				Object.assign(new Error("not found"), { code: "ENOENT" }),
			);
			expect((await enoent).code).toBe("missing_executable");

			resetMock();
			const eacces = captureError(createJevProcess().run(baseInput()));
			fire(
				cp.proc,
				"error",
				Object.assign(new Error("denied"), { code: "EACCES" }),
			);
			expect((await eacces).code).toBe("spawn_failed");
		},
		2000,
	);

	test(
		"settles once: a late close/error cannot double-settle",
		async () => {
			const promise = createJevProcess().run(baseInput());

			fire(cp.proc, "close", 0, null);
			fire(cp.proc, "error", new Error("late"));
			fire(cp.proc, "close", 1, null);
			const output = await promise;

			expect(output.exitCode).toBe(0);
		},
		2000,
	);
});

const validRequest: JevRequest = {
	state: { stage: "03-work" },
	questions: {
		noul: { type: "noul", instructions: "is it risky?" },
		choice: { type: "choice", instructions: "pick", criteria: { a: "A", b: "B" } },
		score: { type: "score", instructions: "rate", criteria: ["low", "mid", "high"] },
	},
};

describe("jev barrel integration with the real runner (Unit 6)", () => {
	beforeEach(() => {
		spawnAllowed = true;
	});

	test(
		"decides from the fixture through the mocked real runner",
		async () => {
			const fixture = JSON.parse(
				readFileSync(
					new URL("./fixtures/jev-answers.json", import.meta.url),
					"utf8",
				),
			) as unknown;
			const runtime = createJevRuntime({
				process: createJevProcess({ graceMs: 20 }),
			});

			const promise = runtime.decide(validRequest);
			fire(cp.stdout, "data", Buffer.from(JSON.stringify(fixture)));
			fire(cp.proc, "close", 0, null);
			const result = await promise;

			expect(result.model).toBe("typesafe/jev");
			expect(result.answers.noul).toEqual({ type: "noul", noul: 0.8 });
			expect(result.answers.choice).toEqual({
				type: "choice",
				choice: "a",
				probabilities: { a: 0.7, b: 0.3 },
				confidence: 0.7,
			});
		},
		2000,
	);

	test(
		"maps a non-zero close to nonzero_exit",
		async () => {
			const runtime = createJevRuntime({
				process: createJevProcess({ graceMs: 20 }),
			});
			const errorPromise = captureError(runtime.decide(validRequest));

			fire(cp.proc, "close", 5, null);

			const error = await errorPromise;
			expect(error.code).toBe("nonzero_exit");
			expect(error.reason).toBe("rate_limit");
		},
		2000,
	);

	test(
		"maps a truncated stdout to malformed_output",
		async () => {
			const runtime = createJevRuntime({
				process: createJevProcess({ graceMs: 20 }),
			});
			const errorPromise = captureError(runtime.decide(validRequest));

			fire(cp.stdout, "data", Buffer.alloc(1024 * 1024 + 1, 0x61));
			fire(cp.proc, "close", 0, null);

			expect((await errorPromise).code).toBe("malformed_output");
		},
		2000,
	);
});
