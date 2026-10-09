import { expect, test } from "bun:test";
import { greet } from "../src/greeting";

test("greets by name", () => {
	expect(greet("Ada")).toBe("Hello, Ada!");
});
