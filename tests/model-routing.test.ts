import { describe, expect, test } from "bun:test";
import type { JevResult } from "../extensions/ce-core/jev/types";
import {
	DEFAULT_MODEL_ROUTING,
	ROUTING_QUESTIONS,
	buildRoutingRequest,
	resolveExecutionRole,
	scoreJudgment,
	type RoleResolutionInput,
} from "../extensions/ce-core/utils/model-routing";

const THRESHOLDS = {
	sotaMinScore: 0.6,
	sotaMinConfidence: 0.5,
	maxEscalationsPerStage: 1,
};

function input(
	overrides: Partial<RoleResolutionInput> = {},
): RoleResolutionInput {
	return {
		overrideModel: null,
		gateEscalate: false,
		jev: null,
		escalations: 0,
		thresholds: THRESHOLDS,
		...overrides,
	};
}

const QUALIFYING = { weighted: 0.8, confidence: 0.9, scores: { complexity: 0.8 } };

describe("resolveExecutionRole — precedence", () => {
	test("exposes the documented default thresholds", () => {
		expect(DEFAULT_MODEL_ROUTING).toEqual({
			sotaMinScore: 0.6,
			sotaMinConfidence: 0.5,
			maxEscalationsPerStage: 1,
			shadow: true,
		});
	});

	test("1. an explicit override wins over gate escalation and Jev", () => {
		const decision = resolveExecutionRole(
			input({
				overrideModel: "anthropic/claude-opus",
				gateEscalate: true,
				jev: QUALIFYING,
			}),
		);

		expect(decision.role).toBe("default");
		expect(decision.reason).toBe("override");
		expect(decision.source).toBe("override");
		expect(decision.overrideModel).toBe("anthropic/claude-opus");
		expect(decision.weighted).toBeNull();
		expect(decision.confidence).toBeNull();
		expect(decision.scores).toBeNull();
	});

	test("an empty override string is not an override", () => {
		const decision = resolveExecutionRole(
			input({ overrideModel: "" }),
		);

		expect(decision.reason).toBe("fallback");
		expect(decision.overrideModel).toBeNull();
	});

	test("2. gate escalation selects sota deterministically", () => {
		const decision = resolveExecutionRole(input({ gateEscalate: true }));

		expect(decision.role).toBe("sota");
		expect(decision.reason).toBe("gate_escalate");
		expect(decision.source).toBe("deterministic");
		expect(decision.overrideModel).toBeNull();
	});

	test("2. gate escalation outranks an exhausted escalation budget", () => {
		const decision = resolveExecutionRole(
			input({ gateEscalate: true, escalations: 99 }),
		);

		expect(decision.role).toBe("sota");
		expect(decision.reason).toBe("gate_escalate");
		expect(decision.source).toBe("deterministic");
	});

	test("3. a qualifying Jev judgment selects sota", () => {
		const decision = resolveExecutionRole(input({ jev: QUALIFYING }));

		expect(decision.role).toBe("sota");
		expect(decision.reason).toBe("jev");
		expect(decision.source).toBe("jev");
		expect(decision.weighted).toBe(0.8);
		expect(decision.confidence).toBe(0.9);
		expect(decision.scores).toEqual({ complexity: 0.8 });
	});

	test("3. a Jev judgment below the score threshold selects default", () => {
		const decision = resolveExecutionRole(
			input({ jev: { weighted: 0.59, confidence: 0.9, scores: {} } }),
		);

		expect(decision.role).toBe("default");
		expect(decision.reason).toBe("fallback");
		expect(decision.source).toBe("fallback");
	});

	test("3. a Jev judgment below the confidence threshold selects default", () => {
		const decision = resolveExecutionRole(
			input({ jev: { weighted: 0.9, confidence: 0.49, scores: {} } }),
		);

		expect(decision.role).toBe("default");
		expect(decision.reason).toBe("fallback");
	});

	test("thresholds are inclusive at the documented boundaries", () => {
		const decision = resolveExecutionRole(
			input({ jev: { weighted: 0.6, confidence: 0.5, scores: {} } }),
		);

		expect(decision.role).toBe("sota");
		expect(decision.reason).toBe("jev");
	});

	test("4. an exhausted budget records budget_exhausted, not fallback", () => {
		const decision = resolveExecutionRole(
			input({ jev: QUALIFYING, escalations: 1 }),
		);

		expect(decision.role).toBe("default");
		expect(decision.reason).toBe("budget_exhausted");
		expect(decision.source).toBe("budget");
		expect(decision.weighted).toBe(0.8);
		expect(decision.confidence).toBe(0.9);
		expect(decision.scores).toEqual({ complexity: 0.8 });
	});
});

describe("resolveExecutionRole — fallback invariant", () => {
	test("a missing judgment always degrades to default/fallback", () => {
		for (let i = 0; i < 5; i++) {
			const decision = resolveExecutionRole(input({ jev: null }));
			expect(decision.role).toBe("default");
			expect(decision.reason).toBe("fallback");
			expect(decision.source).toBe("fallback");
			expect(decision.weighted).toBeNull();
			expect(decision.confidence).toBeNull();
			expect(decision.scores).toBeNull();
		}
	});

	test("the fallback never reports a Jev source", () => {
		const decision = resolveExecutionRole(input({ jev: null }));
		expect(decision.source).not.toBe("jev");
		expect(decision.reason).not.toBe("jev");
	});

	test("no execution path ever returns the review role", () => {
		const cases: RoleResolutionInput[] = [
			input(),
			input({ overrideModel: "x" }),
			input({ gateEscalate: true }),
			input({ jev: QUALIFYING }),
			input({ jev: QUALIFYING, escalations: 5 }),
			input({ jev: { weighted: 0.1, confidence: 0.1, scores: {} } }),
		];

		for (const scenario of cases) {
			const decision = resolveExecutionRole(scenario);
			expect(["default", "sota"]).toContain(decision.role);
		}
	});
});

const QUESTION_IDS = [
	"complexity",
	"risk",
	"cross_cutting",
	"deep_reasoning",
	"ambiguity",
] as const;

function result(answers: Record<string, unknown>): JevResult {
	return { answers: answers as JevResult["answers"], model: "test", warnings: [] };
}

function noul(
	value: number | string | null,
	confidence?: number | null,
): Record<string, unknown> {
	const answer: Record<string, unknown> = { type: "noul", noul: value };
	if (confidence !== undefined) answer.confidence = confidence;
	return answer;
}

function fullAnswers(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		complexity: noul(1, 0.7),
		risk: noul(0.5, 0.8),
		cross_cutting: noul(0.5, 0.9),
		deep_reasoning: noul(0, 0.6),
		ambiguity: noul(1),
		...overrides,
	};
}

describe("routing Jev question set", () => {
	test("emits exactly the five noul questions with weights summing to 1", () => {
		expect(ROUTING_QUESTIONS.map((q) => q.id)).toEqual([...QUESTION_IDS]);
		expect(ROUTING_QUESTIONS.map((q) => q.weight)).toEqual([
			0.25, 0.2, 0.2, 0.2, 0.15,
		]);
		const total = ROUTING_QUESTIONS.reduce((sum, q) => sum + q.weight, 0);
		expect(total).toBeCloseTo(1, 5);
	});

	test("buildRoutingRequest carries the state and one noul per question", () => {
		const request = buildRoutingRequest({ task: "do the thing" });

		expect(request.state).toEqual({ task: "do the thing" });
		expect(Object.keys(request.questions)).toEqual([...QUESTION_IDS]);
		for (const id of QUESTION_IDS) {
			expect(request.questions[id].type).toBe("noul");
		}
	});
});

describe("scoreJudgment", () => {
	test("combines the documented weights and takes the minimum confidence", () => {
		const judgment = scoreJudgment(result(fullAnswers()));

		expect(judgment).not.toBeNull();
		// 1*.25 + .5*.20 + .5*.20 + 0*.20 + 1*.15 = 0.60
		expect(judgment!.weighted).toBeCloseTo(0.6, 5);
		expect(judgment!.confidence).toBe(0.6);
		expect(judgment!.scores).toEqual({
			complexity: 1,
			risk: 0.5,
			cross_cutting: 0.5,
			deep_reasoning: 0,
			ambiguity: 1,
		});
	});

	test("omitted confidence defaults to 1", () => {
		const judgment = scoreJudgment(
			result({
				complexity: noul(0.5),
				risk: noul(0.5),
				cross_cutting: noul(0.5),
				deep_reasoning: noul(0.5),
				ambiguity: noul(0.5),
			}),
		);

		expect(judgment!.confidence).toBe(1);
	});

	test("an explicit null confidence is invalid", () => {
		const judgment = scoreJudgment(
			result(fullAnswers({ risk: noul(0.5, null) })),
		);

		expect(judgment).toBeNull();
	});

	test("returns null when any question is missing", () => {
		const answers = fullAnswers();
		delete answers.ambiguity;

		expect(scoreJudgment(result(answers))).toBeNull();
	});

	test("returns null for non-finite or out-of-range answers", () => {
		expect(
			scoreJudgment(result(fullAnswers({ risk: noul(Number.NaN) }))),
		).toBeNull();
		expect(
			scoreJudgment(result(fullAnswers({ risk: noul(1.5) }))),
		).toBeNull();
		expect(
			scoreJudgment(result(fullAnswers({ risk: noul(-0.1) }))),
		).toBeNull();
	});

	test("returns null when an answer is not a noul", () => {
		expect(
			scoreJudgment(
				result(fullAnswers({ risk: { type: "choice", choice: "a" } })),
			),
		).toBeNull();
	});
});
