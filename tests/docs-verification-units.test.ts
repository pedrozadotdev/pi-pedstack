// Docs verification — unit extraction, identity, evidence grammar (plan Unit 1).
import { describe, expect, test } from "bun:test";
import {
	extractUnits,
	parseDeclaredFiles,
	parseEvidenceLines,
	parsePlannedPackages,
	unitContentHash,
	validateEvidenceLine,
} from "../extensions/ce-core/docs-verification/units.js";
import type {
	DocsUnit,
	EvidenceFact,
	PackageFact,
	UnitFacts,
} from "../extensions/ce-core/docs-verification/types.js";

const PLAN = [
	"# Plan: Example",
	"",
	"### Unit 1 — Frozen types",
	"",
	"**Goal.** Define types.",
	"",
	"**Files.**",
	"",
	"- create `extensions/ce-core/docs-verification/types.ts`",
	"- create `tests/docs-verification-units.test.ts`",
	"",
	"**Dependencies.** None.",
	"",
	"### Unit 2 — Parser helpers",
	"",
	"**Files.**",
	"",
	"- create `extensions/ce-core/docs-verification/units.ts`",
	"",
	"### Unit 3 — Frozen types",
	"",
	"**Goal.** A duplicate heading, distinct identity.",
	"",
].join("\n");

function unit(over: Partial<DocsUnit> = {}): DocsUnit {
	return {
		slug: "frozen-types",
		heading: "Unit 1 — Frozen types",
		hash: "seed",
		files: ["a.ts", "b.ts"],
		text: "### Unit 1 — Frozen types\n\nbody one",
		...over,
	};
}

function facts(over: Partial<UnitFacts> = {}): UnitFacts {
	return {
		phase: "planned",
		declaredFiles: [],
		packages: [
			{ name: "typebox", version: "1.0.3", versionUnknown: false, kind: "peer" },
		],
		evidence: [],
		versionUnknown: false,
		...over,
	};
}

describe("Unit 1 — extractUnits", () => {
	test("extracts one entry per Unit block in order", () => {
		const units = extractUnits(PLAN, "planned");
		expect(units).toHaveLength(3);
		expect(units[0].heading).toBe("Unit 1 — Frozen types");
		expect(units[1].heading).toBe("Unit 2 — Parser helpers");
		expect(units[2].heading).toBe("Unit 3 — Frozen types");
		expect(units[0].files).toEqual([
			"extensions/ce-core/docs-verification/types.ts",
			"tests/docs-verification-units.test.ts",
		]);
		expect(units[1].files).toEqual([
			"extensions/ce-core/docs-verification/units.ts",
		]);
	});

	test("returns zero entries when there is no Unit block", () => {
		expect(extractUnits("# Plan\n\nno units", "planned")).toEqual([]);
	});

	test("tolerates CRLF input", () => {
		const units = extractUnits(PLAN.replace(/\n/g, "\r\n"), "planned");
		expect(units).toHaveLength(3);
		expect(units[0].files).toHaveLength(2);
	});

	test("normalizes a heading to a stable slug", () => {
		expect(extractUnits(PLAN, "planned")[0].slug).toBe("frozen-types");
	});

	test("slug is stable across whitespace-only heading edits", () => {
		const a = extractUnits("### Unit 1 — Frozen types\nbody", "planned")[0];
		const b = extractUnits("###  Unit  1  —  Frozen   types \nbody", "planned")[0];
		expect(a.slug).toBe(b.slug);
	});

	test("duplicate headings produce distinct slugs", () => {
		const units = extractUnits(PLAN, "planned");
		expect(units[0].slug).not.toBe(units[2].slug);
		expect(units[2].slug).toBe("frozen-types-2");
	});

	test("a unit with no Files line yields no declared files", () => {
		const units = extractUnits("# P\n\n### Unit 9 — Nothing\n\nbody\n", "planned");
		expect(units[0].files).toEqual([]);
		expect(parseDeclaredFiles(units[0].text)).toEqual([]);
	});
});

describe("Unit 1 — parsePlannedPackages", () => {
	test("extracts literal package names, deduped and sorted", () => {
		const text =
			"Use `typebox` and `@earendil-works/pi-coding-agent` then `typebox` again.";
		expect(parsePlannedPackages(text)).toEqual([
			"@earendil-works/pi-coding-agent",
			"typebox",
		]);
	});

	test("ignores paths, commands, and stage keys", () => {
		const text =
			"Run `bun test`; see `docs/page.md` and stage `03-work` with `github`.";
		expect(parsePlannedPackages(text)).toEqual([]);
	});
});

describe("Unit 1 — unitContentHash", () => {
	test("is stable when nothing changes", () => {
		const u = unit();
		expect(unitContentHash(u, facts())).toBe(unitContentHash(unit(), facts()));
	});

	test("changes when the block text changes", () => {
		const base = unitContentHash(unit(), facts());
		expect(unitContentHash(unit({ text: "different" }), facts())).not.toBe(base);
	});

	test("changes when the declared Files list changes", () => {
		const base = unitContentHash(unit(), facts());
		expect(
			unitContentHash(unit({ files: ["a.ts", "b.ts", "c.ts"] }), facts()),
		).not.toBe(base);
	});

	test("changes when a package@version fact changes", () => {
		const base = unitContentHash(unit(), facts());
		const bumped = facts({
			packages: [
				{ name: "typebox", version: "2.0.0", versionUnknown: false, kind: "peer" },
			],
		});
		expect(unitContentHash(unit(), bumped)).not.toBe(base);
	});

	test("changes when an evidence line changes", () => {
		const base = unitContentHash(unit(), facts());
		const withEvidence = facts({
			evidence: [
				{ package: "typebox", version: "1.0.3", docRef: "docs/typebox.md", valid: true },
			],
		});
		expect(unitContentHash(unit(), withEvidence)).not.toBe(base);
	});

	test("observed phase changes when a declared file's content hash changes", () => {
		const observed = facts({ phase: "observed" });
		const base = unitContentHash(unit(), observed);
		const changed = unitContentHash(
			unit(),
			observed,
			new Map([["a.ts", "deadbeef"]]),
		);
		expect(changed).not.toBe(base);
	});
});

describe("Unit 1 — evidence grammar", () => {
	const resolved: PackageFact = {
		name: "typebox",
		version: "1.0.3",
		versionUnknown: false,
		kind: "peer",
	};

	test("accepts a matching package and version", () => {
		const result = validateEvidenceLine(
			"docs-verified: typebox@1.0.3 docs/typebox.md",
			resolved,
		);
		expect(result).toEqual({
			package: "typebox",
			version: "1.0.3",
			docRef: "docs/typebox.md",
			valid: true,
		});
	});

	test("accepts a documentation URL as evidence", () => {
		const url = "https://example.org/docs/typebox/1.0.3";
		expect(validateEvidenceLine(`docs-verified: typebox@1.0.3 ${url}`, resolved)).toEqual({
			package: "typebox", version: "1.0.3", docRef: url, valid: true,
		});
	});

	test("rejects a package mismatch", () => {
		expect(
			validateEvidenceLine("docs-verified: react@18.0.0 docs/react.md", resolved),
		).toBeNull();
	});

	test("rejects a version mismatch", () => {
		expect(
			validateEvidenceLine("docs-verified: typebox@9.9.9 docs/typebox.md", resolved),
		).toBeNull();
	});

	test("rejects a malformed line", () => {
		expect(validateEvidenceLine("verified: typebox@1.0.3", resolved)).toBeNull();
		expect(
			validateEvidenceLine("docs-verified: typebox@1.0.3", resolved),
		).toBeNull();
		expect(
			validateEvidenceLine("docs-verified: typebox@1.0.3 docs/typebox.md extra", resolved),
		).toBeNull();
	});

	test("accepts pkg@unknown only when the fact is version-unknown", () => {
		const unknown: PackageFact = {
			name: "typebox",
			version: null,
			versionUnknown: true,
			kind: "dependency",
		};
		expect(
			validateEvidenceLine("docs-verified: typebox@unknown docs/typebox.md", unknown),
		).toEqual({
			package: "typebox",
			version: "unknown",
			docRef: "docs/typebox.md",
			valid: true,
		});
		expect(
			validateEvidenceLine("docs-verified: typebox@unknown docs/typebox.md", resolved),
		).toBeNull();
	});

	test("accepts the manifest range when the fact is range-only", () => {
		const range: PackageFact = {
			name: "typebox",
			version: "^1.0.0",
			versionUnknown: true,
			kind: "peer",
		};
		expect(
			validateEvidenceLine("docs-verified: typebox@^1.0.0 docs/typebox.md", range),
		).not.toBeNull();
	});

	test("parseEvidenceLines finds only docs-verified lines", () => {
		const text = [
			"Intro",
			"docs-verified: typebox@1.0.3 docs/typebox.md",
			"other",
			"  docs-verified: left-pad@1.0.0 docs/left-pad.md  ",
		].join("\n");
		const lines = parseEvidenceLines(text);
		expect(lines).toEqual([
			"docs-verified: typebox@1.0.3 docs/typebox.md",
			"docs-verified: left-pad@1.0.0 docs/left-pad.md",
		]);
	});
});

describe("Unit 1 — hash invalidation on evidence add/remove", () => {
	test("adding then removing the evidence line returns to the base hash", () => {
		const base = unitContentHash(unit(), facts());
		const evidence: EvidenceFact[] = [
			{ package: "typebox", version: "1.0.3", docRef: "docs/typebox.md", valid: true },
		];
		const added = unitContentHash(unit(), facts({ evidence }));
		expect(added).not.toBe(base);
		expect(unitContentHash(unit(), facts({ evidence: [] }))).toBe(base);
	});
});
