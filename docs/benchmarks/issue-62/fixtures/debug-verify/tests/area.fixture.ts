import { expect, test } from "bun:test";
import { area } from "../src/area";

test("computes rectangle area", () => {
	expect(area(6, 13)).toBe(78);
});
