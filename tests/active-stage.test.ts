import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import path from "node:path";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
	ACTIVE_STAGE_FILE,
	clearActiveStage,
	getActiveStage,
	persistActiveStage,
	readPersistedActiveStage,
	setActiveStage,
} from "../extensions/ce-core/utils/active-stage";

const CONTEXT_STATE_FILE = ".context/compound-engineering/context-state.json";

const tempRepos: string[] = [];

async function makeRepo(): Promise<string> {
	const repo = await mkdtemp(path.join(tmpdir(), "pi-active-stage-"));
	tempRepos.push(repo);
	return repo;
}

async function seedContextState(repo: string, value: unknown): Promise<void> {
	const file = path.join(repo, CONTEXT_STATE_FILE);
	await mkdir(path.dirname(file), { recursive: true });
	await writeFile(file, JSON.stringify(value), "utf8");
}

beforeEach(() => {
	clearActiveStage();
});

afterEach(async () => {
	clearActiveStage();
	await Promise.all(
		tempRepos.splice(0).map((repo) => rm(repo, { recursive: true, force: true })),
	);
});

// ── In-memory store ────────────────────────────────────────────────

describe("in-memory active stage", () => {
	test("round-trips set/get and clears with null", () => {
		expect(getActiveStage()).toBeNull();
		setActiveStage("03-work");
		expect(getActiveStage()).toBe("03-work");
		setActiveStage(null);
		expect(getActiveStage()).toBeNull();
	});

	test("clearActiveStage resets to null", () => {
		setActiveStage("05-learn");
		clearActiveStage();
		expect(getActiveStage()).toBeNull();
	});
});

// ── Persistence ────────────────────────────────────────────────────

describe("persistActiveStage", () => {
	test("writes active-stage.json and creates missing directories", async () => {
		const repo = await makeRepo();
		await persistActiveStage(repo, "02-plan");

		const raw = await readFile(path.join(repo, ACTIVE_STAGE_FILE), "utf8");
		const parsed = JSON.parse(raw);
		expect(parsed.activeStage).toBe("02-plan");
		expect(typeof parsed.updatedAt).toBe("string");
	});

	test("never creates a context-state.json", async () => {
		const repo = await makeRepo();
		await persistActiveStage(repo, "02-plan");
		await expect(
			readFile(path.join(repo, CONTEXT_STATE_FILE), "utf8"),
		).rejects.toThrow();
	});

	test("preserves an existing context-state.json untouched", async () => {
		const repo = await makeRepo();
		await seedContextState(repo, { currentStage: "02-plan", custom: "keep" });

		await persistActiveStage(repo, "03-work");

		const raw = await readFile(path.join(repo, CONTEXT_STATE_FILE), "utf8");
		expect(JSON.parse(raw)).toEqual({ currentStage: "02-plan", custom: "keep" });
	});

	test("rejects when the target directory cannot be created", async () => {
		const repo = await makeRepo();
		const blockingFile = path.join(repo, "not-a-dir");
		await writeFile(blockingFile, "x", "utf8");

		await expect(persistActiveStage(blockingFile, "03-work")).rejects.toThrow();
	});
});

// ── Persisted read (workflow-in-progress gate) ────────────────────

describe("readPersistedActiveStage", () => {
	test("returns the stage when a workflow is in progress", async () => {
		const repo = await makeRepo();
		await seedContextState(repo, { currentStage: "04-review" });
		await persistActiveStage(repo, "04-review");

		expect(await readPersistedActiveStage(repo)).toBe("04-review");
	});

	test("returns null when there is no context-state.json", async () => {
		const repo = await makeRepo();
		await persistActiveStage(repo, "03-work");

		expect(await readPersistedActiveStage(repo)).toBeNull();
	});

	test("returns null when context-state.json has no string currentStage", async () => {
		const repo = await makeRepo();
		await seedContextState(repo, { currentStage: 42 });
		await persistActiveStage(repo, "03-work");

		expect(await readPersistedActiveStage(repo)).toBeNull();
	});

	test("returns null for a corrupt context-state.json", async () => {
		const repo = await makeRepo();
		const file = path.join(repo, CONTEXT_STATE_FILE);
		await mkdir(path.dirname(file), { recursive: true });
		await writeFile(file, "{ not json", "utf8");
		await persistActiveStage(repo, "03-work");

		expect(await readPersistedActiveStage(repo)).toBeNull();
	});

	test("returns null for a corrupt active-stage.json", async () => {
		const repo = await makeRepo();
		await seedContextState(repo, { currentStage: "03-work" });
		const file = path.join(repo, ACTIVE_STAGE_FILE);
		await mkdir(path.dirname(file), { recursive: true });
		await writeFile(file, "{ not json", "utf8");

		expect(await readPersistedActiveStage(repo)).toBeNull();
	});

	test("returns null when active-stage.json is missing", async () => {
		const repo = await makeRepo();
		await seedContextState(repo, { currentStage: "03-work" });

		expect(await readPersistedActiveStage(repo)).toBeNull();
	});

	test("never throws for a missing repo root", async () => {
		const repo = path.join(tmpdir(), `pi-active-stage-missing-${Date.now()}`);
		expect(await readPersistedActiveStage(repo)).toBeNull();
	});
});
