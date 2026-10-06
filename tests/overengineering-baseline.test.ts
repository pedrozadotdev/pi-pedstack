// Baseline resolution + contamination guard (plan Unit 4). File-based, no
// network; the read seam is injectable for unreadable/escaping tests.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveBaseline } from "../extensions/ce-core/overengineering/baseline.js";
import { computeArtifactsHash } from "../extensions/ce-core/stage-gate/evidence.js";

let root: string;

async function write(rel: string, content: string): Promise<void> {
	const abs = path.join(root, rel);
	await fs.mkdir(path.dirname(abs), { recursive: true });
	await fs.writeFile(abs, content);
}

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "overengineering-baseline-"));
});

afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

describe("overengineering baseline (Unit 4)", () => {
	test("02-plan resolves the requirements doc", async () => {
		await write("docs/brainstorms/req.md", "# Requirements\nDo the thing.");
		const result = await resolveBaseline({ repoRoot: root, stage: "02-plan" });
		expect(result.status).toBe("ready");
		expect(result.provenance).toBe("requirements");
		expect(result.baselines.requirements?.text).toContain("Do the thing.");
		expect(result.paths).toEqual(["docs/brainstorms/req.md"]);
		expect(result.hash).toBe(
			await computeArtifactsHash(root, ["docs/brainstorms/req.md"]),
		);
	});

	test("02-plan excludes a newer issue-context file from the requirements slot", async () => {
		await write("docs/brainstorms/req.md", "requirements text");
		await new Promise((resolve) => setTimeout(resolve, 5));
		await write("docs/brainstorms/issue-99.md", "issue text");
		const result = await resolveBaseline({ repoRoot: root, stage: "02-plan" });
		expect(result.provenance).toBe("requirements");
		expect(result.baselines.requirements?.text).toBe("requirements text");
	});

	test("02-plan falls back to the local issue context", async () => {
		await write("docs/brainstorms/issue-16.md", "issue body text");
		const result = await resolveBaseline({ repoRoot: root, stage: "02-plan" });
		expect(result.status).toBe("ready");
		expect(result.provenance).toBe("issue-context");
		expect(result.baselines.requirements?.text).toBe("issue body text");
	});

	test("03-work resolves the plan baseline", async () => {
		await write("docs/plans/plan.md", "plan body");
		const result = await resolveBaseline({
			repoRoot: root,
			stage: "03-work",
			priorPlanReading: 0.9,
		});
		expect(result.provenance).toBe("plan");
		expect(result.baselines.plan?.text).toBe("plan body");
		expect(result.baselines.requirements).toBeUndefined();
	});

	test("03-work flags no-prior-reading when there is no record", async () => {
		await write("docs/plans/plan.md", "plan body");
		const result = await resolveBaseline({ repoRoot: root, stage: "03-work" });
		expect(result.provenance).toBe("no-prior-reading");
		expect(result.baselines.plan?.text).toBe("plan body");
	});

	test("03-work flags plan-review-band for [0.5, 0.75)", async () => {
		await write("docs/plans/plan.md", "plan body");
		const result = await resolveBaseline({
			repoRoot: root,
			stage: "03-work",
			priorPlanReading: 0.6,
		});
		expect(result.provenance).toBe("plan-review-band");
		expect(result.baselines.plan?.text).toBe("plan body");
	});

	test("03-work falls back to requirements when the plan is missing", async () => {
		await write("docs/brainstorms/req.md", "requirements body");
		const result = await resolveBaseline({ repoRoot: root, stage: "03-work" });
		expect(result.provenance).toBe("plan-unavailable");
		expect(result.baselines.requirements?.text).toBe("requirements body");
		expect(result.baselines.plan).toBeUndefined();
	});

	test("03-work falls back when the plan is unreadable", async () => {
		await write("docs/plans/plan.md", "plan body");
		await write("docs/brainstorms/req.md", "requirements body");
		const result = await resolveBaseline({
			repoRoot: root,
			stage: "03-work",
			priorPlanReading: 0.9,
			readFile: async (rel: string) =>
				rel.endsWith("plan.md") ? null : Promise.resolve("requirements body"),
		});
		expect(result.provenance).toBe("plan-unavailable");
		expect(result.baselines.requirements?.text).toBe("requirements body");
	});

	test("03-work falls back when the prior plan reading is below 0.5", async () => {
		await write("docs/plans/plan.md", "plan body");
		await write("docs/brainstorms/req.md", "requirements body");
		const result = await resolveBaseline({
			repoRoot: root,
			stage: "03-work",
			priorPlanReading: 0.3,
		});
		expect(result.provenance).toBe("prior-plan-low");
		expect(result.baselines.requirements?.text).toBe("requirements body");
	});

	test("04-review returns both baselines with sorted paths and a per-dimension split", async () => {
		await write("docs/brainstorms/req.md", "requirements says scope A");
		await write("docs/plans/plan.md", "plan says implementation B");
		const result = await resolveBaseline({ repoRoot: root, stage: "04-review" });
		expect(result.provenance).toBe("review-dual");
		expect(result.baselines.requirements?.text).toContain("scope A");
		expect(result.baselines.plan?.text).toContain("implementation B");
		expect(result.paths).toEqual([
			"docs/brainstorms/req.md",
			"docs/plans/plan.md",
		]);
	});

	test("04-review tolerates a partial dual baseline", async () => {
		await write("docs/brainstorms/req.md", "requirements only");
		const result = await resolveBaseline({ repoRoot: root, stage: "04-review" });
		expect(result.status).toBe("ready");
		expect(result.provenance).toBe("review-requirements");
		expect(result.baselines.plan).toBeUndefined();
	});

	test("no baseline resolves to unavailable with empty paths", async () => {
		const result = await resolveBaseline({ repoRoot: root, stage: "02-plan" });
		expect(result.status).toBe("unavailable");
		expect(result.reason).toBe("no_baseline");
		expect(result.paths).toEqual([]);
	});

	test("a truncated baseline sets the flag and never exposes past-cap content", async () => {
		await write(
			"docs/brainstorms/req.md",
			`${"a".repeat(3000)}KEY_REQUIREMENT${"b".repeat(3000)}`,
		);
		const result = await resolveBaseline({ repoRoot: root, stage: "02-plan" });
		const ref = result.baselines.requirements;
		expect(ref?.truncated).toBe(true);
		expect(Buffer.byteLength(ref?.text ?? "", "utf8")).toBeLessThanOrEqual(2048);
		expect(ref?.text).not.toContain("KEY_REQUIREMENT");
	});

	test("rejects an escaping symlink baseline", async () => {
		const outside = path.join(root, "..", `outside-${Date.now()}.md`);
		await fs.writeFile(outside, "outside text");
		await fs.mkdir(path.join(root, "docs/brainstorms"), { recursive: true });
		await fs.symlink(outside, path.join(root, "docs/brainstorms/req.md"));
		const result = await resolveBaseline({ repoRoot: root, stage: "02-plan" });
		expect(result.status).toBe("unavailable");
		await fs.rm(outside, { force: true });
	});
});
