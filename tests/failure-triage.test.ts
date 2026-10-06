import { describe, expect, test } from "bun:test";
import {
	classifyVerificationCommand,
	type VerificationCategory,
} from "../extensions/ce-core/tools/bash-output-filter";
import {
	shouldTriage,
	extractExitCode,
	boundFailureExcerpt,
	buildTriageRequest,
	parseTriageAnswers,
	heuristicClassify,
	formatTriageBlock,
	applyTriageToContent,
	MAX_EXCERPT_BYTES,
	MAX_EXCERPT_LINES,
	MAX_INLINE_CHARS,
	type TriageRecord,
} from "../extensions/ce-core/tools/failure-triage";
import { validateRequest } from "../extensions/ce-core/jev/validate";
import type { JevResult } from "../extensions/ce-core/jev/types";

describe("failure-triage: verification command classifier", () => {
	test.each([
		["bun test", "test"],
		["bun run test", "test"],
		["npm test", "test"],
		["vitest", "test"],
		["jest", "test"],
		["pytest", "test"],
		["cargo test", "test"],
		["go test", "test"],
		["bun run test:unit", "test"],
		["npm run test:ci", "test"],
	] as Array<[string, VerificationCategory]>)(
		"classifies test command %s",
		(command, expected) => {
			expect(classifyVerificationCommand(command)).toBe(expected);
		},
	);

	test.each([
		["tsc", "typecheck"],
		["tsc --noEmit", "typecheck"],
		["bun run typecheck", "typecheck"],
		["vue-tsc", "typecheck"],
	] as Array<[string, VerificationCategory]>)(
		"classifies typecheck command %s",
		(command, expected) => {
			expect(classifyVerificationCommand(command)).toBe(expected);
		},
	);

	test.each([
		["eslint .", "lint"],
		["biome lint", "lint"],
		["ruff check", "lint"],
		["oxlint", "lint"],
		["bun run lint", "lint"],
	] as Array<[string, VerificationCategory]>)(
		"classifies lint command %s",
		(command, expected) => {
			expect(classifyVerificationCommand(command)).toBe(expected);
		},
	);

	test.each([
		["vite build", "build"],
		["bun run build", "build"],
		["cargo build", "build"],
		["go build", "build"],
		["make", "build"],
	] as Array<[string, VerificationCategory]>)(
		"classifies build command %s",
		(command, expected) => {
			expect(classifyVerificationCommand(command)).toBe(expected);
		},
	);

	test("classifies the primary command of a piped command", () => {
		expect(classifyVerificationCommand("bun test 2>&1 | tail -50")).toBe("test");
	});

	test.each(["grep -r fail src", "ls -la", "curl https://x", "git diff"])(
		"returns null for non-verification command %s",
		(command) => {
			expect(classifyVerificationCommand(command)).toBeNull();
		},
	);

	test("returns null for a runner script without a verification keyword", () => {
		expect(classifyVerificationCommand("bun run dev")).toBeNull();
	});
});

describe("failure-triage: trigger gate", () => {
	test("fires for a failing verification command in 03-work", () => {
		expect(
			shouldTriage({
				toolName: "bash",
				isError: true,
				command: "bun test",
				stage: "03-work",
			}),
		).toBe(true);
	});

	test("fires for a failing verification command in 04-5-debug", () => {
		expect(
			shouldTriage({
				toolName: "bash",
				isError: true,
				command: "tsc --noEmit",
				stage: "04-5-debug",
			}),
		).toBe(true);
	});

	test("does not fire for a non-bash tool", () => {
		expect(
			shouldTriage({
				toolName: "read",
				isError: true,
				command: "bun test",
				stage: "03-work",
			}),
		).toBe(false);
	});

	test("does not fire when the command succeeded", () => {
		expect(
			shouldTriage({
				toolName: "bash",
				isError: false,
				command: "bun test",
				stage: "03-work",
			}),
		).toBe(false);
	});

	test("does not fire for a non-verification command", () => {
		expect(
			shouldTriage({
				toolName: "bash",
				isError: true,
				command: "git diff",
				stage: "03-work",
			}),
		).toBe(false);
	});

	test.each(["02-plan", "04-review", null])(
		"does not fire in an out-of-scope stage %s",
		(stage) => {
			expect(
				shouldTriage({
					toolName: "bash",
					isError: true,
					command: "bun test",
					stage,
				}),
			).toBe(false);
		},
	);
});

describe("failure-triage: exit code extraction", () => {
	test("parses the exit code from the pi error suffix", () => {
		expect(extractExitCode("boom\nCommand exited with code 2\n")).toBe(2);
	});

	test("defaults to 1 when no exit code is present", () => {
		expect(extractExitCode("boom without a suffix")).toBe(1);
	});
});

describe("failure-triage: excerpt bounding", () => {
	test("returns a short excerpt unchanged", () => {
		const result = boundFailureExcerpt("short output");
		expect(result.excerpt).toBe("short output");
		expect(result.truncated).toBe(false);
		expect(result.bytes).toBe(Buffer.byteLength("short output", "utf-8"));
	});

	test("caps a huge excerpt and keeps a signal line at the tail", () => {
		const filler = Array.from(
			{ length: 4999 },
			(_, index) => `log line ${index} ${'x'.repeat(30)}`,
		);
		const output = [...filler, "FAIL test/foo.test.ts"].join("\n");
		expect(Buffer.byteLength(output, "utf-8")).toBeGreaterThan(200_000);

		const result = boundFailureExcerpt(output);

		expect(Buffer.byteLength(result.excerpt, "utf-8")).toBeLessThanOrEqual(
			MAX_EXCERPT_BYTES,
		);
		expect(result.excerpt.split("\n").length).toBeLessThanOrEqual(
			MAX_EXCERPT_LINES,
		);
		expect(result.truncated).toBe(true);
		expect(result.excerpt).toContain("FAIL test/foo.test.ts");
	});
});

describe("failure-triage: Jev request building", () => {
	const requestInput = {
		command: "bun test",
		exitCode: 1,
		stage: "03-work",
		excerpt: "FAIL test/foo.test.ts",
		recentChange: { files: ["src/foo.ts"], summary: "src/foo.ts" },
	};

	test("builds a request that passes validateRequest", () => {
		expect(() => validateRequest(buildTriageRequest(requestInput))).not.toThrow();
	});

	test("keeps the excerpt within the byte cap", () => {
		const request = buildTriageRequest({
			...requestInput,
			excerpt: "y".repeat(MAX_EXCERPT_BYTES + 100),
		});
		const state = request.state as { excerpt: string };
		expect(Buffer.byteLength(state.excerpt, "utf-8")).toBeLessThanOrEqual(
			MAX_EXCERPT_BYTES,
		);
	});

	test("uses exactly 7 category criteria and 6 clarity levels", () => {
		const request = buildTriageRequest(requestInput);
		const category = request.questions.category;
		const clarity = request.questions.root_cause_clarity;
		expect(category.type).toBe("choice");
		expect(Object.keys((category as { criteria: object }).criteria).length).toBe(7);
		expect(clarity.type).toBe("score");
		expect((clarity as { criteria: string[] }).criteria.length).toBe(6);
	});

	test("supports a null recentChange", () => {
		const request = buildTriageRequest({ ...requestInput, recentChange: null });
		expect((request.state as { recentChange: unknown }).recentChange).toBeNull();
	});
});

describe("failure-triage: answer parsing", () => {
	function fakeResult(overrides: Partial<Record<string, unknown>> = {}): JevResult {
		return {
			model: "typesafe/jev",
			warnings: [],
			answers: {
				category: {
					type: "choice",
					choice: "test_fixture",
					probabilities: { test_fixture: 0.7, unknown: 0.3 },
					confidence: 0.72,
				},
				related_to_recent_change: { type: "noul", noul: 1 },
				root_cause_clarity: {
					type: "score",
					score: 2,
					legend: { "0": "", "1": "", "2": "", "3": "", "4": "", "5": "" },
					probabilities: {
						"0": 0.1,
						"1": 0.1,
						"2": 0.6,
						"3": 0.1,
						"4": 0.05,
						"5": 0.05,
					},
					confidence: 0.6,
				},
				...overrides,
			},
		} as JevResult;
	}

	test("parses a valid result into a triage record", () => {
		const parsed = parseTriageAnswers(fakeResult(), { hasRecentChange: true });
		expect(parsed.ok).toBe(true);
		if (parsed.ok) {
			expect(parsed.triage).toEqual({
				category: "test_fixture",
				confidence: 0.72,
				relatedToRecentChange: true,
				rootCauseClarity: 2,
				source: "jev",
			});
		}
	});

	test("fails when the category answer is missing", () => {
		const parsed = parseTriageAnswers(fakeResult({ category: undefined }), {
			hasRecentChange: true,
		});
		expect(parsed.ok).toBe(false);
	});

	test("fails when the category label is unknown", () => {
		const parsed = parseTriageAnswers(
			fakeResult({
				category: {
					type: "choice",
					choice: "not_a_category",
					probabilities: { not_a_category: 1 },
					confidence: 0.9,
				},
			}),
			{ hasRecentChange: true },
		);
		expect(parsed.ok).toBe(false);
	});

	test("maps noul=0 without a recent change to unknown", () => {
		const parsed = parseTriageAnswers(
			fakeResult({ related_to_recent_change: { type: "noul", noul: 0 } }),
			{ hasRecentChange: false },
		);
		expect(parsed.ok).toBe(true);
		if (parsed.ok) {
			expect(parsed.triage.relatedToRecentChange).toBe("unknown");
		}
	});
});

describe("failure-triage: heuristic classifier", () => {
	test("classifies a missing module failure", () => {
		const result = heuristicClassify("Cannot find module './x'");
		expect(
			result?.category === "dependency_config" ||
				result?.category === "environment_toolchain",
		).toBe(true);
		expect(result?.confidence).toBe(0.3);
	});

	test("classifies an assertion mismatch", () => {
		const result = heuristicClassify("expected 1 received 2");
		expect(
			result?.category === "test_fixture" ||
				result?.category === "implementation_bug",
		).toBe(true);
	});

	test("abstains on opaque output", () => {
		expect(heuristicClassify("something went sideways quietly")).toBeNull();
	});
});

describe("failure-triage: formatting and application", () => {
	const record: TriageRecord = {
		category: "test_fixture",
		confidence: 0.72,
		relatedToRecentChange: true,
		rootCauseClarity: 2,
		source: "jev",
	};

	test("formats a block within the inline character cap", () => {
		const block = formatTriageBlock(record);
		expect(block.length).toBeLessThanOrEqual(MAX_INLINE_CHARS);
		expect(block).toContain("source=jev");
		expect(block).toContain("test_fixture");
		expect(block).toContain("0.72");
	});

	test("appends the block without touching the original content", () => {
		const original = "raw failure output";
		const block = formatTriageBlock(record);
		const applied = applyTriageToContent(original, block);
		expect(applied.startsWith(original)).toBe(true);
		expect(applied).toContain(block);
	});
});
