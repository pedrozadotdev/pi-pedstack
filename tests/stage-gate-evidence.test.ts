// Stage gate evidence tests (plan Unit 2: resolution, hashing, best-effort reads).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { computePlanUnitHashes } from "../extensions/ce-core/docs-verification/facts.js";
import { writeDocsRecord } from "../extensions/ce-core/docs-verification/store.js";
import type {
	DocsUnitRecord,
	DocsVerificationRecord,
} from "../extensions/ce-core/docs-verification/types.js";
import {
	computeArtifactsHash,
	gatherEvidence,
	resolveArtifactPaths,
} from "../extensions/ce-core/stage-gate/evidence.js";

const MAX_FILE_BYTES = 64 * 1024;
const MAX_TOTAL_BYTES = 48 * 1024;
const CONTEXT = ".context/compound-engineering";

let root: string;

async function write(rel: string, content: string | Uint8Array): Promise<string> {
	const abs = path.join(root, rel);
	await fs.mkdir(path.dirname(abs), { recursive: true });
	await fs.writeFile(abs, content);
	return abs;
}

async function sha256Empty(): Promise<string> {
	return createHash("sha256").update("").digest("hex");
}

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "stage-gate-evidence-"));
});

afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

describe("stage gate evidence (Unit 2)", () => {
	test("** matches nested solution categories while * stays single-segment", async () => {
		await write("docs/solutions/cat/a.md", "a");
		await write("docs/solutions/b.md", "b");
		await write("docs/plans/x.md", "x");
		await write("docs/plans/nested/y.md", "y");

		const solutions = await resolveArtifactPaths(root, "05-learn");
		expect(solutions.paths).toEqual(["docs/solutions/b.md", "docs/solutions/cat/a.md"]);
		expect(solutions.warnings).toEqual([]);

		const plans = await resolveArtifactPaths(root, "02-plan");
		expect(plans.paths).toEqual(["docs/plans/x.md"]);
	});

	test("a valid hint replaces the glob result and is sorted", async () => {
		await write("docs/plans/x.md", "x");
		await write("docs/plans/y.md", "y");

		const resolved = await resolveArtifactPaths(root, "02-plan", [
			"docs/plans/y.md",
			"docs/plans/x.md",
		]);
		expect(resolved.paths).toEqual(["docs/plans/x.md", "docs/plans/y.md"]);
		expect(resolved.warnings).toEqual([]);
	});

	test("rejects a ../ escape, an outside absolute path, and a foreign stage dir", async () => {
		await write("docs/plans/x.md", "x");
		const outside = await fs.mkdtemp(path.join(os.tmpdir(), "stage-gate-outside-"));
		await fs.writeFile(path.join(outside, "escape.md"), "escape");

		const cases = [
			["../escape.md"],
			[path.join(outside, "escape.md")],
			["docs/solutions/cat/a.md"],
		];
		for (const hint of cases) {
			const resolved = await resolveArtifactPaths(root, "02-plan", hint);
			expect({ hint, paths: resolved.paths }).toEqual({
				hint,
				paths: ["docs/plans/x.md"],
			});
			expect(resolved.warnings.length).toBeGreaterThan(0);
		}
		await fs.rm(outside, { recursive: true, force: true });
	});

	test("rejects a symlink whose realpath escapes the repo", async () => {
		await write("docs/plans/x.md", "x");
		const outside = await fs.mkdtemp(path.join(os.tmpdir(), "stage-gate-symlink-"));
		const secret = path.join(outside, "secret.md");
		await fs.writeFile(secret, "secret");
		await fs.symlink(secret, path.join(root, "docs/plans", "link.md"));

		const resolved = await resolveArtifactPaths(root, "02-plan", ["docs/plans/link.md"]);
		expect(resolved.paths).toEqual(["docs/plans/x.md"]);
		expect(resolved.warnings.length).toBeGreaterThan(0);
		await fs.rm(outside, { recursive: true, force: true });
	});

	test("falls back to the newest file in the stage dir, greatest path on a tie", async () => {
		// Non-.md files keep the declared glob empty so the fallback branch runs.
		const older = await write("docs/plans/older.txt", "older");
		const newer = await write("docs/plans/newer.txt", "newer");
		await fs.utimes(older, new Date(1_000), new Date(1_000));
		await fs.utimes(newer, new Date(2_000), new Date(2_000));

		const byMtime = await resolveArtifactPaths(root, "02-plan");
		expect(byMtime.paths).toEqual(["docs/plans/newer.txt"]);

		await fs.utimes(newer, new Date(2_000), new Date(2_000));
		await fs.utimes(older, new Date(2_000), new Date(2_000));
		const byTie = await resolveArtifactPaths(root, "02-plan");
		expect(byTie.paths).toEqual(["docs/plans/older.txt"]);
	});

	test("empty stage dir resolves to an empty set", async () => {
		await fs.mkdir(path.join(root, "docs/plans"), { recursive: true });
		const resolved = await resolveArtifactPaths(root, "02-plan");
		expect(resolved.paths).toEqual([]);
	});

	test("hash is stable, path-canonical, and changes on edit/add/remove/rename", async () => {
		await write("docs/plans/x.md", "hello");
		const rel = ["docs/plans/x.md"];

		const base = await computeArtifactsHash(root, rel);
		expect(await computeArtifactsHash(root, rel)).toBe(base);
		expect(await computeArtifactsHash(root, [path.join(root, "docs/plans/x.md")])).toBe(base);
		expect(await computeArtifactsHash(root, ["docs\\plans\\x.md"])).toBe(base);
		expect(await computeArtifactsHash(root, [])).toBe(await sha256Empty());

		await write("docs/plans/x.md", "hellp");
		const edited = await computeArtifactsHash(root, rel);
		expect(edited).not.toBe(base);

		await write("docs/plans/y.md", "hello");
		expect(await computeArtifactsHash(root, [...rel, "docs/plans/y.md"])).not.toBe(edited);

		await fs.rm(path.join(root, "docs/plans/y.md"));
		expect(await computeArtifactsHash(root, rel)).toBe(edited);

		await fs.rename(path.join(root, "docs/plans/x.md"), path.join(root, "docs/plans/z.md"));
		expect(await computeArtifactsHash(root, ["docs/plans/z.md"])).not.toBe(base);
	});

	test("caps per-file read and total text while the hash stays over full bytes", async () => {
		const big = "a".repeat(100 * 1024);
		await write("docs/plans/big.md", big);
		const evidence = await gatherEvidence({ repoRoot: root, stage: "02-plan" });

		expect(Buffer.byteLength(evidence.files[0].text, "utf8")).toBeLessThanOrEqual(MAX_FILE_BYTES);
		expect(evidence.truncated).toBe(true);

		const half = "b".repeat(40 * 1024);
		await fs.rm(path.join(root, "docs/plans/big.md"));
		await write("docs/plans/one.md", half);
		await write("docs/plans/two.md", half);
		const two = await gatherEvidence({ repoRoot: root, stage: "02-plan" });
		expect(Buffer.byteLength(two.txt, "utf8")).toBeLessThanOrEqual(MAX_TOTAL_BYTES);
		expect(two.truncated).toBe(true);

		const full = await computeArtifactsHash(root, ["docs/plans/one.md", "docs/plans/two.md"]);
		const manual = createHash("sha256");
		manual.update(`${"docs/plans/one.md"}\0${40 * 1024}\0${await sha256String(half)}\n`);
		manual.update(`${"docs/plans/two.md"}\0${40 * 1024}\0${await sha256String(half)}\n`);
		expect(full).toBe(manual.digest("hex"));
	});

	test("returns null for missing or corrupt context-state and checkpoint JSON", async () => {
		await write(`${CONTEXT}/context-state.json`, "{not json");
		await write(`${CONTEXT}/checkpoints/bad.json`, "not json");
		await write(`${CONTEXT}/review-findings/bad-04-review.json`, "not json");
		await write(`${CONTEXT}/stage-reports/03-work.md`, "bun test: 1 pass, 0 fail");

		const evidence = await gatherEvidence({ repoRoot: root, stage: "03-work" });
		expect(evidence.contextState).toBeNull();
		expect(evidence.checkpoints).toEqual([]);

		const review = await gatherEvidence({ repoRoot: root, stage: "04-review" });
		expect(review.reviewFindings).toEqual([]);
	});

	test("gathers context-state verification, checkpoints, findings, and plan text", async () => {
		await write(`${CONTEXT}/context-state.json`, JSON.stringify({ verification: "bun test: 2 pass, 0 fail" }));
		await write(
			`${CONTEXT}/checkpoints/c.json`,
			JSON.stringify({ path: "x", status: "ok", completedUnits: ["u1"] }),
		);
		await write(
			`${CONTEXT}/review-findings/ts-04-review.json`,
			JSON.stringify({ count: 1, findings: [{ severity: "high", evidence: "src/a.ts:1" }] }),
		);
		await write("docs/plans/some-plan.md", "# Plan\n\nbody");

		const evidence = await gatherEvidence({ repoRoot: root, stage: "04-review" });
		expect(evidence.contextState).toEqual({ verification: "bun test: 2 pass, 0 fail" });
		expect(evidence.reviewFindings).toHaveLength(1);
		expect(evidence.reviewFindings[0].path).toContain("04-review.json");
		expect(evidence.planText).toContain("body");
	});
});

describe("stage gate evidence — prior gate action (Unit 4)", () => {
test("defaults priorGate to null and passes through an explicit value", async () => {
const defaulted = await gatherEvidence({ repoRoot: root, stage: "04-review" });
expect(defaulted.priorGate).toBeNull();

const passed = await gatherEvidence({
repoRoot: root,
stage: "04-review",
priorGate: {
verdict: "review",
action: "review",
updatedAt: "2026-10-06T10:00:00.000Z",
},
});
expect(passed.priorGate).toEqual({
verdict: "review",
action: "review",
updatedAt: "2026-10-06T10:00:00.000Z",
});
});
});
describe("stage gate evidence — findings observedAt (Unit 5)", () => {
test("sets observedAt from generatedAt when present", async () => {
await write(
`${CONTEXT}/review-findings/a-04-review.json`,
JSON.stringify({
count: 0,
findings: [],
generatedAt: "2026-10-06T10:00:00.000Z",
}),
);
const evidence = await gatherEvidence({ repoRoot: root, stage: "04-review" });
expect(evidence.reviewFindings[0].observedAt).toBe(
"2026-10-06T10:00:00.000Z",
);
});

test("falls back to file mtime when generatedAt is absent or invalid", async () => {
const abs = await write(
`${CONTEXT}/review-findings/b-04-review.json`,
JSON.stringify({ count: 0, findings: [] }),
);
const stat = await fs.stat(abs);
const evidence = await gatherEvidence({ repoRoot: root, stage: "04-review" });
expect(evidence.reviewFindings[0].observedAt).toBe(stat.mtime.toISOString());

await write(
`${CONTEXT}/review-findings/b-04-review.json`,
JSON.stringify({ count: 0, findings: [], generatedAt: "not-a-date" }),
);
const stat2 = await fs.stat(abs);
const evidence2 = await gatherEvidence({ repoRoot: root, stage: "04-review" });
expect(evidence2.reviewFindings[0].observedAt).toBe(
stat2.mtime.toISOString(),
);
});
});

async function sha256String(value: string): Promise<string> {
	return createHash("sha256").update(value).digest("hex");
}

const OBLIGATION_PLAN = [
	"### Unit 1 — Alpha",
	"",
	"**Files.**",
	"",
	"- create `src/a.ts`",
	"",
	"Uses `typebox`.",
	"",
].join("\n");

function obligationUnit(slug: string, hash: string, source: DocsUnitRecord["source"]): DocsUnitRecord {
	return {
		slug,
		hash,
		phase: "planned",
		facts: {
			phase: "planned",
			declaredFiles: [],
			packages: [],
			evidence: [],
			versionUnknown: false,
		},
		decision: "required",
		packages: ["typebox"],
		source,
		obligation: {
			slug,
			status: "open",
			decision: "required",
			packages: ["typebox"],
			source,
			updatedAt: "2026-10-06T00:00:00.000Z",
		},
	};
}

describe("stage gate evidence — docs-verification obligations (Unit 6)", () => {
	test("populates obligations from a seeded, fresh store", async () => {
		await write("package.json", JSON.stringify({ dependencies: { typebox: "^1.0.0" } }));
		await write("docs/plans/plan.md", OBLIGATION_PLAN);
		const hashes = await computePlanUnitHashes(
			{ repoRoot: root, phase: "planned", planText: OBLIGATION_PLAN },
			{
				readFile: (abs) => fs.readFile(abs, "utf8"),
				exists: (abs) => existsSync(abs),
			},
		);
		const units = [...hashes.entries()].map(([slug, hash]) =>
			obligationUnit(slug, hash, "jev"),
		);
		const record: DocsVerificationRecord = {
			schema: 1,
			planPath: "docs/plans/plan.md",
			grammar: 1,
			activePhase: "planned",
			thresholdsVersion: 1,
			units,
			droppedUnits: [],
			updatedAt: "2026-10-06T00:00:00.000Z",
		};
		await writeDocsRecord(root, record);

		const evidence = await gatherEvidence({
			repoRoot: root,
			stage: "02-plan",
			docsVerificationMode: "shadow",
			docsVerificationFailClosed: false,
		});
		const obligations = evidence.obligations;
		expect(obligations?.applicable).toBe(true);
		expect(obligations?.storePresent).toBe(true);
		expect(obligations?.stale).toBe(false);
		expect(obligations?.open).toBe(1);
		expect(obligations?.degraded).toBe(false);
		expect(obligations?.failClosed).toBe(false);
	});

	test("marks the record stale when the plan changes", async () => {
		await write("package.json", JSON.stringify({ dependencies: { typebox: "^1.0.0" } }));
		await write("docs/plans/plan.md", OBLIGATION_PLAN);
		const hashes = await computePlanUnitHashes(
			{ repoRoot: root, phase: "planned", planText: OBLIGATION_PLAN },
			{ readFile: (abs) => fs.readFile(abs, "utf8"), exists: (abs) => existsSync(abs) },
		);
		await writeDocsRecord(root, {
			schema: 1,
			planPath: "docs/plans/plan.md",
			grammar: 1,
			activePhase: "planned",
			thresholdsVersion: 1,
			units: [...hashes.entries()].map(([slug, hash]) =>
				obligationUnit(slug, hash, "jev"),
			),
			droppedUnits: [],
			updatedAt: "2026-10-06T00:00:00.000Z",
		});
		await write(
			"docs/plans/plan.md",
			OBLIGATION_PLAN.replace("src/a.ts", "src/a-renamed.ts"),
		);

		const evidence = await gatherEvidence({ repoRoot: root, stage: "02-plan" });
		expect(evidence.obligations?.stale).toBe(true);
	});

	test("treats a corrupt store as absent and reads the fail-closed default", async () => {
		await write("docs/plans/plan.md", OBLIGATION_PLAN);
		await write(
			`.context/compound-engineering/docs-verification/plan.json`,
			"{corrupt",
		);
		const evidence = await gatherEvidence({
			repoRoot: root,
			stage: "02-plan",
			docsVerificationFailClosed: true,
		});
		expect(evidence.obligations?.storePresent).toBe(false);
		expect(evidence.obligations?.failClosed).toBe(true);
	});

	test("is not applicable when the mode is off or the stage is out of scope", async () => {
		await write("docs/plans/plan.md", OBLIGATION_PLAN);
		const off = await gatherEvidence({
			repoRoot: root,
			stage: "02-plan",
			docsVerificationMode: "off",
		});
		expect(off.obligations?.applicable).toBe(false);
		const other = await gatherEvidence({
			repoRoot: root,
			stage: "05-learn",
			docsVerificationMode: "shadow",
		});
		expect(other.obligations?.applicable).toBe(false);
	});
});
