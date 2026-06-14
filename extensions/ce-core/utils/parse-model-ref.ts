/**
 * Parse a model reference string into provider and ID components.
 *
 * Supports two formats:
 * - "provider/model-id" → { provider: "provider", id: "model-id" }
 * - "model-id" with currentProvider → { provider: currentProvider, id: "model-id" }
 *
 * Returns null for empty/missing references.
 */
export function parseModelRef(
	modelRef: string,
	currentProvider?: string,
): { provider: string; id: string } | null {
	const trimmed = modelRef.trim();
	if (!trimmed) return null;

	const slashIndex = trimmed.indexOf("/");
	if (slashIndex > 0 && slashIndex < trimmed.length - 1) {
		return {
			provider: trimmed.slice(0, slashIndex),
			id: trimmed.slice(slashIndex + 1),
		};
	}

	if (!currentProvider) return null;

	return {
		provider: currentProvider,
		id: trimmed,
	};
}
