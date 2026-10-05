// Jev error taxonomy + request validation tests (requirements R2/R6).
import { describe, expect, test } from "bun:test";
import {
	JevRuntimeError,
	buildStderrExcerpt,
	mapExitCodeToReason,
} from "../extensions/ce-core/jev/errors.js";
import { validateRequest } from "../extensions/ce-core/jev/validate.js";
import type {
	JevCreateProcessOptions,
	JevDecideOptions,
	JevFakeOptions,
	JevProcessInput,
	JevProcessOutput,
	JevProcessRunner,
	JevRequest,
	JevResult,
	JevRuntimeOptions,
	JevTelemetryEvent,
} from "../extensions/ce-core/jev/types.js";

describe("jev errors (Unit 1)", () => {
	test("JevRuntimeError preserves code, message, exitCode, reason, stderrExcerpt, cause", () => {
		const cause = new Error("boom");
		const error = new JevRuntimeError({
			code: "nonzero_exit",
			message: "cmd exited with code 4",
			exitCode: 4,
			reason: "permission",
			stderrExcerpt: "denied",
			cause,
		});

		expect(error.code).toBe("nonzero_exit");
		expect(error.message).toBe("cmd exited with code 4");
		expect(error.exitCode).toBe(4);
		expect(error.reason).toBe("permission");
		expect(error.stderrExcerpt).toBe("denied");
		expect(error.cause).toBe(cause);
	});

	test("JevRuntimeError is an Error named JevRuntimeError", () => {
		const error = new JevRuntimeError({
			code: "timeout",
			message: "timed out",
		});

		expect(error).toBeInstanceOf(Error);
		expect(error.name).toBe("JevRuntimeError");
	});

	test("mapExitCodeToReason maps documented exit codes", () => {
		expect(mapExitCodeToReason(1)).toBe("general");
		expect(mapExitCodeToReason(2)).toBe("general");
		expect(mapExitCodeToReason(3)).toBe("auth");
		expect(mapExitCodeToReason(4)).toBe("permission");
		expect(mapExitCodeToReason(5)).toBe("rate_limit");
		expect(mapExitCodeToReason(6)).toBe("network");
		expect(mapExitCodeToReason(7)).toBe("server");
		expect(mapExitCodeToReason(8)).toBe("max_turns");
		expect(mapExitCodeToReason(9)).toBe("no_response");
		expect(mapExitCodeToReason(10)).toBe("insufficient_credits");
		expect(mapExitCodeToReason(130)).toBe("interrupted");
	});

	test("mapExitCodeToReason defaults unknown non-zero codes to general", () => {
		for (const code of [99, 124, 126, 127, 137, 143, 200]) {
			expect(mapExitCodeToReason(code)).toBe("general");
		}
	});

	test("buildStderrExcerpt caps output at 2 KiB", () => {
		const excerpt = buildStderrExcerpt("x".repeat(5000));

		expect(Buffer.byteLength(excerpt, "utf8")).toBeLessThanOrEqual(2048);
	});

	test("buildStderrExcerpt redacts the echoed request body", () => {
		const body = '{"state":"SECRET_SENTINEL","questions":{}}';
		const excerpt = buildStderrExcerpt(`error: ${body} rejected`, body);

		expect(excerpt).not.toContain("SECRET_SENTINEL");
		expect(excerpt).not.toContain(body);
	});

	test("buildStderrExcerpt preserves small stderr unchanged", () => {
		expect(buildStderrExcerpt("short stderr")).toBe("short stderr");
	});

	test("type surface accepts documented option/result shapes", () => {
		const input: JevProcessInput = {
			command: "cmd",
			args: ["-p", "-m", "typesafe/jev"],
			stdin: "{}",
			timeoutMs: 30_000,
		};
		const output: JevProcessOutput = { exitCode: 0, stdout: "{}", stderr: "" };
		const truncated: JevProcessOutput = {
			exitCode: 0,
			stdout: "{}",
			stderr: "",
			truncated: true,
		};
		const runner: JevProcessRunner = { run: async () => output };
		const createOptions: JevCreateProcessOptions = { graceMs: 10 };
		const runtimeOptions: JevRuntimeOptions = {
			process: runner,
			command: "cmd",
			timeoutMs: 1000,
			cwd: "/tmp",
			repoRoot: "/tmp",
			telemetry: () => {},
			now: () => 0,
			redactIds: true,
			platform: "linux",
		};
		const decideOptions: JevDecideOptions = { timeoutMs: 1, cwd: "/tmp" };
		const request: JevRequest = {
			state: { a: 1 },
			questions: {
				q1: { type: "noul", instructions: "is it risky?" },
				q2: { type: "choice", instructions: "pick", criteria: { a: "A" } },
				q3: { type: "score", instructions: "rate", criteria: ["low", "high"] },
			},
		};
		const event: JevTelemetryEvent = {
			outcome: "success",
			durationMs: 1,
			model: "typesafe/jev",
			questionIds: ["q1"],
			questionTypes: ["noul"],
			stateBytes: 1,
			requestBytes: 2,
			stdoutBytes: 3,
			stderrBytes: 0,
			warnings: [],
		};
		const result: JevResult = { answers: {}, model: "unknown", warnings: [] };
		const fakeOptions: JevFakeOptions = { queue: [], handler: () => output };

		expect(input.command).toBe("cmd");
		expect(runner).toBeDefined();
		expect(createOptions.graceMs).toBe(10);
		expect(runtimeOptions.platform).toBe("linux");
		expect(decideOptions.timeoutMs).toBe(1);
		expect(request.questions.q1.type).toBe("noul");
		expect(event.outcome).toBe("success");
		expect(result.model).toBe("unknown");
		expect(fakeOptions.queue).toEqual([]);
		expect(truncated.truncated).toBe(true);
	});
});

function expectInvalidRequest(run: () => unknown, pathContains: string): void {
	let thrown: unknown;
	try {
		run();
	} catch (error) {
		thrown = error;
	}
	expect(thrown).toBeInstanceOf(JevRuntimeError);
	const error = thrown as JevRuntimeError;
	expect(error.code).toBe("invalid_request");
	expect(error.message).toContain(pathContains);
}

function questionsById(ids: string[]): JevRequest["questions"] {
	const questions: JevRequest["questions"] = {};
	for (const id of ids) {
		questions[id] = { type: "noul", instructions: "is it risky?" };
	}
	return questions;
}

function requestWithBodyBytes(target: number): JevRequest {
	const questions: JevRequest["questions"] = {
		q1: { type: "noul", instructions: "x" },
	};
	const unicodeState = "é".repeat(200);
	const base = JSON.stringify({ state: unicodeState, questions });
	const padding = target - Buffer.byteLength(base, "utf8");
	return { state: unicodeState + "x".repeat(padding), questions };
}

describe("jev request validation (Unit 2)", () => {
	test("accepts a mixed noul/choice/score request and returns body + stateBytes", () => {
		const request: JevRequest = {
			state: { stage: "03-work" },
			questions: {
				q1: { type: "noul", instructions: "risky?" },
				q2: {
					type: "noul",
					instructions: "confident?",
					criteria: { true: "yes", false: "no" },
				},
				q3: { type: "choice", instructions: "pick", criteria: { a: "A", b: "B" } },
				q4: { type: "score", instructions: "rate", criteria: ["low", "mid", "high"] },
			},
		};

		const result = validateRequest(request);

		expect(result.request).toBe(request);
		expect(result.body).toBe(JSON.stringify({ state: request.state, questions: request.questions }));
		expect(result.stateBytes).toBe(Buffer.byteLength(JSON.stringify(request.state), "utf8"));
		expect(result.warnings).toEqual([]);
	});

	test("accepts 1 and 32 questions", () => {
		expect(validateRequest({ state: "s", questions: questionsById(["q0"]) }).body).toBeString();
		const ids = Array.from({ length: 32 }, (_, i) => `q${i}`);
		expect(validateRequest({ state: "s", questions: questionsById(ids) }).body).toBeString();
	});

	test("accepts 128-char id, 255 options, 2 and 10 levels", () => {
		const longId = "a".repeat(128);
		expect(validateRequest({ state: "s", questions: questionsById([longId]) }).body).toBeString();

		const options: Record<string, string> = {};
		for (let i = 0; i < 255; i++) options[`o${i}`] = `option ${i}`;
		expect(
			validateRequest({
				state: "s",
				questions: { q1: { type: "choice", instructions: "x", criteria: options } },
			}).body,
		).toBeString();

		for (const count of [2, 10]) {
			const levels = Array.from({ length: count }, (_, i) => `L${i}`);
			expect(
				validateRequest({
					state: "s",
					questions: { q1: { type: "score", instructions: "x", criteria: levels } },
				}).body,
			).toBeString();
		}
	});

	test("accepts empty-object and Unicode state", () => {
		expect(validateRequest({ state: {}, questions: questionsById(["q0"]) }).body).toBeString();
		expect(
			validateRequest({ state: "é-🚀-state", questions: questionsById(["q0"]) }).body,
		).toBeString();
	});

	test("rejects a question with an unknown type", () => {
		expectInvalidRequest(
			() =>
				validateRequest({
					state: "s",
					questions: { q1: { type: "bogus", instructions: "x" } },
				}),
			"questions.q1.type",
		);
	});

	test("rejects empty, 0, and 33 questions", () => {
		expectInvalidRequest(
			() => validateRequest({ state: "s", questions: {} }),
			"questions",
		);
		const tooMany = questionsById(Array.from({ length: 33 }, (_, i) => `q${i}`));
		expectInvalidRequest(
			() => validateRequest({ state: "s", questions: tooMany }),
			"questions",
		);
	});

	test("rejects 129-char and whitespace-only ids", () => {
		expectInvalidRequest(
			() => validateRequest({ state: "s", questions: questionsById(["a".repeat(129)]) }),
			"questions",
		);
		expectInvalidRequest(
			() => validateRequest({ state: "s", questions: questionsById(["   "]) }),
			"questions",
		);
	});

	test("rejects score with 1 or 11 levels", () => {
		for (const count of [1, 11]) {
			const levels = Array.from({ length: count }, (_, i) => `L${i}`);
			expectInvalidRequest(
				() =>
					validateRequest({
						state: "s",
						questions: { q1: { type: "score", instructions: "x", criteria: levels } },
					}),
				"questions.q1.criteria",
			);
		}
	});

	test("rejects choice with 256 options or an empty option key", () => {
		const options: Record<string, string> = {};
		for (let i = 0; i < 256; i++) options[`o${i}`] = `option ${i}`;
		expectInvalidRequest(
			() =>
				validateRequest({
					state: "s",
					questions: { q1: { type: "choice", instructions: "x", criteria: options } },
				}),
			"questions.q1.criteria",
		);
		expectInvalidRequest(
			() =>
				validateRequest({
					state: "s",
					questions: { q1: { type: "choice", instructions: "x", criteria: { "": "empty" } } },
				}),
			"questions.q1.criteria",
		);
	});

	test("rejects null, number, boolean, and missing state", () => {
		const questions = questionsById(["q0"]);
		expectInvalidRequest(() => validateRequest({ state: null, questions }), "state");
		expectInvalidRequest(() => validateRequest({ state: 42, questions }), "state");
		expectInvalidRequest(() => validateRequest({ state: true, questions }), "state");
		expectInvalidRequest(() => validateRequest({ questions }), "state");
	});

	test("rejects circular and BigInt state without leaking values", () => {
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		expectInvalidRequest(
			() => validateRequest({ state: circular, questions: questionsById(["q0"]) }),
			"state",
		);
		expectInvalidRequest(
			() =>
				validateRequest({ state: { big: BigInt(1) }, questions: questionsById(["q0"]) }),
			"state",
		);
	});

	test("accepts exactly 65 536 body bytes and rejects 65 537", () => {
		const accepted = requestWithBodyBytes(65_536);
		expect(Buffer.byteLength(JSON.stringify(accepted), "utf8")).toBe(65_536);
		expect(validateRequest(accepted).body).toBeString();

		const rejected = requestWithBodyBytes(65_537);
		expectInvalidRequest(() => validateRequest(rejected), "request");
	});

	test("rejects non-finite or non-positive timeoutMs", () => {
		const request = { state: "s", questions: questionsById(["q0"]) };
		for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
			expectInvalidRequest(
				() => validateRequest(request, { timeoutMs }),
				"timeoutMs",
			);
		}
	});

	test("never leaks a state sentinel into the error message", () => {
		const sentinel = "SENTINEL_LEAK_XYZ";
		let thrown: unknown;
		try {
			validateRequest({
				state: { secret: sentinel },
				questions: questionsById(Array.from({ length: 33 }, (_, i) => `q${i}`)),
			});
		} catch (error) {
			thrown = error;
		}
		const error = thrown as JevRuntimeError;
		expect(error).toBeInstanceOf(JevRuntimeError);
		expect(error.message).not.toContain(sentinel);
		expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain(sentinel);
	});

	test("documents that duplicate JSON keys collapse to one id", () => {
		const parsed = JSON.parse(
			'{"questions":{"a":{"type":"noul","instructions":"x"},"a":{"type":"choice"}}}',
		) as { questions: Record<string, unknown> };

		expect(Object.keys(parsed.questions)).toEqual(["a"]);
	});
});

