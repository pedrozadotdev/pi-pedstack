export function discountedPriceCents(priceCents: number, percent: number): number {
	return Math.max(0, priceCents - Math.round(priceCents * percent / 100));
}
