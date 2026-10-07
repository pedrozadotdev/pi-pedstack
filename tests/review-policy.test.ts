// Unit 1: pure review policy module (RED first).
import { describe, expect, test } from "bun:test";
import {
	MAX_INDEPENDENT_REVIEW,
	collectExecutionModels,
	filterIndependentReviewers,
	hasIndependentReviewer,
	resolveReviewAction,
} from "../extensions/ce-core/review/policy.js";
import type { PiPedstackConfig } from "../extensions/ce-core/utils/config-types.js";

describe("review policy — action mapping (Unit 1)", () => {
	test("accept maps to none with zero reviewers", () => {
		const decision = resolveReviewAction({
			verdict: "accept",
			independentReviews: 0,
			reviewerAvailable: true,
		});
		expect(decision.action).toBe("none");
		expect(decision.reviewerCount).toBe(0);
		expect(decision.reason.length).toBeGreaterThan(0);
	});

	test("revise maps to revise with zero reviewers", () => {
		const decision = resolveReviewAction({
			verdict: "revise",
			independentReviews: 0,
			reviewerAvailable: true,
		});
		expect(decision.action).toBe("revise");
		expect(decision.reviewerCount).toBe(0);
		expect(decision.reason.length).toBeGreaterThan(0);
	});

	test("review with zero prior reviews and an available reviewer maps to review", () => {
		const decision = resolveReviewAction({
			verdict: "review",
			independentReviews: 0,
			reviewerAvailable: true,
		});
		expect(decision.action).toBe("review");
		expect(decision.reviewerCount).toBe(1);
	});

	test("review at the budget cap escalates", () => {
		const decision = resolveReviewAction({
			verdict: "review",
			independentReviews: MAX_INDEPENDENT_REVIEW,
			reviewerAvailable: true,
		});
		expect(decision.action).toBe("escalate");
		expect(decision.reviewerCount).toBe(0);
		expect(decision.reason.length).toBeGreaterThan(0);
	});

	test("review with no available reviewer escalates", () => {
		const decision = resolveReviewAction({
			verdict: "review",
			independentReviews: 0,
			reviewerAvailable: false,
		});
		expect(decision.action).toBe("escalate");
		expect(decision.reviewerCount).toBe(0);
		expect(decision.reason.length).toBeGreaterThan(0);
	});

	test("escalate maps to escalate", () => {
		const decision = resolveReviewAction({
			verdict: "escalate",
			independentReviews: 0,
			reviewerAvailable: true,
		});
		expect(decision.action).toBe("escalate");
		expect(decision.reviewerCount).toBe(0);
	});
});

describe("review policy — execution model comparison set (Unit 1)", () => {
	test("includes the per-stage override for each config key", () => {
		const config = {
			brainstorm: { model: "stage/brainstorm" },
			plan: { model: "stage/plan" },
			work: { model: "stage/work" },
			review: { model: "stage/review" },
			debug: { model: "stage/debug" },
			learn: { model: "stage/learn" },
			docsync: { model: "stage/docsync" },
			models: { default: { model: "role/default" }, sota: { model: "role/sota" } },
		} as PiPedstackConfig;

		expect(collectExecutionModels(config, "brainstorm")).toContain("stage/brainstorm");
		expect(collectExecutionModels(config, "plan")).toContain("stage/plan");
		expect(collectExecutionModels(config, "work")).toContain("stage/work");
		expect(collectExecutionModels(config, "review")).toContain("stage/review");
		expect(collectExecutionModels(config, "debug")).toContain("stage/debug");
		expect(collectExecutionModels(config, "learn")).toContain("stage/learn");
		expect(collectExecutionModels(config, "docsync")).toContain("stage/docsync");
	});

	test("includes both role models", () => {
		const config = {
			models: { default: { model: "role/default" }, sota: { model: "role/sota" } },
		} as PiPedstackConfig;
		const models = collectExecutionModels(config, "plan");
		expect(models).toContain("role/default");
		expect(models).toContain("role/sota");
	});
});

describe("review policy — reviewer availability (Unit 1)", () => {
	test("is true for explicit reviewers", () => {
		const config = {
			plan: {
				model: "stage/plan",
				reviewers: [{ model: "explicit/reviewer" }],
			},
		} as PiPedstackConfig;
		expect(hasIndependentReviewer(config, "plan")).toBe(true);
	});

	test("is true for a distinct models.review", () => {
		const config = {
			models: {
				default: { model: "role/default" },
				review: { model: "role/review" },
			},
		} as PiPedstackConfig;
		expect(hasIndependentReviewer(config, "plan")).toBe(true);
	});

	test("is true when models.review reuses the SOTA model", () => {
		const config = {
			models: {
				default: { model: "role/default" },
				review: { model: "role/sota" },
				sota: { model: "role/sota" },
			},
		} as PiPedstackConfig;
		expect(hasIndependentReviewer(config, "plan")).toBe(true);
	});

	test("is true when models.review reuses the per-stage model", () => {
		const config = {
			plan: { model: "stage/plan" },
			models: { review: { model: "stage/plan" } },
		} as PiPedstackConfig;
		expect(hasIndependentReviewer(config, "plan")).toBe(true);
	});

	test("is false with no reviewer config at all", () => {
		expect(hasIndependentReviewer(null, "plan")).toBe(false);
	});
});

describe("review policy — isolated reviewer invocation (Unit 3)", () => {
	test("keeps explicit reviewers even when they reuse an execution model", () => {
		const config = {
			plan: {
				model: "stage/plan",
				reviewers: [{ model: "stage/plan" }, { model: "explicit/one" }],
			},
		} as PiPedstackConfig;
		const { reviewers, dropped } = filterIndependentReviewers(
			config.plan?.reviewers ?? [],
			config,
			"plan",
		);
		expect(reviewers.map((reviewer) => reviewer.model)).toEqual([
			"stage/plan",
			"explicit/one",
		]);
		expect(dropped).toEqual([]);
	});

	test("hasIndependentReviewer accepts a same-model explicit reviewer", () => {
		const config = {
			plan: { model: "stage/plan", reviewers: [{ model: "stage/plan" }] },
		} as PiPedstackConfig;
		expect(hasIndependentReviewer(config, "plan")).toBe(true);
	});
});
