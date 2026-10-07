// Pure review policy (plan Unit 1): maps one persisted gate verdict plus the
// independent-review budget and reviewer availability to one bounded action.
// No I/O; the stage-gate verdict stays the single quality authority.
import type { PiPedstackConfig, StepConfigKey } from "../utils/config-types";
import type {
	ReviewAction,
	ReviewPolicyDecision,
	StageGateVerdict,
} from "../stage-gate/types";

/** Independent-review budget per stage loop (Ponytail: constant until calibrated). */
export const MAX_INDEPENDENT_REVIEW = 1;

export interface ReviewPolicyInput {
	verdict: StageGateVerdict;
	/** Prior retained attempts for this stage whose verdict is `review`. */
	independentReviews: number;
	/** True when an independent reviewer resolves from config. */
	reviewerAvailable: boolean;
}

function decision(
	action: ReviewAction,
	reviewerCount: 0 | 1,
	reason: string,
): ReviewPolicyDecision {
	return { action, reviewerCount, reason };
}

/** Maps the gate verdict to exactly one bounded review action. */
export function resolveReviewAction(
	input: ReviewPolicyInput,
): ReviewPolicyDecision {
	switch (input.verdict) {
		case "accept":
			return decision(
				"none",
				0,
				"gate accepted the artifact; no independent review required",
			);
		case "revise":
			return decision(
				"revise",
				0,
				"gate requires revision before independent review",
			);
		case "escalate":
			return decision("escalate", 0, "gate escalated the artifact");
		case "review":
			if (!input.reviewerAvailable) {
				return decision(
					"escalate",
					0,
					"gate requested review but no independent reviewer is configured",
				);
			}
			if (input.independentReviews >= MAX_INDEPENDENT_REVIEW) {
				return decision(
					"escalate",
					0,
					`independent review budget exhausted (${MAX_INDEPENDENT_REVIEW} per stage)`,
				);
			}
			return decision("review", 1, "gate requested one independent review");
	}
}

/** Every model writer that can execute the stage turn (roles + stage override). */
export function collectExecutionModels(
	config: PiPedstackConfig | null,
	configKey: StepConfigKey | null,
): string[] {
	const models: string[] = [];
	for (const role of ["default", "sota"] as const) {
		const model = config?.models?.[role]?.model;
		if (typeof model === "string" && model.length > 0) models.push(model);
	}
	const override = configKey ? config?.[configKey]?.model : undefined;
	if (typeof override === "string" && override.length > 0) models.push(override);
	return models;
}

/**
 * Review isolation is provided by the separate no-session reviewer invocation,
 * not by requiring a distinct model id. The reviewer may intentionally reuse
 * the same model configured for default or SOTA execution.
 */
export function filterIndependentReviewers<T extends { model: string }>(
	reviewers: readonly T[],
	_config: PiPedstackConfig | null,
	_configKey: StepConfigKey | null,
): { reviewers: T[]; dropped: string[] } {
	return {
		reviewers: reviewers.filter(
			(reviewer) =>
				typeof reviewer.model === "string" && reviewer.model.trim().length > 0,
		),
		dropped: [],
	};
}

/**
 * True when the stage has any explicit reviewer or a configured models.review
 * role. The actual review still runs in a fresh no-session process, which is
 * the independence boundary.
 */
export function hasIndependentReviewer(
	config: PiPedstackConfig | null,
	configKey: StepConfigKey,
): boolean {
	const stage = config?.[configKey];
	if (stage && "reviewers" in stage) {
		const reviewers = stage.reviewers;
		if (
			Array.isArray(reviewers) &&
			reviewers.some(
				(reviewer) =>
					typeof reviewer?.model === "string" &&
					reviewer.model.trim().length > 0,
			)
		) {
			return true;
		}
	}
	const reviewModel = config?.models?.review?.model;
	return typeof reviewModel === "string" && reviewModel.trim().length > 0;
}
