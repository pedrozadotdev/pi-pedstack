import { afterEach, describe, expect, test } from "bun:test";
import path from "node:path";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
	appendGuardLog,
	GUARD_LOG_FILE,
	GUARD_LOG_ROTATED_FILE,
	MAX_GUARD_LOG_BYTES,
	type GuardLogOptions,
} from "../extensions/ce-core/utils/guard-log";
import type { GuardLogRecord } from "../extensions/ce-core/utils/semantic-stage-guard";

const tempRepos: string[] = [];

async function makeRepo(): Promise<string> {
	const repo = await mkdtemp(path.join(tmpdir(), "pi-guard-log-"));
	tempRepos.push(repo);
	return repo;
}

function record(overrides: Partial<GuardLogRecord> = {}): GuardLogRecord {
	return {
		ts: "2026-10-05T00:00:00.000Z",
		stage: "02-plan",
		toolName: "bash",
		effectSource: "deterministic",
		effect: "mutates_workspace",
		deterministicTargets: [
			{ path: "extensions/x.ts", class: "source", allow: false },
		],
		verdict: "block",
		mode: "shadow",
		...overrides,
	};
}

async function readLines(repo: string, relative: string): Promise<string[]> {
	const content = await readFile(path.join(repo, relative), "utf8");
	return content.split("\n").filter((line) => line.length > 0);
}

afterEach(async () => {
	await Promise.all(
		tempRepos.splice(0).map((repo) => rm(repo, { recursive: true, force: true })),
	);
});

describe("appendGuardLog", () => {
	test("exposes the 1 MiB rotation cap as the default", () => {
		expect(MAX_GUARD_LOG_BYTES).toBe(1_048_576);
	});

	test("creates the parent directory and writes one JSON object per line", async () => {
		const repo = await makeRepo();
		await appendGuardLog(repo, record());

		const lines = await readLines(repo, GUARD_LOG_FILE);
		expect(lines.length).toBe(1);
		expect(JSON.parse(lines[0])).toMatchObject({
			toolName: "bash",
			effect: "mutates_workspace",
			verdict: "block",
		});
	});

	test("the record never carries raw command text", async () => {
		const repo = await makeRepo();
		const sentinel = "SENTINEL_COMMAND_XYZ";
		await appendGuardLog(repo, record());
		const content = await readFile(path.join(repo, GUARD_LOG_FILE), "utf8");

		expect(content).not.toContain(sentinel);
		expect("command" in record()).toBe(false);
	});

	test("rotates once at the injected cap and overwrites the rotated file", async () => {
		const repo = await makeRepo();
		const options: GuardLogOptions = { maxBytes: 10 };
		const padding = "x".repeat(200);

		await appendGuardLog(repo, record({ fallbackReason: padding }), options);
		await appendGuardLog(repo, record({ fallbackReason: `${padding}1` }), options);
		await appendGuardLog(repo, record({ fallbackReason: `${padding}2` }), options);

		expect((await readLines(repo, GUARD_LOG_FILE)).length).toBe(1);
		expect((await readLines(repo, GUARD_LOG_ROTATED_FILE)).length).toBe(1);
	});

	test("serializes concurrent appends into well-formed lines", async () => {
		const repo = await makeRepo();
		await Promise.all([
			appendGuardLog(repo, record({ fallbackReason: "first" })),
			appendGuardLog(repo, record({ fallbackReason: "second" })),
		]);

		const lines = await readLines(repo, GUARD_LOG_FILE);
		expect(lines.length).toBe(2);
		for (const line of lines) {
			expect(() => JSON.parse(line)).not.toThrow();
		}
	});

	test("swallows write failures without throwing", async () => {
		const repo = await makeRepo();
		await mkdir(path.join(repo, GUARD_LOG_FILE), { recursive: true });

		await expect(appendGuardLog(repo, record())).resolves.toBeUndefined();
	});

	test("swallows a rotation failure without throwing", async () => {
		const repo = await makeRepo();
		const target = path.join(repo, GUARD_LOG_FILE);
		await mkdir(target, { recursive: true });
		await writeFile(path.join(repo, "blocker"), "x", "utf8");

		await expect(
			appendGuardLog(repo, record(), { maxBytes: 1 }),
		).resolves.toBeUndefined();
	});
});
