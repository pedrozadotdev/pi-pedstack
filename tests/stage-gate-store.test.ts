// Stage gate record store tests (plan Unit 4: persistence, freshness, mode).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { computeArtifactsHash } from "../extensions/ce-core/stage-gate/evidence.js";
import {
	ATTEMPT_CAP,
	appendRecord,
	isCompletionSave,
	isRecordFresh,
	readAcceptRecord,
	readLatestRecord,
	resolveStageGateMode,
	stageGatePath,
} from "../extensions/ce-core/stage-gate/store.js";
import type { StageGateAttempt } from "../extensions/ce-core/stage-gate/types.js";

let root: string;

async function write(rel: string, content: string): Promise<void> {
	const abs = path.join(root, rel);
	await fs.mkdir(path.dirname(abs), { recursive: true });
	await fs.writeFile(abs, content);
}

function attempt(overrides: Partial<StageGateAttempt> = {}): StageGateAttempt {
	return {
		schema: 1,
		stage: "02-plan",
		verdict: "accept",
		enforcing: true,
		weightedScore: 0.9,
		det: [],
		sem: [],
		criticalFailed: false,
		jevUnavailable: false,
		jevReason: null,
		model: "typesafe/jev",
		warnings: [],
		artifacts: ["docs/plans/x.md"],
		artifactsHash: "hash",
		attempt: 0,
		updatedAt: "2026-10-05T00:00:00.000Z",
		...overrides,
	};
}

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "stage-gate-store-"));
});

afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

describe("stage gate store (Unit 4)", () => {
	test("resolves the mode from env with a shadow default", () => {
		expect(resolveStageGateMode({})).toBe("shadow");
		expect(resolveStageGateMode({ PEDSTACK_STAGE_GATE: "" })).toBe("shadow");
		expect(resolveStageGateMode({ PEDSTACK_STAGE_GATE: "SHADOW" })).toBe("shadow");
		expect(resolveStageGateMode({ PEDSTACK_STAGE_GATE: "bogus" })).toBe("shadow");
		expect(resolveStageGateMode({ PEDSTACK_STAGE_GATE: "enforce" })).toBe("enforce");
		expect(resolveStageGateMode({ PEDSTACK_STAGE_GATE: "off" })).toBe("off");
	});

	test("isCompletionSave fails open on unknown stages and closes the omit bypass", () => {
		expect(isCompletionSave(undefined, "03-work")).toBe(false);
		expect(isCompletionSave(null, "03-work")).toBe(false);
		expect(isCompletionSave("bogus", "03-work")).toBe(false);
		expect(isCompletionSave("02-plan", "02-plan")).toBe(false);
		expect(isCompletionSave("02-plan", "03-work")).toBe(true);
		expect(isCompletionSave("02-plan", undefined)).toBe(true);
		expect(isCompletionSave("02-plan", "bogus")).toBe(true);
	});

	test("missing, corrupt, and non-array records read as null", async () => {
		expect(await readLatestRecord(root, "02-plan")).toBeNull();
		await write(stageGatePath(root, "02-plan"), "{not json");
		expect(await readLatestRecord(root, "02-plan")).toBeNull();
		await write(stageGatePath(root, "02-plan"), JSON.stringify({ attempts: "nope" }));
		expect(await readLatestRecord(root, "02-plan")).toBeNull();
	});

	test("appendRecord keeps only the newest ATTEMPT_CAP records", async () => {
		for (let index = 0; index < ATTEMPT_CAP + 1; index++) {
			await appendRecord(root, attempt({ attempt: index, updatedAt: `t${index}` }));
		}
		const latest = await readLatestRecord(root, "02-plan");
		expect(latest?.attempt).toBe(ATTEMPT_CAP);
		const raw = JSON.parse(await fs.readFile(stageGatePath(root, "02-plan"), "utf8")) as {
			attempts: StageGateAttempt[];
		};
		expect(raw.attempts).toHaveLength(ATTEMPT_CAP);
		expect(raw.attempts.map((entry) => entry.attempt)).toEqual([1, 2, 3]);
	});

	test("readAcceptRecord returns the newest record only when it is an enforcing accept", async () => {
		await appendRecord(root, attempt({ verdict: "accept", enforcing: true }));
		expect((await readAcceptRecord(root, "02-plan"))?.verdict).toBe("accept");

		await appendRecord(root, attempt({ verdict: "accept", enforcing: false }));
		expect(await readAcceptRecord(root, "02-plan")).toBeNull();

		await appendRecord(root, attempt({ verdict: "revise", enforcing: true }));
		expect(await readAcceptRecord(root, "02-plan")).toBeNull();
	});

	test("round-trips the optional review action on an attempt", async () => {
		await appendRecord(
			root,
			attempt({
				review: { action: "escalate", reviewerCount: 0, reason: "budget exhausted" },
			}),
		);
		const latest = await readLatestRecord(root, "02-plan");
		expect(latest?.review).toEqual({
			action: "escalate",
			reviewerCount: 0,
			reason: "budget exhausted",
		});
	});

	test("isRecordFresh rejects edits, additions, removals, and renames", async () => {
		await write("docs/plans/x.md", "hello");
		const hash = await computeArtifactsHash(root, ["docs/plans/x.md"]);
		const record = attempt({ artifacts: ["docs/plans/x.md"], artifactsHash: hash });
		expect(await isRecordFresh(root, record)).toBe(true);

		await write("docs/plans/x.md", "hellp");
		expect(await isRecordFresh(root, record)).toBe(false);

		await write("docs/plans/x.md", "hello");
		await write("docs/plans/y.md", "hello");
		expect(await isRecordFresh(root, record)).toBe(false);
		await fs.rm(path.join(root, "docs/plans/y.md"));
		expect(await isRecordFresh(root, record)).toBe(true);

		await fs.rm(path.join(root, "docs/plans/x.md"));
		expect(await isRecordFresh(root, record)).toBe(false);
		await write("docs/plans/x.md", "hello");
		await fs.rename(path.join(root, "docs/plans/x.md"), path.join(root, "docs/plans/z.md"));
		expect(await isRecordFresh(root, record)).toBe(false);
	});
});
