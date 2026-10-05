import { createHash } from "node:crypto";
import {
	JevRuntimeError,
	buildStderrExcerpt,
	mapExitCodeToReason,
} from "./errors";
import type { JevErrorCode } from "./errors";
import { createJevProcess } from "./process";
import { parseStdout, validateRequest, validateResponse } from "./validate";
import type { JevValidatedRequest } from "./validate";
import type {
	JevAnswer,
	JevDecideOptions,
	JevDecisionRecord,
	JevFakeOptions,
	JevFakeRuntime,
	JevProcessInput,
	JevProcessOutput,
	JevProcessRunner,
	JevQuestionType,
	JevRequest,
	JevResult,
	JevRuntime,
	JevRuntimeOptions,
	JevTelemetryEvent,
} from "./types";

const DEFAULT_COMMAND = "cmd";
const DEFAULT_TIMEOUT_MS = 30_000;
const JEV_ARGS = ["-p", "-m", "typesafe/jev"];

function isJevQuestionType(value: unknown): value is JevQuestionType {
	return value === "noul" || value === "choice" || value === "score";
}

/** Best-effort question ids/types for telemetry, even when the request is invalid. */
function collectAskedQuestions(request: unknown): {
	ids: string[];
	types: JevQuestionType[];
} {
	const ids: string[] = [];
	const types: JevQuestionType[] = [];
	if (typeof request !== "object" || request === null) return { ids, types };
	const questions = (request as { questions?: unknown }).questions;
	if (typeof questions !== "object" || questions === null || Array.isArray(questions)) {
		return { ids, types };
	}
	for (const [id, question] of Object.entries(
		questions as Record<string, unknown>,
	)) {
		ids.push(id);
		const type = (question as { type?: unknown } | null)?.type;
		if (isJevQuestionType(type)) types.push(type);
	}
	return { ids, types };
}

function redactId(id: string): string {
	return createHash("sha256").update(id).digest("hex").slice(0, 16);
}

function toDecisions(
	answers: Record<string, JevAnswer>,
): Record<string, JevDecisionRecord> {
	const decisions: Record<string, JevDecisionRecord> = {};
	for (const [id, answer] of Object.entries(answers)) {
		if (answer.type === "noul") {
			decisions[id] =
				answer.confidence === undefined
					? { noul: answer.noul }
					: { noul: answer.noul, confidence: answer.confidence };
		} else if (answer.type === "choice") {
			decisions[id] = {
				choice: answer.choice,
				confidence: answer.confidence,
			};
		} else {
			decisions[id] = {
				score: answer.score,
				confidence: answer.confidence,
			};
		}
	}
	return decisions;
}

function toJevError(error: unknown): JevRuntimeError {
	if (error instanceof JevRuntimeError) return error;
	return new JevRuntimeError({
		code: "spawn_failed",
		message: error instanceof Error ? error.message : "process runner failed",
		cause: error,
	});
}

interface DecisionRunContext {
	runner: JevProcessRunner;
	command: string;
	cwd: string;
	timeoutMs: number;
	platform: NodeJS.Platform;
	signal?: AbortSignal;
}

interface DecisionRun {
	result: JevResult;
	stdoutBytes: number;
	stderrBytes: number;
	exitCode: number;
}

async function executeDecision(
	validated: JevValidatedRequest,
	context: DecisionRunContext,
): Promise<DecisionRun> {
	if (context.platform === "win32") {
		throw new JevRuntimeError({
			code: "unsupported_platform",
			message: "Windows is not supported by the Jev runtime",
		});
	}

	const output = await context.runner.run({
		command: context.command,
		args: [...JEV_ARGS],
		stdin: validated.body,
		cwd: context.cwd,
		timeoutMs: context.timeoutMs,
		signal: context.signal,
	});
	const stdoutBytes = Buffer.byteLength(output.stdout, "utf8");
	const stderrBytes = Buffer.byteLength(output.stderr, "utf8");

	if (output.exitCode !== 0) {
		const reason = mapExitCodeToReason(output.exitCode);
		throw new JevRuntimeError({
			code: "nonzero_exit",
			message: `cmd exited with code ${output.exitCode} (${reason})`,
			exitCode: output.exitCode,
			reason,
			stderrExcerpt: buildStderrExcerpt(output.stderr, validated.body),
		});
	}

	const parsed = parseStdout(output.stdout, output.truncated ?? false);
	const response = validateResponse(parsed, validated.request);
	return {
		result: {
			answers: response.answers,
			model: response.model,
			usage: response.usage,
			warnings: response.warnings,
		},
		stdoutBytes,
		stderrBytes,
		exitCode: output.exitCode,
	};
}

export function createJevRuntime(options: JevRuntimeOptions = {}): JevRuntime {
	const runner: JevProcessRunner = options.process ?? createJevProcess();
	const command = options.command ?? DEFAULT_COMMAND;
	const defaultTimeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const platform = options.platform ?? process.platform;
	const now = options.now ?? (() => Date.now());
	const sink = options.telemetry;
	const redactIds = options.redactIds ?? false;

	const emit = (event: JevTelemetryEvent): void => {
		if (!sink) return;
		try {
			sink(event);
		} catch {
			// Sink contract (R8): a throwing telemetry sink never breaks a decision.
		}
	};

	return {
		async decide(
			request: JevRequest,
			decideOptions?: JevDecideOptions,
		): Promise<JevResult> {
			const startedAt = now();
			const asked = collectAskedQuestions(request);
			const telemetry: JevTelemetryEvent = {
				outcome: "failure",
				durationMs: 0,
				model: "unknown",
				questionIds: redactIds ? asked.ids.map(redactId) : asked.ids,
				questionTypes: asked.types,
				stateBytes: 0,
				requestBytes: 0,
				stdoutBytes: 0,
				stderrBytes: 0,
				warnings: [],
			};
			const finish = (
				outcome: "success" | "failure",
				errorCode?: JevErrorCode,
			): void => {
				emit({
					...telemetry,
					outcome,
					errorCode,
					durationMs: now() - startedAt,
				});
			};

			try {
				if (decideOptions?.signal?.aborted) {
					throw new JevRuntimeError({
						code: "aborted",
						message: "decision aborted before start",
					});
				}

				const timeoutMs = decideOptions?.timeoutMs ?? defaultTimeoutMs;
				const validated = validateRequest(request, { timeoutMs });
				telemetry.stateBytes = validated.stateBytes;
				telemetry.requestBytes = Buffer.byteLength(validated.body, "utf8");

				const run = await executeDecision(validated, {
					runner,
					command,
					platform,
					timeoutMs,
					signal: decideOptions?.signal,
					cwd:
						decideOptions?.cwd ??
						options.cwd ??
						options.repoRoot ??
						process.cwd(),
				});
				telemetry.stdoutBytes = run.stdoutBytes;
				telemetry.stderrBytes = run.stderrBytes;
				telemetry.exitCode = run.exitCode;
				telemetry.model = run.result.model;
				telemetry.usage = run.result.usage;
				telemetry.decisions = toDecisions(run.result.answers);
				telemetry.warnings = run.result.warnings;

				finish("success");
				return run.result;
			} catch (error) {
				const jevError = toJevError(error);
				finish("failure", jevError.code);
				throw jevError;
			}
		},
	};
}

/**
 * Deterministic offline runtime: a scripted handler or FIFO queue of process
 * outputs, recording every request and exact stdin. Never touches a real process.
 */
export function createFakeJevRuntime(
	options: JevFakeOptions = {},
): JevFakeRuntime {
	const handler = options.handler;
	const originalQueue = [...(options.queue ?? [])];
	const queue = [...originalQueue];
	const calls: JevProcessInput[] = [];
	const requests: JevRequest[] = [];

	const runner: JevProcessRunner = {
		async run(input: JevProcessInput): Promise<JevProcessOutput> {
			calls.push(input);
			let parsedRequest: JevRequest;
			try {
				parsedRequest = JSON.parse(input.stdin) as JevRequest;
			} catch {
				throw new JevRuntimeError({
					code: "spawn_failed",
					message: "fake Jev runtime received non-JSON stdin",
				});
			}
			const next = handler
				? handler(parsedRequest)
				: queue.shift();
			if (next === undefined) {
				throw new JevRuntimeError({
					code: "spawn_failed",
					message: "fake Jev runtime has no queued response",
				});
			}
			if (next instanceof Error) throw next;
			return next;
		},
	};

	const runtime = createJevRuntime({ ...options, process: runner });

	return {
		calls,
		requests,
		reset(): void {
			calls.length = 0;
			requests.length = 0;
			queue.length = 0;
			queue.push(...originalQueue);
		},
		async decide(
			request: JevRequest,
			decideOptions?: JevDecideOptions,
		): Promise<JevResult> {
			requests.push(request);
			return runtime.decide(request, decideOptions);
		},
	};
}