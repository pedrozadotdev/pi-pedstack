// Composer + shadow log (plan Unit 5). The composer resolves the baseline
// first and never touches git or the filesystem in `off`/no-baseline paths.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { composeOverengineeringSignal } from "../extensions/ce-core/overengineering/compose.js";
import {
	appendOverengineeringShadow,
	OVERENGINEERING_LOG_FILE,
} from "../extensions/ce-core/overengineering/shadow-log.js";
import type { OverengineeringLogRecord } from "../extensions/ce-core/overengineering/types.js";

let root: string;

async function write(rel: string, content: string): Promise<void> {
	const abs = path.join(root, rel);
	await fs.mkdir(path.dirname(abs), { recursive: true });
	await fs.writeFile(abs, content);
}

const PATCH = [
	"diff --git a/src/a.ts b/src/a.ts",
	"+++ b/src/a.ts",
	"@@ -0,0 +1 @@",
	'+export const a = 1;',
].join("\n");

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "overengineering-compose-"));
});

afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

describe("overengineering compose (Unit 5)", () => {

	test("off performs no git call and no file read", async () => {
		let gitCalls = 0;
		let reads = 0;
		const result = await composeOverengineeringSignal({
			repoRoot: root,
			stage: "02-plan",
			mode: "off",
			runGit: async () => {
				gitCalls++;
				return "";
			},
			readFile: async () => {
				reads++;
				return "";
			},
		});
		expect(result.status).toBe("unavailable");
		expect(result.reason).toBe("no_baseline");
		expect(gitCalls).toBe(0);
		expect(reads).toBe(0);
	});

	test("a missing baseline short-circuits before any git call", async () => {
		let gitCalls = 0;
		const result = await composeOverengineeringSignal({
			repoRoot: root,
			stage: "02-plan",
			mode: "shadow",
			runGit: async () => {
				gitCalls++;
				return "";
			},
		});
		expect(result.status).toBe("unavailable");
		expect(gitCalls).toBe(0);
	});

	test("a ready signal carries baselines, hash, and sorted facts", async () => {
		await write("docs/brainstorms/req.md", "requirements body");
		await write("docs/plans/plan.md", "plan body");
		await write("package.json", "{}");
		const result = await composeOverengineeringSignal({
			repoRoot: root,
			stage: "04-review",
			mode: "shadow",
			runGit: async () => PATCH,
		});
		expect(result.status).toBe("ready");
		expect(result.baselines.requirements?.text).toBe("requirements body");
		expect(result.baselines.plan?.text).toBe("plan body");
		expect(result.baselinePaths).toEqual([
			"docs/brainstorms/req.md",
			"docs/plans/plan.md",
		]);
		expect(result.baselineHash.length).toBeGreaterThan(0);
		expect(result.facts.addedFiles).toEqual(["src/a.ts"]);
		expect(result.facts.diffExcerpt).toContain("diff --git");
		expect(result.skippedDimensions).toEqual([]);
	});

	test("one skipped dimension keeps the signal ready", async () => {
		await write("docs/brainstorms/req.md", "requirements body");
		const result = await composeOverengineeringSignal({
			repoRoot: root,
			stage: "02-plan",
			mode: "shadow",
			runGit: async () => PATCH,
		});
		expect(result.status).toBe("ready");
		expect(result.skippedDimensions).toEqual([
			{ dimension: "dependency_justification", reason: "package_json_unreadable" },
		]);
	});

	test("a git failure skips all four dims and yields unavailable", async () => {
		await write("docs/plans/plan.md", "plan body");
		const result = await composeOverengineeringSignal({
			repoRoot: root,
			stage: "03-work",
			mode: "enforce",
			runGit: async () => {
				throw new Error("git boom");
			},
		});
		expect(result.status).toBe("unavailable");
		expect(result.skippedDimensions).toHaveLength(4);
	});

	test("the shadow log trims to the most recent 200 lines", async () => {
		const record = (index: number): OverengineeringLogRecord => ({
			ts: `t${index}`,
			stage: "03-work",
			mode: "shadow",
			source: "jev",
			baselinePaths: [],
			baselineHash: "h",
			dimensions: [],
			skippedDimensions: [],
			verdict: "accept",
		});
		for (let index = 0; index < 205; index++) {
			await appendOverengineeringShadow(root, record(index));
		}
		const raw = await fs.readFile(path.join(root, OVERENGINEERING_LOG_FILE), "utf8");
		const lines = raw.split("\n").filter((line) => line.length > 0);
		expect(lines).toHaveLength(200);
		expect(JSON.parse(lines[0]).ts).toBe("t5");
		expect(JSON.parse(lines[199]).ts).toBe("t204");
	});

	test("the shadow log never rejects on an unwritable root", async () => {
		await expect(
			appendOverengineeringShadow("/proc/definitely-not-writable", {
				ts: "t",
				stage: "03-work",
				mode: "shadow",
				source: "unavailable",
				baselinePaths: [],
				baselineHash: "",
				dimensions: [],
				skippedDimensions: [],
				verdict: "accept",
			}),
		).resolves.toBeUndefined();
	});
});
