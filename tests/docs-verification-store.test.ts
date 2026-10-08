// Docs verification — record store, freshness, carry-over, mode (plan Unit 4).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { THRESHOLDS_VERSION } from "../extensions/ce-core/docs-verification/combine.js";
import {
	DOCS_LOG_FILE,
	DOCS_LOG_ROTATED_FILE,
	DOCS_VERIFICATION_DIR,
	MAX_DOCS_LOG_BYTES,
	appendDocsLog,
	carryOverObligations,
	docsRecordPath,
	isRecordFresh,
	isUnitFresh,
	planSlugFromPath,
	readDocsRecord,
	writeDocsRecord,
} from "../extensions/ce-core/docs-verification/store.js";
import type {
	DocsObligation,
	DocsUnitRecord,
	DocsVerificationRecord,
	UnitFacts,
} from "../extensions/ce-core/docs-verification/types.js";

let root: string;

const PLAN = "docs/plans/2026-10-06-example.md";

function facts(over: Partial<UnitFacts> = {}): UnitFacts {
	return {
		phase: "planned",
		declaredFiles: [],
		packages: [],
		evidence: [],
		versionUnknown: false,
		...over,
	};
}

function obligation(over: Partial<DocsObligation> = {}): DocsObligation {
	return {
		slug: "frozen-types",
		status: "open",
		decision: "required",
		packages: ["typebox"],
		source: "jev",
		updatedAt: "2026-10-06T00:00:00.000Z",
		...over,
	};
}

function unitRecord(over: Partial<DocsUnitRecord> = {}): DocsUnitRecord {
	return {
		slug: "frozen-types",
		hash: "h1",
		phase: "planned",
		facts: facts(),
		decision: "required",
		packages: ["typebox"],
		source: "jev",
		...over,
	};
}

function record(over: Partial<DocsVerificationRecord> = {}): DocsVerificationRecord {
	return {
		schema: 1,
		planPath: PLAN,
		grammar: 1,
		activePhase: "planned",
		thresholdsVersion: THRESHOLDS_VERSION,
		units: [unitRecord()],
		droppedUnits: [],
		updatedAt: "2026-10-06T00:00:00.000Z",
		...over,
	};
}

async function writeRaw(rel: string, content: string): Promise<void> {
	const abs = path.join(root, rel);
	await fs.mkdir(path.dirname(abs), { recursive: true });
	await fs.writeFile(abs, content, "utf8");
}

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "docs-verification-"));
});

afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true });
});


describe("Unit 4 — paths and round trip", () => {
	test("derives a stable slug from the plan basename", () => {
		expect(planSlugFromPath(PLAN)).toBe("2026-10-06-example");
		expect(planSlugFromPath("../../etc/passwd")).toBe("passwd");
		expect(docsRecordPath(root, "2026-10-06-example")).toBe(
			path.join(root, DOCS_VERIFICATION_DIR, "2026-10-06-example.json"),
		);
	});

	test("writes then reads the record back", async () => {
		const written = await writeDocsRecord(root, record());
		expect(written).toBe(docsRecordPath(root, "2026-10-06-example"));
		expect(await readDocsRecord(root, "2026-10-06-example")).toEqual(
			record() as never,
		);
	});

	test("a missing record reads as null", async () => {
		expect(await readDocsRecord(root, "2026-10-06-example")).toBeNull();
	});

	test("corrupt or malformed records read as null", async () => {
		const file = path.join(root, DOCS_VERIFICATION_DIR, "2026-10-06-example.json");
		const invalid: unknown[] = [
			"{corrupt",
			record({ schema: 2 as unknown as 1 }),
			record({ grammar: 2 as unknown as 1 }),
			record({ activePhase: "whenever" as unknown as "planned" }),
			record({ units: [{ slug: "x" }] as unknown as DocsUnitRecord[] }),
			record({ units: "no" as unknown as DocsUnitRecord[] }),
			{ schema: 1, planPath: PLAN },
		];
		for (const value of invalid) {
			const content = typeof value === "string" ? value : JSON.stringify(value);
			await writeRaw(`${DOCS_VERIFICATION_DIR}/2026-10-06-example.json`, content);
			const result = await readDocsRecord(root, "2026-10-06-example");
			expect(result).toBeNull();
		}
	});
});

describe("Unit 4 — freshness", () => {
	const expected = {
		planPath: PLAN,
		activePhase: "planned" as const,
		slug: "frozen-types",
		hash: "h1",
	};

	test("fresh only when every field matches and provenance is Jev", () => {
		expect(isUnitFresh(record(), expected)).toBe(true);
		expect(isUnitFresh(record(), { ...expected, hash: "other" })).toBe(false);
		expect(isUnitFresh(record(), { ...expected, slug: "missing" })).toBe(false);
		expect(isUnitFresh(record(), { ...expected, planPath: "other.md" })).toBe(false);
		expect(
			isUnitFresh(record(), { ...expected, activePhase: "observed" }),
		).toBe(false);
		expect(
			isUnitFresh(record({ thresholdsVersion: THRESHOLDS_VERSION + 1 }), expected),
		).toBe(false);
		expect(isUnitFresh(null, expected)).toBe(false);
	});

	test("a degraded per-unit source is never fresh", () => {
		const degraded = record({
			units: [unitRecord({ source: "degraded" })],
			// record-level source is not the freshness input; the unit's is.
		});
		expect(isUnitFresh(degraded, expected)).toBe(false);
	});

	test("isRecordFresh composes isUnitFresh over every unit", () => {
		const freshMap = new Map([["frozen-types", "h1"]]);
		expect(
			isRecordFresh(record(), {
				planPath: PLAN,
				activePhase: "planned",
				unitHashes: freshMap,
			}),
		).toBe(true);
		expect(
			isRecordFresh(record(), {
				planPath: PLAN,
				activePhase: "planned",
				unitHashes: new Map([["frozen-types", "stale"]]),
			}),
		).toBe(false);
		expect(
			isRecordFresh(record(), {
				planPath: PLAN,
				activePhase: "planned",
				unitHashes: new Map(),
			}),
		).toBe(false);
		expect(
			isRecordFresh(record({ units: [] }), {
				planPath: PLAN,
				activePhase: "planned",
				unitHashes: freshMap,
			}),
		).toBe(false);
	});
});

describe("Unit 4 — carry-over", () => {
	test("a satisfied obligation is retained only while its package remains", () => {
		const evidence = [
			{ package: "typebox", version: "1.0.0", docRef: "docs/typebox.md", valid: true },
		];
		const previous = record({
			units: [
				unitRecord({
					facts: facts({ evidence }),
					obligation: obligation({ status: "satisfied", source: "fallback" }),
				}),
			],
		});
		const retained = carryOverObligations(
			previous,
			record({ units: [unitRecord({ facts: facts({ evidence }) })] }),
		);
		expect(retained.units[0].obligation?.status).toBe("satisfied");
		const moved = carryOverObligations(
			previous,
			record({
				units: [
					unitRecord({ packages: ["other"], facts: facts({ evidence }) }),
				],
			}),
		);
		expect(moved.units[0].obligation).toBeUndefined();
	});

	test("a waived obligation carries over but re-opens when the hash changes", () => {
		const previous = record({
			units: [unitRecord({ obligation: obligation({ status: "waived" }) })],
		});
		const same = carryOverObligations(previous, record());
		expect(same.units[0].obligation?.status).toBe("waived");
		const changed = carryOverObligations(
			previous,
			record({ units: [unitRecord({ hash: "h2" })] }),
		);
		expect(changed.units[0].obligation?.status).toBe("open");
	});

	test("vanished units land in droppedUnits with a reason", () => {
		const previous = record({
			units: [unitRecord({ slug: "gone", obligation: obligation({ slug: "gone" }) })],
		});
		const merged = carryOverObligations(previous, record());
		expect(merged.droppedUnits).toEqual([
			{ slug: "gone", reason: "unit no longer present in the plan" },
		]);
	});

	test("no previous record leaves the next record untouched", () => {
		const next = record();
		expect(carryOverObligations(null, next)).toEqual(next as never);
	});
});

describe("Unit 4 — shadow log", () => {
	test("appends one JSON line and rotates at the cap", async () => {
		await appendDocsLog(root, record());
		const lines = (await fs.readFile(path.join(root, DOCS_LOG_FILE), "utf8"))
			.trim()
			.split("\n");
		expect(lines).toHaveLength(1);

		await writeRaw(DOCS_LOG_FILE, "x".repeat(MAX_DOCS_LOG_BYTES));
		await appendDocsLog(root, record());
		const rotated = await fs.readFile(
			path.join(root, DOCS_LOG_ROTATED_FILE),
			"utf8",
		);
		expect(rotated).toHaveLength(MAX_DOCS_LOG_BYTES);
	});

	test("swallows an append failure", async () => {
		await fs.mkdir(path.join(root, DOCS_LOG_FILE), { recursive: true });
		await expect(appendDocsLog(root, record())).resolves.toBeUndefined();
	});
});
