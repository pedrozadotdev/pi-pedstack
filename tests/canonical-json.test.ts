// Unit 1 — canonical JSON + hash helpers shared by handoff-readiness and drift.
import { describe, expect, test } from "bun:test";
import {
	sha256ShortHex,
	stableStringify,
} from "../extensions/ce-core/utils/canonical-json";
import {
	canonicalizeState,
	hashCanonical,
	normalizeState,
} from "../extensions/ce-core/handoff-readiness/combine";
import type { ReadinessState } from "../extensions/ce-core/handoff-readiness/types";

describe("stableStringify", () => {
	test("sorts object keys at every depth", () => {
		expect(stableStringify({ b: 1, a: { d: 2, c: 3 } })).toBe(
			'{"a":{"c":3,"d":2},"b":1}',
		);
	});

	test("is order-insensitive for object literals", () => {
		expect(stableStringify({ a: 1, b: 2 })).toBe(
			stableStringify({ b: 2, a: 1 }),
		);
	});

	test("preserves array order", () => {
		expect(stableStringify([2, 1, 3])).toBe("[2,1,3]");
	});

	test("keeps null and primitives intact", () => {
		expect(stableStringify(null)).toBe("null");
		expect(stableStringify("x")).toBe('"x"');
		expect(stableStringify(7)).toBe("7");
	});
});

describe("sha256ShortHex", () => {
	test("is deterministic and 16 hex chars", () => {
		const first = sha256ShortHex("hello");
		expect(first).toBe(sha256ShortHex("hello"));
		expect(first).toHaveLength(16);
		expect(first).toMatch(/^[0-9a-f]{16}$/);
		expect(first).not.toBe(sha256ShortHex("world"));
	});
});

// Fixture mirrors the pre-extraction hash probe; the pinned value guards the
// extraction from silently changing persisted hashes.
const FIXTURE_STATE: ReadinessState = {
	currentStage: "02-plan",
	nextStage: "03-work",
	handoffMarkdown: "# H\n\n## Current Task\nDo a thing\n",
	currentTask: "Do a thing",
	nextMinimalStep: "create src/a.ts",
	verification: "bun test",
	blocker: "",
	openDecisions: ["one"],
	currentTruth: ["truth"],
	invalidatedAssumptions: [],
	activeFiles: ["extensions/ce-core/index.ts"],
	recentlyAccessedFiles: [],
	artifacts: { plan: "docs/plans/x.md" },
	activeRules: ["rule"],
};

describe("canonicalizeState / hashCanonical wrappers", () => {
	test("hash stays byte-identical after the shared-helper extraction", () => {
		expect(hashCanonical(canonicalizeState(normalizeState(FIXTURE_STATE)))).toBe(
			"5fffbd8baf04c6ab",
		);
	});

	test("stableStringify equals canonicalizeState for a plain object", () => {
		expect(canonicalizeState(FIXTURE_STATE)).toBe(
			stableStringify(FIXTURE_STATE),
		);
	});
});
