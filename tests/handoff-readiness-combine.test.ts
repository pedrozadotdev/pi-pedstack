// Handoff readiness — canonical state hashing and frozen constants (plan Unit 1).
import { describe, expect, test } from "bun:test";
import {
	ARRAY_ITEM_BYTES,
	BLOCKING,
	CURRENT_TASK_BYTES,
	HANDOFF_MARKDOWN_BYTES,
	HISTORY_NEED_STRONG,
	MAX_REQUEST_BODY_BYTES,
	MIN_CONFIDENCE,
	MIN_DIMENSION,
	READINESS_JEV_TIMEOUT_MS,
	READINESS_QUESTION_IDS,
	THRESHOLDS_VERSION,
	TRUNCATION_MARKER,
	buildReadinessRequest,
	canonicalizeState,
	deriveOutcome,
	enforceRequestBodyLimit,
	hashCanonical,
	isBarePedNext,
	isPlaceholderValue,
	normalizeState,
	prepass,
	readAnswers,
} from "../extensions/ce-core/handoff-readiness/combine.js";
import { validateRequest } from "../extensions/ce-core/jev/validate.js";
import type { JevResult } from "../extensions/ce-core/jev/types.js";
import type {
	ReadinessCorrection,
	ReadinessDimension,
	ReadinessDimensionId,
	ReadinessState,
} from "../extensions/ce-core/handoff-readiness/types.js";

function dim(
	id: ReadinessDimensionId,
	value: number,
	over: Partial<ReadinessDimension> = {},
): ReadinessDimension {
	return { id, value, confidence: 1, forced: false, ...over };
}

function noul(value: number, confidence?: number) {
	return confidence === undefined
		? { type: "noul" as const, noul: value }
		: { type: "noul" as const, noul: value, confidence };
}

function jevResult(answers: Record<string, unknown>): JevResult {
	return { answers: answers as never, model: "typesafe/jev", warnings: [] };
}

function fullAnswers(over: Record<string, unknown> = {}): Record<string, unknown> {
	const answers: Record<string, unknown> = {};
	for (const id of READINESS_QUESTION_IDS) answers[id] = noul(1, 0.9);
	return { ...answers, ...over };
}

/** UTF-8 byte length without relying on Node's `Buffer`. */
function byteLength(text: string): number {
	let bytes = 0;
	for (const char of text) {
		const code = char.codePointAt(0) ?? 0;
		bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
	}
	return bytes;
}

function baseState(over: Partial<ReadinessState> = {}): ReadinessState {
	return {
		currentStage: "02-plan",
		nextStage: "03-work",
		handoffMarkdown:
			"## Current Task\nContinue from 02-plan to 03-work.\n",
		currentTask: "Continue from 02-plan to 03-work.",
		nextMinimalStep:
			"Implement Unit 1 in extensions/ce-core/handoff-readiness/combine.ts",
		verification: "bun test tests/handoff-readiness-combine.test.ts: 10 pass",
		blocker: "",
		openDecisions: [],
		currentTruth: ["Plan is frozen."],
		invalidatedAssumptions: [],
		activeFiles: ["extensions/ce-core/handoff-readiness/combine.ts"],
		recentlyAccessedFiles: ["extensions/ce-core/handoff-readiness/combine.ts"],
		artifacts: {
			plan: "docs/plans/2026-10-06-semantic-handoff-readiness-validation.md",
		},
		activeRules: ["TDD: RED then GREEN."],
		...over,
	};
}

describe("Unit 1 — frozen constants", () => {
	test("exports the documented literal constants", () => {
		expect(THRESHOLDS_VERSION).toBe(1);
		expect(MIN_DIMENSION).toBe(0.5);
		expect(HISTORY_NEED_STRONG).toBe(0.6);
		expect(BLOCKING).toBe(0.5);
		expect(MIN_CONFIDENCE).toBe(0.5);
		expect(MAX_REQUEST_BODY_BYTES).toBe(65_536);
		expect(HANDOFF_MARKDOWN_BYTES).toBe(32_768);
		expect(CURRENT_TASK_BYTES).toBe(2_048);
		expect(ARRAY_ITEM_BYTES).toBe(1_024);
		expect(READINESS_JEV_TIMEOUT_MS).toBe(8_000);
		expect(TRUNCATION_MARKER).toBe("…[truncated]");
		expect([...READINESS_QUESTION_IDS]).toEqual([
			"continuation_sufficiency",
			"next_step_clarity",
			"verification_support",
			"blocking_open_decisions",
			"history_need",
		]);
	});
});

describe("Unit 1 — normalization and canonical hashing", () => {
	test("the same logical state hashes identically twice", () => {
		const a = hashCanonical(canonicalizeState(normalizeState(baseState())));
		const b = hashCanonical(canonicalizeState(normalizeState(baseState())));
		expect(a).toBe(b);
	});

	test("trims whitespace and normalizes CRLF to LF", () => {
		const clean = normalizeState(baseState());
		const messy = normalizeState(
			baseState({
				currentStage: "  02-plan  ",
				handoffMarkdown: "## Current Task\r\nContinue from 02-plan to 03-work.\r\n",
			}),
		);
		expect(messy.currentStage).toBe("02-plan");
		expect(messy.handoffMarkdown).not.toContain("\r");
		expect(hashCanonical(canonicalizeState(messy))).toBe(
			hashCanonical(canonicalizeState(clean)),
		);
	});

	test("collapses placeholder arrays to [] and preserves a real value", () => {
		const normalized = normalizeState(
			baseState({
				currentTruth: ["N/A"],
				invalidatedAssumptions: ["", "-", "not run"],
				activeRules: ["TDD: RED then GREEN."],
			}),
		);
		expect(normalized.currentTruth).toEqual([]);
		expect(normalized.invalidatedAssumptions).toEqual([]);
		expect(normalized.activeRules).toEqual(["TDD: RED then GREEN."]);
	});

	test("sorts object keys but preserves array input order", () => {
		const sorted = normalizeState(
			baseState({ artifacts: { a: "1", b: "2" } }),
		);
		const reversed = normalizeState(
			baseState({ artifacts: { b: "2", a: "1" } }),
		);
		expect(hashCanonical(canonicalizeState(sorted))).toBe(
			hashCanonical(canonicalizeState(reversed)),
		);

		const ordered = normalizeState(baseState({ currentTruth: ["one", "two"] }));
		const reordered = normalizeState(baseState({ currentTruth: ["two", "one"] }));
		expect(hashCanonical(canonicalizeState(ordered))).not.toBe(
			hashCanonical(canonicalizeState(reordered)),
		);
	});

	test("removes artifacts whose value is undefined, empty, or a placeholder", () => {
		const normalized = normalizeState(
			baseState({
				artifacts: {
					missing: undefined as unknown as string,
					empty: "",
					placeholder: "N/A",
					real: "docs/plans/plan.md",
				},
			}),
		);
		expect(normalized.artifacts).toEqual({ real: "docs/plans/plan.md" });
	});

	test("changing any single field changes the hash", () => {
		const baseHash = hashCanonical(
			canonicalizeState(normalizeState(baseState())),
		);
		const variants: Array<Partial<ReadinessState>> = [
			{ currentStage: "03-work" },
			{ nextStage: "04-review" },
			{ currentTask: "Something else." },
			{ nextMinimalStep: "Do a different thing." },
			{ verification: "bun test: 1 pass" },
			{ blocker: "Waiting on review." },
			{ openDecisions: ["Pick a hash strategy."] },
			{ currentTruth: ["Plan is frozen.", "One more truth."] },
			{ invalidatedAssumptions: ["Assumed X was safe."] },
			{ activeFiles: ["docs/plans/plan.md"] },
			{ recentlyAccessedFiles: ["docs/plans/plan.md"] },
			{ artifacts: { plan: "docs/plans/other.md" } },
			{ activeRules: ["A new rule."] },
		];
		for (const variant of variants) {
			const hash = hashCanonical(
				canonicalizeState(normalizeState(baseState(variant))),
			);
			expect({ variant, changed: hash !== baseHash }).toEqual({
				variant,
				changed: true,
			});
		}
	});

	test("a timestamped custom markdown changes the hash even with equal fields", () => {
		const a = normalizeState(
			baseState({ handoffMarkdown: "## Current Task\nSaved at 10:00.\n" }),
		);
		const b = normalizeState(
			baseState({ handoffMarkdown: "## Current Task\nSaved at 10:01.\n" }),
		);
		expect(hashCanonical(canonicalizeState(a))).not.toBe(
			hashCanonical(canonicalizeState(b)),
		);
	});

	test("hashes a fixed canonical state to a stable 16-hex literal", () => {
		const state = normalizeState(baseState({ openDecisions: [] }));
		expect(hashCanonical(canonicalizeState(state))).toMatch(/^[0-9a-f]{16}$/);
	});
});

describe("Unit 1 — placeholder predicate", () => {
	test("recognizes empty and placeholder-like values", () => {
		for (const value of ["", "  ", "-", "N/A", "n/a", "none", "not run", "TODO"]) {
			expect({ value, placeholder: isPlaceholderValue(value) }).toEqual({
				value,
				placeholder: true,
			});
		}
		expect(isPlaceholderValue("bun test: 10 pass")).toBe(false);
		expect(isPlaceholderValue("Implement Unit 1")).toBe(false);
	});
});

describe("Unit 2 — deterministic pre-pass", () => {
	test("forces a passing blocking decision when openDecisions is empty", () => {
		const { forced } = prepass(baseState({ openDecisions: [] }), []);
		expect(forced).toContainEqual(
			dim("blocking_open_decisions", 0, { forced: true }),
		);
	});

		test("forces verification_support insufficient for empty or placeholder values", () => {
		for (const verification of ["", "N/A", "not run"]) {
			const { forced } = prepass(baseState({ verification }), []);
			expect(forced).toContainEqual(
				dim("verification_support", 0, { forced: true }),
			);
		}
	});

	test("forces next_step_clarity insufficient for empty, placeholder, or bare /ped-next", () => {
		for (const nextMinimalStep of ["", "N/A", "/ped-next"]) {
			const { forced } = prepass(baseState({ nextMinimalStep }), []);
			expect(forced).toContainEqual(
				dim("next_step_clarity", 0, { forced: true }),
			);
		}
	});

	test("forces continuation_sufficiency insufficient when an active file is missing", () => {
		const { forced } = prepass(baseState(), ["src/gone.ts"]);
		expect(forced).toContainEqual(
			dim("continuation_sufficiency", 0, { forced: true }),
		);
		const outcome = deriveOutcome(forced, { missingFiles: ["src/gone.ts"] });
		expect(outcome.verdict).toBe("improve_handoff");
		expect(outcome.corrections).toContainEqual({
			dimension: "continuation_sufficiency",
			message: expect.stringContaining("no longer exists"),
		});
		expect(outcome.corrections[0].message).toContain("src/gone.ts");
	});

	test("skips Jev when a forced dimension is already insufficient", () => {
		const skipped = prepass(baseState({ nextMinimalStep: "/ped-next" }), []);
		expect(skipped.forcesNonContinue).toBe(true);
	});

	test("a forced pass never skips Jev", () => {
		const { forced, forcesNonContinue } = prepass(
			baseState({ openDecisions: [] }),
			[],
		);
		expect(forced).toHaveLength(1);
		expect(forcesNonContinue).toBe(false);
	});
});

describe("Unit 2 — verdict derivation", () => {
	test("history_need at/above the strong threshold preserves the session", () => {
		const outcome = deriveOutcome([
			dim("history_need", 0.6),
			dim("continuation_sufficiency", 1),
		]);
		expect(outcome.verdict).toBe("preserve_current_session");
		expect(outcome.corrections).toEqual([]);
		expect(outcome.reason).toBeString();
	});

	test("a below-threshold dimension yields improve_handoff with only the failures", () => {
		const outcome = deriveOutcome([
			dim("continuation_sufficiency", 0.5),
			dim("next_step_clarity", 0.4),
			dim("verification_support", 1),
			dim("blocking_open_decisions", 0),
			dim("history_need", 0),
		]);
		expect(outcome.verdict).toBe("improve_handoff");
		expect(outcome.corrections.map((c: ReadinessCorrection) => c.dimension)).toEqual([
			"next_step_clarity",
		]);
		expect(outcome.corrections[0].message).toContain("Next Minimal Step");
	});

	test("a blocking open decision maps to a correction naming the next stage", () => {
		const outcome = deriveOutcome(
			[
				dim("continuation_sufficiency", 1),
				dim("next_step_clarity", 1),
				dim("verification_support", 1),
				dim("blocking_open_decisions", 0.5),
				dim("history_need", 0),
			],
			{ nextStage: "03-work" },
		);
		expect(outcome.verdict).toBe("improve_handoff");
		expect(outcome.corrections.map((c: ReadinessCorrection) => c.dimension)).toEqual([
			"blocking_open_decisions",
		]);
		expect(outcome.corrections[0].message).toContain("03-work");
	});

	test("all-pass yields continue with no corrections", () => {
		const outcome = deriveOutcome([
			dim("continuation_sufficiency", 1),
			dim("next_step_clarity", 1),
			dim("verification_support", 1),
			dim("blocking_open_decisions", 0),
			dim("history_need", 0),
		]);
		expect(outcome).toMatchObject({ verdict: "continue", corrections: [] });
		expect(outcome.dimensions).toHaveLength(5);
	});

	test("preserve_current_session wins over a below-threshold dimension", () => {
		const outcome = deriveOutcome([
			dim("next_step_clarity", 0.1),
			dim("history_need", 0.9),
		]);
		expect(outcome.verdict).toBe("preserve_current_session");
		expect(outcome.corrections).toEqual([]);
		expect(outcome.reason).toBeString();
	});

	test("a skip-path outcome with a forced failure is improve_handoff, not preserve", () => {
		const { forced } = prepass(baseState({ nextMinimalStep: "/ped-next" }), []);
		const outcome = deriveOutcome(forced);
		expect(outcome.verdict).toBe("improve_handoff");
		expect(outcome.source).toBe("deterministic");
	});
});

describe("Unit 2 — isBarePedNext", () => {
	test("matches only a bare /ped-next (with optional list marker)", () => {
		expect(isBarePedNext("/ped-next")).toBe(true);
		expect(isBarePedNext("- /ped-next")).toBe(true);
		expect(isBarePedNext("Run /ped-next then check output")).toBe(false);
		expect(isBarePedNext("Implement Unit 2")).toBe(false);
	});
});

describe("Unit 3 — request building", () => {
	test("asks exactly the five frozen noul questions with the frozen copy", () => {
		const request = buildReadinessRequest(baseState());
		expect(Object.keys(request.questions)).toEqual([...READINESS_QUESTION_IDS]);
		for (const id of READINESS_QUESTION_IDS) {
			const question = request.questions[id];
			expect(question.type).toBe("noul");
			if (question.type === "noul") {
				expect(question.instructions).toBeString();
				expect(question.criteria?.true).toBeString();
				expect(question.criteria?.false).toBeString();
			}
		}
		const state = request.state as Record<string, unknown>;
		for (const key of [
			"currentStage",
			"nextStage",
			"handoffMarkdown",
			"currentTask",
			"nextMinimalStep",
			"verification",
			"blocker",
			"openDecisions",
			"currentTruth",
			"invalidatedAssumptions",
			"activeFiles",
			"recentlyAccessedFiles",
			"artifacts",
			"activeRules",
		]) {
			expect(Object.keys(state)).toContain(key);
		}
	});

	test("asks only the unforced dimensions", () => {
		const forced = [
			dim("next_step_clarity", 0, { forced: true }),
			dim("verification_support", 0, { forced: true }),
		];
		const asked = READINESS_QUESTION_IDS.filter(
			(id: ReadinessDimensionId) => !forced.some((entry) => entry.id === id),
		);
		const request = buildReadinessRequest(baseState(), asked);
		expect(Object.keys(request.questions)).toEqual([...asked]);
	});
});

describe("Unit 3 — byte bounding and conformance", () => {
	function pathologicalState(): ReadinessState {
		return baseState({
			handoffMarkdown: "M".repeat(200_000),
			currentTask: "T".repeat(10_000),
			currentTruth: Array.from({ length: 200 }, (_, i) => `truth ${i} ${"x".repeat(2_000)}`),
			invalidatedAssumptions: Array.from({ length: 200 }, (_, i) => `assumption ${i} ${"y".repeat(2_000)}`),
			activeFiles: Array.from({ length: 200 }, (_, i) => `src/file-${i}.ts`),
			recentlyAccessedFiles: Array.from({ length: 200 }, (_, i) => `src/recent-${i}.ts`),
			activeRules: Array.from({ length: 200 }, (_, i) => `rule ${i} ${"z".repeat(2_000)}`),
		});
	}

	test("bounds a pathological state under the cap and passes the real validator", () => {
		const request = buildReadinessRequest(pathologicalState());
		enforceRequestBodyLimit(request);
		const body = JSON.stringify(request);
		expect(byteLength(body)).toBeLessThanOrEqual(
			MAX_REQUEST_BODY_BYTES,
		);
		const validated = validateRequest(request);
		expect(validated.body.length).toBeGreaterThan(0);
	});

	test("truncates the markdown bulk before the verdict-carrying strings", () => {
		const request = buildReadinessRequest(
			baseState({
				handoffMarkdown: "M".repeat(200_000),
				nextMinimalStep: "KEEP-NEXT-STEP-MARKER",
				verification: "KEEP-VERIFICATION-MARKER",
			}),
		);
		enforceRequestBodyLimit(request);
		const state = request.state as Record<string, unknown>;
		expect(state.nextMinimalStep).toBe("KEEP-NEXT-STEP-MARKER");
		expect(state.verification).toBe("KEEP-VERIFICATION-MARKER");
		expect((state.handoffMarkdown as string).length).toBeLessThan(200_000);
	});

	test("applies the initial per-field caps while building", () => {
		const request = buildReadinessRequest(
			baseState({ handoffMarkdown: "M".repeat(HANDOFF_MARKDOWN_BYTES * 4) }),
		);
		const state = request.state as Record<string, unknown>;
		expect(byteLength(state.handoffMarkdown as string)).toBeLessThanOrEqual(
			HANDOFF_MARKDOWN_BYTES,
		);
		expect(state.handoffMarkdown as string).toContain(TRUNCATION_MARKER);
	});
});

describe("Unit 3 — answer validity", () => {
	test("rejects a missing answer with a degraded reason", () => {
		const answers = fullAnswers();
		delete answers.next_step_clarity;
		const result = readAnswers(jevResult(answers));
		expect(typeof result).toBe("string");
		expect(result as string).toContain("next_step_clarity");
	});

	test("rejects a confidence below the floor", () => {
		const result = readAnswers(
			jevResult(fullAnswers({ history_need: noul(0.1, 0.2) })),
		);
		expect(typeof result).toBe("string");
	});

	test("rejects non-finite and out-of-range values", () => {
		for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 2, -1]) {
			const result = readAnswers(
				jevResult(fullAnswers({ history_need: noul(bad, 0.9) })),
			);
			expect({ bad, degraded: typeof result === "string" }).toEqual({
				bad,
				degraded: true,
			});
		}
	});

	test("accepts an omitted confidence as 1", () => {
		const result = readAnswers(
			jevResult(fullAnswers({ history_need: noul(0) })),
		);
		expect(Array.isArray(result)).toBe(true);
		const history = (result as ReadinessDimension[]).find(
			(entry) => entry.id === "history_need",
		);
		expect(history?.confidence).toBe(1);
	});

	test("rejects a non-noul answer", () => {
		const result = readAnswers(
			jevResult(fullAnswers({ history_need: { type: "choice", choice: "a" } })),
		);
		expect(typeof result).toBe("string");
	});

	test("merges forced dimensions back so the outcome sees all five", () => {
		const forced = [
			dim("next_step_clarity", 0, { forced: true }),
			dim("verification_support", 0, { forced: true }),
		];
		const asked = READINESS_QUESTION_IDS.filter(
			(id: ReadinessDimensionId) => !forced.some((entry) => entry.id === id),
		);
		const answersByDimension: Record<string, unknown> = {
			continuation_sufficiency: noul(1, 0.9),
			blocking_open_decisions: noul(0, 0.9),
			history_need: noul(0, 0.9),
		};
		const answers: Record<string, unknown> = {};
		for (const id of asked) answers[id] = answersByDimension[id] ?? noul(1, 0.9);
		const merged = readAnswers(jevResult(answers), forced);
		expect(Array.isArray(merged)).toBe(true);
		expect((merged as ReadinessDimension[]).map((entry) => entry.id)).toEqual([
			...READINESS_QUESTION_IDS,
		]);
		const outcome = deriveOutcome(merged as ReadinessDimension[]);
		expect(outcome.verdict).toBe("improve_handoff");
		expect(outcome.corrections.map((entry: ReadinessCorrection) => entry.dimension)).toEqual([
			"next_step_clarity",
			"verification_support",
		]);
	});
});
