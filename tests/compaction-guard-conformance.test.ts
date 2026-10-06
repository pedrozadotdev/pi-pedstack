// Unit 2 conformance — every generated compaction request must pass the real
// Jev request validator and stay within its byte cap. No live Jev process.
import { describe, expect, test } from "bun:test";
import {
	buildCompactionRequest,
	buildCompactionState,
	enforceRequestBodyLimit,
} from "../extensions/ce-core/compaction-guard/combine.js";
import {
	MAX_REQUEST_BODY_BYTES,
} from "../extensions/ce-core/compaction-guard/facts.js";
import type {
	CompactionFacts,
	CompactionState,
} from "../extensions/ce-core/compaction-guard/types.js";
import { validateRequest } from "../extensions/ce-core/jev/validate.js";

const FACTS: CompactionFacts = {
	reason: "threshold",
	tokensBefore: 112_000,
	contextWindow: 128_000,
	triggerTokens: 111_616,
	headroomTokens: 16_384,
	overageTokens: 384,
	pressure: 0.875,
	tier: "recommend",
};

function state(over: Partial<CompactionState> = {}): CompactionState {
	return {
		isSplitTurn: false,
		recentEntries: [],
		priorSummary: "",
		tokensBefore: FACTS.tokensBefore,
		overageTokens: FACTS.overageTokens,
		pressure: FACTS.pressure,
		...over,
	};
}

const CASES: Array<[string, CompactionState]> = [
	["empty state", state()],
	[
		"typical state",
		buildCompactionState({
			facts: FACTS,
			isSplitTurn: true,
			recentEntries: ["implemented unit", "ran bun test"],
			priorSummary: "Earlier summary.",
		}),
	],
	[
		"pathological excerpts",
		state({
			recentEntries: Array.from({ length: 50 }, () => "x".repeat(100_000)),
			priorSummary: "y".repeat(100_000),
		}),
	],
	[
		"unicode and newlines",
		state({
			recentEntries: ["日本語のテキスト\n\twith tabs", "emoji 🐴🚀 and \"quotes\""],
			priorSummary: "multi\nline\nsummary — dash",
		}),
	],
	[
		"credential-laden excerpt",
		state({ recentEntries: ["API_TOKEN=abc123 https://x.test/a?token=z#frag"] }),
	],
	[
		"json-looking excerpt content",
		state({
			recentEntries: ['{"a": [1, 2, 3], "b": {"c": true}}'],
			priorSummary: "[1,2,3]",
		}),
	],
];

describe("conformance against the real Jev validator", () => {
	for (const [name, builtState] of CASES) {
		test(`${name} validates and stays within the cap`, () => {
			const request = buildCompactionRequest(builtState);
			enforceRequestBodyLimit(request);
			const validated = validateRequest(request);
			expect(typeof validated.body).toBe("string");
			expect(
				Buffer.byteLength(validated.body, "utf8"),
			).toBeLessThanOrEqual(MAX_REQUEST_BODY_BYTES);
			expect(Object.keys(validated.request.questions)).toHaveLength(4);
		});
	}

	test("the validator cap matches the frozen request cap", () => {
		// A hand-built oversized request is reduced by the ladder, not rejected.
		const request = buildCompactionRequest(state());
		request.state = { recentEntries: ["z".repeat(200_000)], priorSummary: "" };
		enforceRequestBodyLimit(request);
		expect(() => validateRequest(request)).not.toThrow();
	});
});
