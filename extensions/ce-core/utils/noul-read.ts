// Shared `noul` answer readers (unit-interval validation + confidence default),
// used by both solution ranking and model-role routing.

export function isUnitNumber(value: unknown): value is number {
	return (
		typeof value === "number" &&
		Number.isFinite(value) &&
		value >= 0 &&
		value <= 1
	);
}

/** Omitted confidence means 1; an explicit null/non-finite value is invalid. */
export function readConfidence(answer: { confidence?: unknown }): number | null {
	if (answer.confidence === undefined) return 1;
	return isUnitNumber(answer.confidence) ? answer.confidence : null;
}
