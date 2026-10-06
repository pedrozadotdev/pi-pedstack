import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	readRoutingRecord,
	routingRecordPath,
	writeRoutingRecord,
	type RoutingRecord,
} from "../extensions/ce-core/utils/routing-store";

const tempRoots: string[] = [];

function makeTempRoot(): string {
	const root = mkdtempSync(path.join(tmpdir(), "pi-routing-store-"));
	tempRoots.push(root);
	return root;
}

function sampleRecord(overrides: Partial<RoutingRecord> = {}): RoutingRecord {
	return {
		schema: 1,
		stage: "03-work",
		role: "sota",
		reason: "jev",
		source: "jev",
		scores: {
			complexity: 1,
			risk: 0.5,
			cross_cutting: 0.5,
			deep_reasoning: 0,
			ambiguity: 1,
		},
		weighted: 0.6,
		confidence: 0.6,
		attempts: 2,
		escalations: 1,
		revisions: 2,
		reviews: 1,
		updatedAt: "2026-10-06T00:00:00.000Z",
		...overrides,
	};
}

function rawRecordPath(repoRoot: string, stage: string, text: string): void {
	const file = routingRecordPath(repoRoot, stage);
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, text, "utf8");
}

afterEach(() => {
	for (const root of tempRoots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe("routing-store", () => {
	test("routes records to .context/compound-engineering/routing/<stage>.json", () => {
		const repoRoot = "/repo";
		expect(routingRecordPath(repoRoot, "03-work")).toBe(
			path.join(
				repoRoot,
				".context",
				"compound-engineering",
				"routing",
				"03-work.json",
			),
		);
	});

	test("round-trips a full record including scores", async () => {
		const repoRoot = makeTempRoot();
		const record = sampleRecord();

		const written = await writeRoutingRecord(repoRoot, record);
		expect(written).toBe(routingRecordPath(repoRoot, "03-work"));

		const read = await readRoutingRecord(repoRoot, "03-work");
		expect(read).toEqual(record);
	});

	test("write creates the parent directory", async () => {
		const repoRoot = makeTempRoot();

		await writeRoutingRecord(repoRoot, sampleRecord({ stage: "04-review" }));

		const read = await readRoutingRecord(repoRoot, "04-review");
		expect(read?.stage).toBe("04-review");
	});

	test("returns null for a missing record", async () => {
		const repoRoot = makeTempRoot();
		expect(await readRoutingRecord(repoRoot, "03-work")).toBeNull();
	});

	test("returns null for a corrupt/non-JSON file", async () => {
		const repoRoot = makeTempRoot();
		rawRecordPath(repoRoot, "03-work", "{ not json");
		expect(await readRoutingRecord(repoRoot, "03-work")).toBeNull();
	});

	test("returns null for a JSON file with the wrong shape", async () => {
		const repoRoot = makeTempRoot();
		rawRecordPath(repoRoot, "03-work", JSON.stringify(["not", "a", "record"]));
		expect(await readRoutingRecord(repoRoot, "03-work")).toBeNull();

		rawRecordPath(
			repoRoot,
			"03-work",
			JSON.stringify({ schema: 2, stage: "03-work" }),
		);
		expect(await readRoutingRecord(repoRoot, "03-work")).toBeNull();
	});

	test("defaults missing revisions and reviews to 0 for a legacy record", async () => {
		const repoRoot = makeTempRoot();
		const { revisions: _revisions, reviews: _reviews, ...legacy } = sampleRecord();
		rawRecordPath(repoRoot, "03-work", JSON.stringify(legacy));

		const read = await readRoutingRecord(repoRoot, "03-work");
		expect(read?.revisions).toBe(0);
		expect(read?.reviews).toBe(0);
	});
});
