// Unit 7 — compaction-guard vocabulary and operator docs.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");

function read(rel: string): string {
	return readFileSync(path.join(repoRoot, rel), "utf8");
}

describe("Unit 7 — AGENTS.md", () => {
	test("names the module, mode, and live switches", () => {
		const agents = read("AGENTS.md");
		expect(agents).toContain("extensions/ce-core/compaction-guard/");
		expect(agents).toContain("features.compactionGuard.mode");
		expect(agents).toContain("features.compactionGuard.live");
	});

	test("documents the fail-open and shadow-first defaults", () => {
		const agents = read("AGENTS.md");
		expect(agents).toContain("fail open");
		expect(agents).toContain("shadow");
	});
});

describe("Unit 7 — CONTEXT.md vocabulary", () => {
	test("defines the compaction tier, trigger/overage, episode, and bridge", () => {
		const context = read("CONTEXT.md");
		expect(context).toContain("## Semantic compaction (#11)");
		for (const term of [
			"Compaction tier",
			"Trigger tokens",
			"Overage tokens",
			"Threshold episode",
			"Compaction health bridge",
			"Good boundary",
			"Defer budget",
		]) {
			expect(context).toContain(term);
		}
	});
});

describe("Unit 7 — README operator surface", () => {
	test("documents the mode, live opt-in, log, and calibration gate", () => {
		const readme = read("README.md");
		expect(readme).toContain("features.compactionGuard.mode");
		expect(readme).toContain("features.compactionGuard.live");
		expect(readme).toContain('"off" | "shadow" | "enforce"');
		expect(readme).toContain("compaction-guard.jsonl");
		expect(readme).toContain("calibrate");
	});

	test("does not claim a fail-closed knob", () => {
		expect(read("README.md")).not.toContain("features.compactionGuard.failClosed");
		expect(read("AGENTS.md")).not.toContain(
			"features.compactionGuard.failClosed",
		);
	});
});
