// Unit 5 — contextHandoff.contextHealth defaults from the injected live
// provider only when the caller omits it; an explicit value always wins.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
	COMPACTION_LOG_FILE,
	appendHealthDegradedLog,
	captureContextSnapshot,
	clearContextSnapshot,
	getCurrentContextHealth,
	resetAllSessionState,
	resetEpisode,
	setCurrentCompactionSessionKey,
} from "../extensions/ce-core/compaction-guard/store.js";
import { createContextHandoffTool } from "../extensions/ce-core/tools/context-handoff.js";
import type { ContextHealth } from "../extensions/ce-core/compaction-guard/types.js";

let root: string;

function tool() {
	return createContextHandoffTool({
		health: {
			read: () => getCurrentContextHealth(),
			logDegraded: appendHealthDegradedLog,
		},
	});
}

async function save(input: Record<string, unknown> = {}) {
	return tool().execute({
		operation: "save",
		repoRoot: root,
		currentStage: "03-work",
		nextStage: "04-review",
		activeFiles: ["extensions/ce-core/compaction-guard/guard.ts"],
		verification: "bun test",
		...input,
	} as never);
}

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "compaction-provider-"));
	resetAllSessionState();
	clearContextSnapshot();
	setCurrentCompactionSessionKey("");
});

afterEach(async () => {
	resetAllSessionState();
	clearContextSnapshot();
	setCurrentCompactionSessionKey("");
	await fs.rm(root, { recursive: true, force: true });
});

describe("contextHealth precedence", () => {
	test("an explicit caller value always wins over the provider", async () => {
		captureContextSnapshot({ tokens: 80_000, contextWindow: 100_000 });
		const result = await save({ contextHealth: "good" });
		expect(result.contextHealth).toBe("good");
		const loaded = await tool().execute({ operation: "load", repoRoot: root });
		expect(loaded.contextHealth).toBe("good");
	});

	test("an omitted value is derived from the provider for each tier", async () => {
		const cases: Array<[number, ContextHealth]> = [
			[0.1, "good"],
			[0.65, "watch"],
			[0.8, "heavy"],
			[0.95, "critical"],
		];
		for (const [pressure, expected] of cases) {
			captureContextSnapshot({
				tokens: pressure * 100_000,
				contextWindow: 100_000,
			});
			const result = await save();
			expect(result.contextHealth).toBe(expected);
		}
	});

	test("no snapshot keeps the existing watch default", async () => {
		const result = await save();
		expect(result.contextHealth).toBe("watch");
	});

	test("a null token read after a recent compaction gives good", async () => {
		setCurrentCompactionSessionKey("sid");
		captureContextSnapshot({
			tokens: null,
			contextWindow: 100_000,
			now: new Date("2026-10-06T00:00:00.000Z"),
		});
		resetEpisode("sid", new Date("2026-10-06T00:00:01.000Z"));
		const result = await save();
		expect(result.contextHealth).toBe("good");
	});

	test("an unexplained null gives watch plus a degraded log entry", async () => {
		captureContextSnapshot({ tokens: null, contextWindow: 100_000 });
		const result = await save();
		expect(result.contextHealth).toBe("watch");
		const log = await fs.readFile(path.join(root, COMPACTION_LOG_FILE), "utf8");
		const lines = log.trim().split("\n").filter(Boolean);
		expect(lines).toHaveLength(1);
		const parsed = JSON.parse(lines[0]);
		expect(parsed.source).toBe("degraded");
		expect(parsed.reason).toBe("handoff-health");
	});

	test("a provider throw falls back to watch without failing the save", async () => {
		const failing = createContextHandoffTool({
			health: {
				read: () => {
					throw new Error("snapshot unavailable");
				},
			},
		});
		const result = await failing.execute({
			operation: "save",
			repoRoot: root,
			currentStage: "03-work",
			nextStage: "04-review",
			activeFiles: ["a.ts"],
			verification: "bun test",
		});
		expect(result.blocker).toBeUndefined();
		expect(result.contextHealth).toBe("watch");
	});
});
