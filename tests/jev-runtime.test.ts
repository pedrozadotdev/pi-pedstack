// Jev runtime decide() offline tests (requirements R4/R5/R6/R8).
import { describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as barrel from "../extensions/ce-core/jev/index.js";
import { createJevProcess } from "../extensions/ce-core/jev/process.js";
import { JevRuntimeError } from "../extensions/ce-core/jev/errors.js";
import type { JevErrorCode, JevExitReason } from "../extensions/ce-core/jev/errors.js";
import {
	parseStdout,
	validateResponse,
} from "../extensions/ce-core/jev/validate.js";
import {
	createFakeJevRuntime,
	createJevRuntime,
} from "../extensions/ce-core/jev/runtime.js";
import type {
	JevProcessInput,
	JevRequest,
	JevTelemetryEvent,
} from "../extensions/ce-core/jev/types.js";

function expectJevError(
	run: () => unknown,
	code: JevErrorCode,
	pathContains?: string,
): JevRuntimeError {
	let thrown: unknown;
	try {
		run();
	} catch (error) {
		thrown = error;
	}
	expect(thrown).toBeInstanceOf(JevRuntimeError);
	const error = thrown as JevRuntimeError;
	expect(error.code).toBe(code);
	if (pathContains) expect(error.message).toContain(pathContains);
	return error;
}

async function expectJevErrorAsync(
	run: () => Promise<unknown>,
	code: JevErrorCode,
	pathContains?: string,
): Promise<JevRuntimeError> {
	let thrown: unknown;
	try {
		await run();
	} catch (error) {
		thrown = error;
	}
	expect(thrown).toBeInstanceOf(JevRuntimeError);
	const error = thrown as JevRuntimeError;
	expect(error.code).toBe(code);
	if (pathContains) expect(error.message).toContain(pathContains);
	return error;
}

const validRequest: JevRequest = {
	state: { stage: "03-work" },
	questions: {
		noul: { type: "noul", instructions: "is it risky?" },
		choice: { type: "choice", instructions: "pick", criteria: { a: "A", b: "B" } },
		score: { type: "score", instructions: "rate", criteria: ["low", "mid", "high"] },
	},
};

function happyResponse() {
	return {
		model: "typesafe/jev",
		answers: {
			noul: { type: "noul", noul: 0.8 },
			choice: {
				type: "choice",
				choice: "a",
				probabilities: { a: 0.7, b: 0.3 },
				confidence: 0.7,
			},
			score: {
				type: "score",
				score: 1.41,
				legend: { "0": "low", "1": "mid", "2": "high" },
				probabilities: { "0": 0.2, "1": 0.5, "2": 0.3 },
				confidence: 0.5,
			},
		},
		usage: { input_tokens: 10, output_tokens: 20 },
	};
}

function mutate(fn: (response: ReturnType<typeof happyResponse>) => void) {
	const response = happyResponse();
	fn(response);
	return response;
}

describe("jev stdout parsing (Unit 3)", () => {
	test("accepts a leading BOM and a trailing newline", () => {
		expect(parseStdout('\uFEFF{"answers":{"a":1}}\n')).toEqual({
			answers: { a: 1 },
		});
	});

	test("rejects non-JSON, empty, arrays, null, and preambles", () => {
		for (const bad of [
			"not json",
			"   ",
			"[]",
			"null",
			'log line\n{"answers":{}}',
		]) {
			expectJevError(() => parseStdout(bad), "malformed_output");
		}
	});

	test("rejects truncated stdout", () => {
		expectJevError(() => parseStdout('{"answers":{}', true), "malformed_output");
	});
});

describe("jev response validation (Unit 3)", () => {
	test("returns typed answers, model, usage, and no warnings for a happy response", () => {
		const result = validateResponse(happyResponse(), validRequest);

		expect(result.model).toBe("typesafe/jev");
		expect(result.usage).toEqual({ input_tokens: 10, output_tokens: 20 });
		expect(result.warnings).toEqual([]);
		expect(result.answers.noul).toEqual({ type: "noul", noul: 0.8 });
		expect(result.answers.choice).toEqual({
			type: "choice",
			choice: "a",
			probabilities: { a: 0.7, b: 0.3 },
			confidence: 0.7,
		});
	});

	test("tolerates missing model/usage but rejects present-but-invalid", () => {
		const withoutModel = mutate((r) => {
			delete (r as { model?: unknown }).model;
			delete (r as { usage?: unknown }).usage;
		});
		expect(validateResponse(withoutModel, validRequest).model).toBe("unknown");
		expect(validateResponse(withoutModel, validRequest).usage).toBeUndefined();

		expectJevError(
			() => validateResponse(mutate((r) => { r.model = "" }), validRequest),
			"invalid_response",
			"model",
		);
		expectJevError(
			() =>
				validateResponse(
					mutate((r) => { r.usage = { input_tokens: -1, output_tokens: 1 } }),
					validRequest,
				),
			"invalid_response",
			"usage.input_tokens",
		);
	});

	test("rejects missing, mismatched, and null answers; warns on extra ids", () => {
		expectJevError(
			() =>
				validateResponse(
					mutate((r) => { delete (r.answers as Record<string, unknown>).score }),
					validRequest,
				),
			"invalid_response",
			"answers.score",
		);
		expectJevError(
			() =>
				validateResponse(
					mutate((r) => {
						r.answers.noul = {
							type: "choice",
							choice: "a",
							probabilities: { a: 1 },
							confidence: 1,
						} as never;
					}),
					validRequest,
				),
			"invalid_response",
			"answers.noul.type",
		);
		expectJevError(
			() =>
				validateResponse(
					mutate((r) => { r.answers.noul = null as never }),
					validRequest,
				),
			"invalid_response",
			"answers.noul",
		);

		const withExtra = mutate((r) => {
			(r.answers as Record<string, unknown>).ghost = { type: "noul", noul: 0.5 };
		});
		const result = validateResponse(withExtra, validRequest);
		expect(result.warnings.some((warning) => warning.includes("ghost"))).toBe(true);
	});

	test("validates noul, choice, and score answer values", () => {
		expectJevError(
			() => validateResponse(mutate((r) => { r.answers.noul.noul = Number.NaN }), validRequest),
			"invalid_response",
			"answers.noul.noul",
		);
		expectJevError(
			() => validateResponse(mutate((r) => { r.answers.noul.noul = 1.2 }), validRequest),
			"invalid_response",
			"answers.noul.noul",
		);
		expectJevError(
			() => validateResponse(mutate((r) => { (r.answers.noul as { confidence?: number }).confidence = 2 }), validRequest),
			"invalid_response",
			"answers.noul.confidence",
		);
		expectJevError(
			() => validateResponse(mutate((r) => { r.answers.choice.choice = "z" }), validRequest),
			"invalid_response",
			"answers.choice.choice",
		);
		expectJevError(
			() => validateResponse(mutate((r) => { r.answers.choice.probabilities = { a: 1 } as never }), validRequest),
			"invalid_response",
			"answers.choice.probabilities",
		);
		expectJevError(
			() => validateResponse(mutate((r) => { r.answers.choice.confidence = -0.1 }), validRequest),
			"invalid_response",
			"answers.choice.confidence",
		);
		expectJevError(
			() =>
				validateResponse(
					mutate((r) => { r.answers.score.legend = { "0": "low", "1": "mid" } as never }),
					validRequest,
				),
			"invalid_response",
			"answers.score.legend",
		);

		const edge = mutate((r) => { r.answers.score.score = 2 + 1e-9 });
		expect(validateResponse(edge, validRequest).answers.score).toBeDefined();
		const belowEdge = mutate((r) => { r.answers.score.score = -1e-9 });
		expect(validateResponse(belowEdge, validRequest).answers.score).toBeDefined();
		expectJevError(
			() => validateResponse(mutate((r) => { r.answers.score.score = 2.5 }), validRequest),
			"invalid_response",
			"answers.score.score",
		);
	});

	test("applies two-tier probability sum handling", () => {
		const ok = mutate((r) => { r.answers.choice.probabilities = { a: 0.6, b: 0.4 } });
		expect(validateResponse(ok, validRequest).warnings).toEqual([]);

		const warn = mutate((r) => { r.answers.choice.probabilities = { a: 0.6, b: 0.3 } });
		expect(
			validateResponse(warn, validRequest).warnings.some((warning) =>
				warning.includes("answers.choice.probabilities"),
			),
		).toBe(true);

		expectJevError(
			() => validateResponse(mutate((r) => { r.answers.choice.probabilities = { a: 0.2, b: 0.2 } }), validRequest),
			"invalid_response",
			"answers.choice.probabilities",
		);
		expectJevError(
			() => validateResponse(mutate((r) => { r.answers.choice.probabilities = { a: 0.8, b: 0.8 } }), validRequest),
			"invalid_response",
			"answers.choice.probabilities",
		);
	});
});

describe("jev runtime decide (Unit 3)", () => {
	test("returns a typed result and passes the validated body to the runner", async () => {
		const calls: JevProcessInput[] = [];
		const runtime = createJevRuntime({
			process: {
				async run(input) {
					calls.push(input);
					return { exitCode: 0, stdout: JSON.stringify(happyResponse()), stderr: "" };
				},
			},
		});

		const result = await runtime.decide(validRequest);

		expect(result.model).toBe("typesafe/jev");
		expect(result.answers.noul).toEqual({ type: "noul", noul: 0.8 });
		expect(calls).toHaveLength(1);
		expect(calls[0].args).toEqual(["-p", "-m", "typesafe/jev"]);
		expect(calls[0].stdin).toBe(
			JSON.stringify({ state: validRequest.state, questions: validRequest.questions }),
		);
		expect(calls[0].timeoutMs).toBe(30_000);
	});

	test("non-zero exit wins over garbage stdout and carries exit + reason", async () => {
		const runtime = createJevRuntime({
			process: {
				async run() {
					return { exitCode: 4, stdout: "garbage", stderr: "denied" };
				},
			},
		});

		const error = await expectJevErrorAsync(
			() => runtime.decide(validRequest),
			"nonzero_exit",
		);
		expect(error.exitCode).toBe(4);
		expect(error.reason).toBe("permission");
		expect(error.stderrExcerpt).toContain("denied");
	});

	test("maps documented exit codes to reasons", async () => {
		const cases: Array<[number, JevExitReason]> = [
			[1, "general"],
			[2, "general"],
			[3, "auth"],
			[5, "rate_limit"],
			[6, "network"],
			[7, "server"],
			[8, "max_turns"],
			[9, "no_response"],
			[10, "insufficient_credits"],
			[130, "interrupted"],
			[99, "general"],
			[137, "general"],
		];
		for (const [exitCode, reason] of cases) {
			const runtime = createJevRuntime({
				process: {
					async run() {
						return { exitCode, stdout: "", stderr: "" };
					},
				},
			});
			const error = await expectJevErrorAsync(
				() => runtime.decide(validRequest),
				"nonzero_exit",
			);
			expect(error.exitCode).toBe(exitCode);
			expect(error.reason).toBe(reason);
		}
	});

	test("pre-aborted signal rejects aborted without spawning", async () => {
		let spawned = false;
		const runtime = createJevRuntime({
			process: {
				async run() {
					spawned = true;
					return { exitCode: 0, stdout: "", stderr: "" };
				},
			},
		});
		const controller = new AbortController();
		controller.abort();

		await expectJevErrorAsync(
			() => runtime.decide(validRequest, { signal: controller.signal }),
			"aborted",
		);
		expect(spawned).toBe(false);
	});

	test("propagates runner error codes and rejects malformed output", async () => {
		for (const code of [
			"aborted",
			"missing_executable",
			"spawn_failed",
			"timeout",
		] as const) {
			const runtime = createJevRuntime({
				process: {
					async run() {
						throw new JevRuntimeError({ code, message: code });
					},
				},
			});
			await expectJevErrorAsync(() => runtime.decide(validRequest), code);
		}

		const malformed = createJevRuntime({
			process: {
				async run() {
					return { exitCode: 0, stdout: "no json", stderr: "" };
				},
			},
		});
		await expectJevErrorAsync(
			() => malformed.decide(validRequest),
			"malformed_output",
		);
	});

	test("rejects win32 before spawning", async () => {
		let spawned = false;
		const runtime = createJevRuntime({
			platform: "win32",
			process: {
				async run() {
					spawned = true;
					return { exitCode: 0, stdout: "", stderr: "" };
				},
			},
		});

		await expectJevErrorAsync(
			() => runtime.decide(validRequest),
			"unsupported_platform",
		);
		expect(spawned).toBe(false);
	});

	test("resolves command, cwd, and timeout precedence", async () => {
		const calls: JevProcessInput[] = [];
		const runtime = createJevRuntime({
			command: "mycmd",
			timeoutMs: 5000,
			cwd: "/runtime",
			repoRoot: "/repo",
			process: {
				async run(input) {
					calls.push(input);
					return { exitCode: 0, stdout: JSON.stringify(happyResponse()), stderr: "" };
				},
			},
		});

		await runtime.decide(validRequest, { cwd: "/call", timeoutMs: 1000 });
		expect(calls[0].command).toBe("mycmd");
		expect(calls[0].cwd).toBe("/call");
		expect(calls[0].timeoutMs).toBe(1000);

		await runtime.decide(validRequest);
		expect(calls[1].cwd).toBe("/runtime");
		expect(calls[1].timeoutMs).toBe(5000);
	});

	test("emits exactly one telemetry event with decisions + sizes, never state", async () => {
		const events: JevTelemetryEvent[] = [];
		const sentinel = "TELEMETRY_SENTINEL";
		let tick = 0;
		const runtime = createJevRuntime({
			now: () => (tick += 5),
			telemetry: (event) => events.push(event),
			process: {
				async run() {
					return { exitCode: 0, stdout: JSON.stringify(happyResponse()), stderr: "" };
				},
			},
		});
		const request: JevRequest = {
			state: { secret: sentinel },
			questions: validRequest.questions,
		};

		await runtime.decide(request);

		expect(events).toHaveLength(1);
		const event = events[0];
		expect(event.outcome).toBe("success");
		expect(event.durationMs).toBe(5);
		expect(event.model).toBe("typesafe/jev");
		expect(event.decisions?.noul).toEqual({ noul: 0.8 });
		expect(event.stateBytes).toBeGreaterThan(0);
		expect(event.requestBytes).toBeGreaterThan(0);
		expect(event.stdoutBytes).toBeGreaterThan(0);
		expect(event.stderrBytes).toBe(0);
		const serialized = JSON.stringify(event);
		expect(serialized).not.toContain(sentinel);
		expect(serialized).not.toContain("instructions");
	});

	test("a throwing telemetry sink never breaks decide and is called once", async () => {
		let calls = 0;
		const runtime = createJevRuntime({
			telemetry: () => {
				calls += 1;
				throw new Error("sink boom");
			},
			process: {
				async run() {
					return { exitCode: 0, stdout: JSON.stringify(happyResponse()), stderr: "" };
				},
			},
		});

		const result = await runtime.decide(validRequest);

		expect(result.model).toBe("typesafe/jev");
		expect(calls).toBe(1);
	});

	test("redactIds hashes telemetry question ids", async () => {
		const events: JevTelemetryEvent[] = [];
		const runtime = createJevRuntime({
			redactIds: true,
			telemetry: (event) => events.push(event),
			process: {
				async run() {
					return { exitCode: 0, stdout: JSON.stringify(happyResponse()), stderr: "" };
				},
			},
		});

		await runtime.decide(validRequest);

		expect(events[0].questionIds).not.toContain("noul");
		expect(events[0].questionIds.every((id) => /^[0-9a-f]+$/.test(id))).toBe(true);
	});

	test("invalid request fails before spawning", async () => {
		let spawned = false;
		const runtime = createJevRuntime({
			process: {
				async run() {
					spawned = true;
					return { exitCode: 0, stdout: "", stderr: "" };
				},
			},
		});

		await expectJevErrorAsync(
			() => runtime.decide({ state: "s", questions: {} }),
			"invalid_request",
			"questions",
		);
		expect(spawned).toBe(false);
	});
});
function responseFor(model: string) {
	return mutate((r) => {
		r.model = model;
	});
}

function fakeOutput(overrides: {
	exitCode?: number;
	stdout?: string;
	stderr?: string;
	truncated?: boolean;
} = {}) {
	return {
		exitCode: 0,
		stdout: JSON.stringify(happyResponse()),
		stderr: "",
		...overrides,
	};
}

describe("jev fake runtime (Unit 5)", () => {
	test("FIFO queue returns responses in invocation order", async () => {
		const runtime = createFakeJevRuntime({
			queue: [
				{ exitCode: 0, stdout: JSON.stringify(responseFor("first")), stderr: "" },
				{ exitCode: 0, stdout: JSON.stringify(responseFor("second")), stderr: "" },
			],
		});

		const first = await runtime.decide(validRequest);
		const second = await runtime.decide(validRequest);

		expect(first.model).toBe("first");
		expect(second.model).toBe("second");
	});

	test("handler form returns a queued output", async () => {
		const runtime = createFakeJevRuntime({
			handler: () => ({
				exitCode: 0,
				stdout: JSON.stringify(responseFor("handled")),
				stderr: "",
			}),
		});

		expect((await runtime.decide(validRequest)).model).toBe("handled");
	});

	test("handler errors travel the same normalization path", async () => {
		const generic = createFakeJevRuntime({ handler: () => new Error("boom") });
		const wrapped = await expectJevErrorAsync(
			() => generic.decide(validRequest),
			"spawn_failed",
		);
		expect(wrapped.cause).toBeInstanceOf(Error);

		const typed = createFakeJevRuntime({
			handler: () =>
				new JevRuntimeError({ code: "missing_executable", message: "nope" }),
		});
		await expectJevErrorAsync(
			() => typed.decide(validRequest),
			"missing_executable",
		);
	});

	test("records exact stdin and the request", async () => {
		const runtime = createFakeJevRuntime({ queue: [fakeOutput()] });

		await runtime.decide(validRequest);

		expect(runtime.calls).toHaveLength(1);
		expect(runtime.calls[0].stdin).toBe(
			JSON.stringify({ state: validRequest.state, questions: validRequest.questions }),
		);
		expect(runtime.requests).toEqual([validRequest]);
	});

	test("is deterministic: identical repeated calls and injected now", async () => {
		let tick = 0;
		const events: JevTelemetryEvent[] = [];
		const runtime = createFakeJevRuntime({
			handler: () => fakeOutput(),
			now: () => (tick += 1),
			telemetry: (event) => events.push(event),
		});

		const first = await runtime.decide(validRequest);
		const second = await runtime.decide(validRequest);

		expect(first).toEqual(second);
		expect(events[0].durationMs).toBe(1);
		expect(events[1].durationMs).toBe(1);
	});

	test("concurrent decides receive distinct queued responses", async () => {
		const runtime = createFakeJevRuntime({
			queue: [
				{ exitCode: 0, stdout: JSON.stringify(responseFor("first")), stderr: "" },
				{ exitCode: 0, stdout: JSON.stringify(responseFor("second")), stderr: "" },
			],
		});

		const [first, second] = await Promise.all([
			runtime.decide(validRequest),
			runtime.decide(validRequest),
		]);

		expect(first.model).toBe("first");
		expect(second.model).toBe("second");
	});

	test("simulates ENOENT, non-zero exit, malformed, truncation, and timeout", async () => {
		const enoent = createFakeJevRuntime({
			handler: () =>
				new JevRuntimeError({ code: "missing_executable", message: "nope" }),
		});
		await expectJevErrorAsync(
			() => enoent.decide(validRequest),
			"missing_executable",
		);

		const nonzero = createFakeJevRuntime({
			queue: [{ exitCode: 1, stdout: "", stderr: "" }],
		});
		await expectJevErrorAsync(
			() => nonzero.decide(validRequest),
			"nonzero_exit",
		);

		const malformed = createFakeJevRuntime({
			queue: [{ exitCode: 0, stdout: "nope", stderr: "" }],
		});
		await expectJevErrorAsync(
			() => malformed.decide(validRequest),
			"malformed_output",
		);

		const truncated = createFakeJevRuntime({
			queue: [{ exitCode: 0, stdout: "{}", stderr: "", truncated: true }],
		});
		await expectJevErrorAsync(
			() => truncated.decide(validRequest),
			"malformed_output",
		);

		const timeout = createFakeJevRuntime({
			handler: () => new JevRuntimeError({ code: "timeout", message: "slow" }),
		});
		await expectJevErrorAsync(() => timeout.decide(validRequest), "timeout");
	});

	test("reset clears recordings and restores the queue", async () => {
		const runtime = createFakeJevRuntime({
			queue: [fakeOutput(), fakeOutput()],
		});

		await runtime.decide(validRequest);
		expect(runtime.calls).toHaveLength(1);

		runtime.reset();
		expect(runtime.calls).toHaveLength(0);
		expect(runtime.requests).toHaveLength(0);
		expect((await runtime.decide(validRequest)).model).toBe("typesafe/jev");
	});
});
const jevDir = path.resolve(import.meta.dir, "..", "extensions", "ce-core", "jev");

describe("jev barrel + isolation (Unit 6)", () => {
	test("exports exactly the R1 value surface", () => {
		expect(Object.keys(barrel).sort()).toEqual(
			[
				"JevRuntimeError",
				"createFakeJevRuntime",
				"createJevProcess",
				"createJevRuntime",
			].sort(),
		);
	});

	test("keeps jev imports to Node built-ins, typebox, and local modules", () => {
		const files = readdirSync(jevDir).filter((file) => file.endsWith(".ts"));
		expect(files.length).toBeGreaterThan(0);

		const violations: string[] = [];
		for (const file of files) {
			const source = readFileSync(path.join(jevDir, file), "utf8");
			for (const match of source.matchAll(/from\s+"([^"]+)"/g)) {
				const specifier = match[1];
				const allowed =
					specifier.startsWith(".") ||
					specifier.startsWith("node:") ||
					specifier === "typebox" ||
					specifier.startsWith("typebox/");
				if (!allowed) violations.push(`${file}: ${specifier}`);
			}
		}
		expect(violations).toEqual([]);
	});

	test("wires jev into the extension entrypoint through the triage runner", () => {
		const entry = readFileSync(
			path.resolve(import.meta.dir, "..", "extensions", "ce-core", "index.ts"),
			"utf8",
		);
		// Wiring jev into a real feature is the point of this change; the barrel
		// is no longer inert.
		expect(entry).toContain("./jev/index");
		expect(entry).toContain("failure-triage-runner");
	});

	test.skipIf(!process.env.JEV_LIVE)(
		"live: records a real CommandCode sample",
		async () => {
			let rawStdout = "";
			const real = createJevProcess();
			const runtime = createJevRuntime({
				process: {
					async run(input) {
						const output = await real.run(input);
						rawStdout = output.stdout;
						return output;
					},
				},
			});
			const request: JevRequest = {
				state: "stage: 03-work",
				questions: {
					noul: { type: "noul", instructions: "Is this risky?" },
					choice: {
						type: "choice",
						instructions: "Pick one",
						criteria: { a: "A", b: "B" },
					},
					score: {
						type: "score",
						instructions: "Rate it",
						criteria: ["low", "mid", "high"],
					},
				},
			};

			const result = await runtime.decide(request);

			expect(result.model).toBeString();
			expect(result.answers.noul.type).toBe("noul");
			expect(result.answers.choice.type).toBe("choice");
			expect(result.answers.score.type).toBe("score");

			const samplePath = path.resolve(
				import.meta.dir,
				"..",
				".context",
				"compound-engineering",
				"jev-live-sample.json",
			);
			mkdirSync(path.dirname(samplePath), { recursive: true });
			writeFileSync(samplePath, rawStdout, "utf8");
		},
		60_000,
	);
});
