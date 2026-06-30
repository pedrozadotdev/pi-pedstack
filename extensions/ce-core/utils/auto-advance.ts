/**
 * Auto-advance workflow state machine.
 *
 * Decides whether the extension should auto-queue `/ped-next` after a
 * successful `context_handoff save`, show a confirm dialog for gated
 * transitions, or do nothing.
 *
 * Pure module — no side effects, no I/O. Testable in isolation.
 *
 * @module auto-advance
 */

// ponytail: In-memory Set for the authorization cache. Per-session only;
// cross-session persistence is YAGNI for now.
const authorizedPairs = new Set<string>();

/**
 * The set of stage transitions that require explicit user authorization
 * (a confirm dialog) before auto-advancing.
 *
 * Gated transitions:
 *   - 02-plan → 03-work : user should read the plan first
 *   - 04-review → 05-learn : user may want /ped-debug instead
 */
const GATED_TRANSITIONS = new Set<string>([
	"02-plan->03-work",
	"04-review->05-learn",
]);

const CONFIRM_DIALOGS: Record<string, { title: string; message: string }> = {
	"02-plan->03-work": {
		title: "Continue to 03-work?",
		message:
			"The plan is complete. Proceed to implementation (03-work), " +
			"or use /ped-reload to re-plan?",
	},
	"04-review->05-learn": {
		title: "Continue to 05-learn?",
		message:
			"Code review complete. Proceed to learn (05-learn), " +
			"or use /ped-debug if bugs were found.",
	},
};

/** The verdict from `evaluateAutoAdvance`. */
export type AutoAdvanceAction =
	/** No action needed — skip auto-advance. */
	| { action: "none" }
	/** Queue the given slash command as a follow-up message. */
	| { action: "send"; message: string }
	/** Show a confirm dialog to the user before acting. */
	| { action: "confirm"; title: string; message: string };

/**
 * Input to the auto-advance evaluator.
 *
 * Derived from a `tool_result` event for the `context_handoff` tool.
 */
export interface AutoAdvanceInput {
	/** The name of the tool that produced the result. */
	toolName: string;
	/** The parsed input object passed to the tool (or null/undefined). */
	input: { operation?: string } | null | undefined;
	/**
	 * Joined text content from the result's text-type blocks.
	 * `null` when no text blocks are present.
	 */
	contentText: string | null;
	/** Whether the tool execution returned an error. */
	isError: boolean;
	/** Whether the current session has a UI (dialog-capable). */
	hasUI: boolean;
	/** Whether the user has already authorized this stage pair this session. */
	isAuthorized: boolean;
}

/** Check whether a stage pair is in the gated transitions set. */
function isGatedTransition(stagePair: string): boolean {
	return GATED_TRANSITIONS.has(stagePair);
}

/**
 * Whether the confirm dialog should be shown for a stage pair.
 * Only shows when the pair is gated, the session has a UI, and the pair
 * hasn't been authorized yet.
 */
function shouldShowConfirm(
	stagePair: string,
	hasUI: boolean,
	isAuthorized: boolean,
): boolean {
	return isGatedTransition(stagePair) && hasUI && !isAuthorized;
}

/**
 * Try to parse the handoff result from a JSON string.
 * Returns `null` on parse failure or non-object values.
 */
function tryParseHandoffResult(
	contentText: string,
): Record<string, unknown> | null {
	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(contentText);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return null;
	}
	return parsed;
}

/**
 * Determine whether a handoff result is eligible for auto-advance.
 * Returns `null` and a reason if it should not advance.
 */
function getHandoffStagePair(
	parsed: Record<string, unknown>,
): { currentStage: string; nextStage: string } | null {
	if (parsed.blocker) return null;
	const currentStage = parsed.currentStage;
	const nextStage = parsed.nextStage;
	if (typeof currentStage !== "string" || typeof nextStage !== "string") {
		return null;
	}
	if (currentStage === nextStage) return null;
	return { currentStage, nextStage };
}

/**
 * Evaluate whether to auto-advance after a tool_result event.
 *
 * Returns one of three actions:
 *   - `none` : do nothing (the handoff wasn't a successful save, or is
 *     a same-stage save, or has a blocker).
 *   - `send` : queue `/ped-next` as a follow-up message.
 *   - `confirm` : show a confirm dialog before potentially advancing.
 *
 * This is a **pure function** — no side effects, no I/O.
 */
export function evaluateAutoAdvance(
	input: AutoAdvanceInput,
): AutoAdvanceAction {
	// Only intercept context_handoff saves
	if (input.toolName !== "context_handoff") return { action: "none" };
	if (!input.input || input.input.operation !== "save") {
		return { action: "none" };
	}
	if (input.isError) return { action: "none" };
	if (!input.contentText) return { action: "none" };

	// Parse the handoff result JSON
	const parsed = tryParseHandoffResult(input.contentText);
	if (!parsed) return { action: "none" };

	// Extract stage info from result
	const stages = getHandoffStagePair(parsed);
	if (!stages) return { action: "none" };

	const stagePair = `${stages.currentStage}->${stages.nextStage}`;

	// Gated transitions need a confirm dialog (unless already authorized
	// or running in print mode without a UI).
	if (shouldShowConfirm(stagePair, input.hasUI, input.isAuthorized)) {
		return {
			action: "confirm",
			title: CONFIRM_DIALOGS[stagePair].title,
			message: CONFIRM_DIALOGS[stagePair].message,
		};
	}

	// All non-gated, already-authorized, or print-mode transitions auto-advance
	return { action: "send", message: "/ped-next" };
}

/**
 * Mark a stage pair as authorized by the user for this session.
 *
 * Once authorized, the gated confirm dialog will be skipped for the
 * remainder of the session.
 */
export function markAuthorized(stagePair: string): void {
	authorizedPairs.add(stagePair);
}

/**
 * Check whether a stage pair has already been authorized this session.
 */
export function isAuthorized(stagePair: string): boolean {
	return authorizedPairs.has(stagePair);
}

/**
 * Clear the entire authorization cache.
 *
 * Called on session restart or during testing to reset state.
 */
export function clearAutoAdvanceCache(): void {
	authorizedPairs.clear();
}
