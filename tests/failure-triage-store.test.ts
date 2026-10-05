import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
	persistTriage,
	readLatestTriage,
	readTriageHistory,
	type PersistedTriage,
} from "../extensions/ce-core/tools/triage-store";

const EXPECTED_FIELDS = [
	"ts",
	"command",
	"exitCode",
	"stage",
	"category",
	"confidence",
	"relatedToRecentChange",
	"rootCauseClarity",
	"source",
	"lowClarityStreak",
	"escalationSignal",
	"excerptBytes",
] as const;

function makeRecord(overrides: Partial<PersistedTriage> = {}): PersistedTriage {
	return {
		ts: "2026-02-14T00:00:00.000Z",
		command: "bun test",
		exitCode: 1,
		stage: "03-work",
		category: "test_fixture",
		confidence: 0.72,
		relatedToRecentChange: true,
		rootCauseClarity: 2,
		source: "jev",
		lowClarityStreak: 1,
		escalationSignal: false,
		excerptBytes: 128,
		...overrides,
	};
}

describe("failure-triage-store", () => {
	let repoRoot: string;

	beforeEach(async () => {
		repoRoot = await mkdtemp(path.join(os.tmpdir(), "triage-store-"));
	});

	test("persistTriage writes latest.json with all fields and round-trips", async () => {
		const record = makeRecord();
		await persistTriage(repoRoot, record);

		const raw = await readFile(
			path.join(repoRoot, ".context", "compound-engineering", "triage", "latest.json"),
			"utf8",
		);
		const parsed = JSON.parse(raw) as PersistedTriage;
		expect(Object.keys(parsed).sort()).toEqual([...EXPECTED_FIELDS].sort());

		const latest = await readLatestTriage(repoRoot);
		expect(latest).toEqual(record);
	});

	test("caps history at 50 entries and keeps the newest", async () => {
		const dir = path.join(repoRoot, ".context", "compound-engineering", "triage");
		for (let index = 1; index <= 51; index++) {
			await persistTriage(
				repoRoot,
				makeRecord({ command: `bun test run ${index}` }),
			);
		}

		const raw = await readFile(path.join(dir, "history.jsonl"), "utf8");
		const lines = raw.split("\n").filter((line) => line.trim().length > 0);
		expect(lines.length).toBeLessThanOrEqual(50);

		const history = await readTriageHistory(repoRoot);
		expect(history.length).toBeLessThanOrEqual(50);
		expect(history.at(-1)?.command).toBe("bun test run 51");
	});

	test("readLatestTriage returns null when the directory is missing", async () => {
		expect(await readLatestTriage(repoRoot)).toBeNull();
	});

	test("readLatestTriage returns null for corrupt JSON", async () => {
		const dir = path.join(repoRoot, ".context", "compound-engineering", "triage");
		await mkdir(dir, { recursive: true });
		await writeFile(path.join(dir, "latest.json"), "{not json", "utf8");

		expect(await readLatestTriage(repoRoot)).toBeNull();
	});

	test("readTriageHistory skips a corrupt line and keeps valid entries", async () => {
		const dir = path.join(repoRoot, ".context", "compound-engineering", "triage");
		await mkdir(dir, { recursive: true });
		const first = JSON.stringify(makeRecord({ command: "bun test 1" }));
		const last = JSON.stringify(makeRecord({ command: "bun test 2" }));
		await writeFile(
			path.join(dir, "history.jsonl"),
			`${first}\n{not json\n${last}\n`,
			"utf8",
		);

		const history = await readTriageHistory(repoRoot);
		expect(history.map((entry) => entry.command)).toEqual([
			"bun test 1",
			"bun test 2",
		]);
	});
});
