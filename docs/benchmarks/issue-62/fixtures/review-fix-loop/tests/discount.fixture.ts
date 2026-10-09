import { expect, test } from "bun:test";
import { discountedPriceCents } from "../src/discount";

test("applies an ordinary discount", () => {
	expect(discountedPriceCents(1_000, 25)).toBe(750);
});
