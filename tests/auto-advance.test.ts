import { describe, expect, test, beforeEach } from "bun:test";
import {
	evaluateAutoAdvance,
	markAuthorized,
	isAuthorized,
	clearAutoAdvanceCache,
} from "../extensions/ce-core/utils/auto-advance";
import type { AutoAdvanceInput } from "../extensions/ce-core/utils/auto-advance";

function makeInput(
	overrides: Partial<AutoAdvanceInput> = {},
): AutoAdvanceInput {
	return {
		toolName: "context_handoff",
		input: { operation: "save" },
		contentText: JSON.stringify({
			currentStage: "01-brainstorm",
			nextStage: "02-plan",
		}),
		isError: false,
		hasUI: true,
		isAuthorized: false,
		...overrides,
	};
}

// ── RED phase guard: test fails without implementation ──

describe("evaluateAutoAdvance — non-pedstack / non-save", () => {
	test("returns none for non-context_handoff tool name", () => {
		const result = evaluateAutoAdvance(makeInput({ toolName: "bash" }));
		expect(result.action).toBe("none");
	});

	test("returns none for context_handoff with operation !== save", () => {
		const result = evaluateAutoAdvance(
			makeInput({ input: { operation: "load" } }),
		);
		expect(result.action).toBe("none");
	});

	test("returns none for context_handoff with operation 'latest'", () => {
		const result = evaluateAutoAdvance(
			makeInput({ input: { operation: "latest" } }),
		);
		expect(result.action).toBe("none");
	});

	test("returns none for context_handoff with operation 'status'", () => {
		const result = evaluateAutoAdvance(
			makeInput({ input: { operation: "status" } }),
		);
		expect(result.action).toBe("none");
	});

	test("returns none for context_handoff with operation 'validate'", () => {
		const result = evaluateAutoAdvance(
			makeInput({ input: { operation: "validate" } }),
		);
		expect(result.action).toBe("none");
	});
});

describe("evaluateAutoAdvance — error / blocker / missing fields", () => {
	test("returns none when isError is true", () => {
		const result = evaluateAutoAdvance(makeInput({ isError: true }));
		expect(result.action).toBe("none");
	});

	test("returns none when contentText is null", () => {
		const result = evaluateAutoAdvance(makeInput({ contentText: null }));
		expect(result.action).toBe("none");
	});

	test("returns none when content is not valid JSON", () => {
		const result = evaluateAutoAdvance(makeInput({ contentText: "not-json" }));
		expect(result.action).toBe("none");
	});

	test("returns none when content is valid JSON but not an object (array)", () => {
		const result = evaluateAutoAdvance(makeInput({ contentText: "[]" }));
		expect(result.action).toBe("none");
	});

	test("returns none when parsed result has a blocker", () => {
		const result = evaluateAutoAdvance(
			makeInput({
				contentText: JSON.stringify({
					currentStage: "02-plan",
					nextStage: "03-work",
					blocker: "Something blocks progress",
				}),
			}),
		);
		expect(result.action).toBe("none");
	});

	test("returns none when currentStage is missing", () => {
		const result = evaluateAutoAdvance(
			makeInput({
				contentText: JSON.stringify({ nextStage: "02-plan" }),
			}),
		);
		expect(result.action).toBe("none");
	});

	test("returns none when nextStage is missing", () => {
		const result = evaluateAutoAdvance(
			makeInput({
				contentText: JSON.stringify({ currentStage: "01-brainstorm" }),
			}),
		);
		expect(result.action).toBe("none");
	});

	test("returns none when currentStage === nextStage", () => {
		const result = evaluateAutoAdvance(
			makeInput({
				contentText: JSON.stringify({
					currentStage: "03-work",
					nextStage: "03-work",
				}),
			}),
		);
		expect(result.action).toBe("none");
	});

	test("returns none when input is null", () => {
		const result = evaluateAutoAdvance(makeInput({ input: null }));
		expect(result.action).toBe("none");
	});

	test("returns none when input is undefined", () => {
		const result = evaluateAutoAdvance(makeInput({ input: undefined }));
		expect(result.action).toBe("none");
	});

	test("returns none when operation is missing from input", () => {
		const result = evaluateAutoAdvance(makeInput({ input: {} }));
		expect(result.action).toBe("none");
	});

	test("returns none when contentText is empty string", () => {
		const result = evaluateAutoAdvance(makeInput({ contentText: "" }));
		expect(result.action).toBe("none");
	});
});

describe("evaluateAutoAdvance — auto transitions (non-gated)", () => {
	test("returns send for 01-brainstorm→02-plan, hasUI=true, isAuthorized=false", () => {
		const result = evaluateAutoAdvance(
			makeInput({
				contentText: JSON.stringify({
					currentStage: "01-brainstorm",
					nextStage: "02-plan",
				}),
				hasUI: true,
				isAuthorized: false,
			}),
		);
		expect(result.action).toBe("send");
		if (result.action === "send") {
			expect(result.message).toBe("/ped-next");
		}
	});

	test("returns send for 01-brainstorm→02-plan, hasUI=false", () => {
		const result = evaluateAutoAdvance(
			makeInput({
				contentText: JSON.stringify({
					currentStage: "01-brainstorm",
					nextStage: "02-plan",
				}),
				hasUI: false,
			}),
		);
		expect(result.action).toBe("send");
	});

	test("returns send for 03-work→04-review, hasUI=true", () => {
		const result = evaluateAutoAdvance(
			makeInput({
				contentText: JSON.stringify({
					currentStage: "03-work",
					nextStage: "04-review",
				}),
			}),
		);
		expect(result.action).toBe("send");
	});

	test("returns send for 03-work→04-review, hasUI=false", () => {
		const result = evaluateAutoAdvance(
			makeInput({
				contentText: JSON.stringify({
					currentStage: "03-work",
					nextStage: "04-review",
				}),
				hasUI: false,
			}),
		);
		expect(result.action).toBe("send");
	});

	test("returns send for 05-learn→06-docsync, hasUI=true", () => {
		const result = evaluateAutoAdvance(
			makeInput({
				contentText: JSON.stringify({
					currentStage: "05-learn",
					nextStage: "06-docsync",
				}),
			}),
		);
		expect(result.action).toBe("send");
	});

	test("returns send for 04-5-debug→05-learn, hasUI=true", () => {
		const result = evaluateAutoAdvance(
			makeInput({
				contentText: JSON.stringify({
					currentStage: "04-5-debug",
					nextStage: "05-learn",
				}),
			}),
		);
		expect(result.action).toBe("send");
	});
});

describe("evaluateAutoAdvance — gated transitions", () => {
	beforeEach(() => {
		clearAutoAdvanceCache();
	});

	test("returns confirm for 02-plan→03-work, hasUI=true, isAuthorized=false, with correct title/message", () => {
		const result = evaluateAutoAdvance(
			makeInput({
				contentText: JSON.stringify({
					currentStage: "02-plan",
					nextStage: "03-work",
				}),
				hasUI: true,
				isAuthorized: false,
			}),
		);
		expect(result.action).toBe("confirm");
		if (result.action === "confirm") {
			expect(result.title).toBeTruthy();
			expect(result.message).toBeTruthy();
			expect(result.title).toContain("03-work");
		}
	});

	test("returns send for 02-plan→03-work, hasUI=true, isAuthorized=true", () => {
		const result = evaluateAutoAdvance(
			makeInput({
				contentText: JSON.stringify({
					currentStage: "02-plan",
					nextStage: "03-work",
				}),
				hasUI: true,
				isAuthorized: true,
			}),
		);
		expect(result.action).toBe("send");
	});

	test("returns send for 02-plan→03-work, hasUI=false (print mode)", () => {
		const result = evaluateAutoAdvance(
			makeInput({
				contentText: JSON.stringify({
					currentStage: "02-plan",
					nextStage: "03-work",
				}),
				hasUI: false,
			}),
		);
		expect(result.action).toBe("send");
	});

	test("returns confirm for 04-review→05-learn, hasUI=true, isAuthorized=false, with correct title/message", () => {
		const result = evaluateAutoAdvance(
			makeInput({
				contentText: JSON.stringify({
					currentStage: "04-review",
					nextStage: "05-learn",
				}),
				hasUI: true,
				isAuthorized: false,
			}),
		);
		expect(result.action).toBe("confirm");
		if (result.action === "confirm") {
			expect(result.title).toBeTruthy();
			expect(result.message).toBeTruthy();
			expect(result.title).toContain("05-learn");
		}
	});

	test("returns send for 04-review→05-learn, hasUI=true, isAuthorized=true", () => {
		const result = evaluateAutoAdvance(
			makeInput({
				contentText: JSON.stringify({
					currentStage: "04-review",
					nextStage: "05-learn",
				}),
				hasUI: true,
				isAuthorized: true,
			}),
		);
		expect(result.action).toBe("send");
	});

	test("returns send for 04-review→05-learn, hasUI=false (print mode)", () => {
		const result = evaluateAutoAdvance(
			makeInput({
				contentText: JSON.stringify({
					currentStage: "04-review",
					nextStage: "05-learn",
				}),
				hasUI: false,
			}),
		);
		expect(result.action).toBe("send");
	});
});

describe("authorization cache API", () => {
	beforeEach(() => {
		clearAutoAdvanceCache();
	});

	test("isAuthorized returns false for unknown pair", () => {
		expect(isAuthorized("02-plan->03-work")).toBe(false);
	});

	test("markAuthorized then isAuthorized returns true", () => {
		markAuthorized("02-plan->03-work");
		expect(isAuthorized("02-plan->03-work")).toBe(true);
	});

	test("markAuthorized multiple pairs are tracked independently", () => {
		markAuthorized("02-plan->03-work");
		markAuthorized("04-review->05-learn");
		expect(isAuthorized("02-plan->03-work")).toBe(true);
		expect(isAuthorized("04-review->05-learn")).toBe(true);
		expect(isAuthorized("01-brainstorm->02-plan")).toBe(false);
	});

	test("clearAutoAdvanceCache empties all entries", () => {
		markAuthorized("02-plan->03-work");
		markAuthorized("04-review->05-learn");
		clearAutoAdvanceCache();
		expect(isAuthorized("02-plan->03-work")).toBe(false);
		expect(isAuthorized("04-review->05-learn")).toBe(false);
	});

	test("markAuthorized is idempotent", () => {
		markAuthorized("02-plan->03-work");
		markAuthorized("02-plan->03-work");
		expect(isAuthorized("02-plan->03-work")).toBe(true);
	});
});

describe("evaluateAutoAdvance — edge cases", () => {
	test("returns send for unknown stage pair (default auto-advance)", () => {
		const result = evaluateAutoAdvance(
			makeInput({
				contentText: JSON.stringify({
					currentStage: "99-unknown",
					nextStage: "00-mystery",
				}),
			}),
		);
		// Unknown pairs are not gated, so they auto-advance
		expect(result.action).toBe("send");
	});

	test("returns none when contentText has extra whitespace around JSON", () => {
		const result = evaluateAutoAdvance(
			makeInput({
				contentText: `  ${JSON.stringify({
					currentStage: "03-work",
					nextStage: "04-review",
				})}  `,
			}),
		);
		expect(result.action).toBe("send");
	});

	test("handles contentText with multiple text blocks joined", () => {
		// Simulate joined text from multiple text blocks
		const result = evaluateAutoAdvance(
			makeInput({
				contentText: `${JSON.stringify({
					currentStage: "03-work",
					nextStage: "04-review",
				})}`,
			}),
		);
		expect(result.action).toBe("send");
	});
});
