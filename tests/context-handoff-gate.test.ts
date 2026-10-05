// Completion gate tests (plan Unit 7: save-side deterministic floor + record).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { computeArtifactsHash } from "../extensions/ce-core/stage-gate/evidence.js";
import { evaluateCompletionGate } from "../extensions/ce-core/stage-gate/guard.js";
import { appendRecord } from "../extensions/ce-core/stage-gate/store.js";
import type { StageGateAttempt } from "../extensions/ce-core/stage-gate/types.js";
import { createContextHandoffTool } from "../extensions/ce-core/tools/context-handoff.js";

const FILLER =
	"This paragraph is intentionally long enough to satisfy the minimum length predicate for the artifact under test. It describes context, tradeoffs, and measurable outcomes in enough detail to read as real prose. ";

const PLAN = `# Plan: Stage gate

## Problem summary
${FILLER.repeat(6)}
## Implementation units

### Unit 1 — First unit
- **Files**
  - create \`extensions/ce-core/stage-gate/types.ts\`
- **Verification:** \`bun test tests/stage-gate-rubrics.test.ts\`

## Verification
- RED then GREEN per unit; \`bun test\`; Strict Review applied.
`;

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
		weightedScore: 1,
		det: [],
		sem: [],
		criticalFailed: false,
		jevUnavailable: false,
		jevReason: null,
		model: "typesafe/jev",
		warnings: [],
		artifacts: ["docs/plans/plan.md"],
		artifactsHash: "",
		attempt: 0,
		updatedAt: "2026-10-05T00:00:00.000Z",
		...overrides,
	};
}

async function seedAccept(
	records: Partial<StageGateAttempt>[],
): Promise<void> {
	const artifacts = ["docs/plans/plan.md"];
	const hash = await computeArtifactsHash(root, artifacts);
	for (const record of records) {
		await appendRecord(root, attempt({ artifacts, artifactsHash: hash, ...record }));
	}
}

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "stage-gate-guard-"));
});

afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

describe("evaluateCompletionGate (Unit 7)", () => {
	test("is never gated in off mode or for checkpoints/unknown stages", async () => {
		await write("docs/plans/plan.md", PLAN);
		for (const result of [
			await evaluateCompletionGate(root, "02-plan", "03-work", "off"),
			await evaluateCompletionGate(root, "02-plan", "02-plan", "enforce"),
			await evaluateCompletionGate(root, "unknown-stage", "03-work", "enforce"),
		]) {
			expect(result.gated).toBe(false);
			expect(result.allowed).toBe(true);
		}
	});

	test("a hollow artifact blocks in both shadow and enforce", async () => {
		await write("docs/plans/hollow.md", "# Hollow\n\nTODO");
		for (const mode of ["shadow", "enforce"] as const) {
			const result = await evaluateCompletionGate(root, "02-plan", "03-work", mode);
			expect({ mode, allowed: result.allowed }).toEqual({ mode, allowed: false });
			expect(result.blocker).toContain("deterministic");
		}
	});

	test("a good artifact without a record warns in shadow and blocks in enforce", async () => {
		await write("docs/plans/plan.md", PLAN);
		const shadow = await evaluateCompletionGate(root, "02-plan", "03-work", "shadow");
		expect(shadow.allowed).toBe(true);
		expect(shadow.warning).toBeString();

		const enforce = await evaluateCompletionGate(root, "02-plan", "03-work", "enforce");
		expect(enforce.allowed).toBe(false);
		expect(enforce.blocker).toBeString();
	});

	test("a fresh enforcing accept is required for enforce", async () => {
		await write("docs/plans/plan.md", PLAN);
		await seedAccept([{}]);
		const result = await evaluateCompletionGate(root, "02-plan", "03-work", "enforce");
		expect(result.allowed).toBe(true);
	});

	test("a shadow-produced accept never satisfies enforce", async () => {
		await write("docs/plans/plan.md", PLAN);
		await seedAccept([{ enforcing: false }]);
		const result = await evaluateCompletionGate(root, "02-plan", "03-work", "enforce");
		expect(result.allowed).toBe(false);
	});

	test("a non-accept or corrupt record blocks enforce and warns in shadow", async () => {
		await write("docs/plans/plan.md", PLAN);
		await seedAccept([{ verdict: "revise" }]);
		expect((await evaluateCompletionGate(root, "02-plan", "03-work", "enforce")).allowed).toBe(false);
		expect((await evaluateCompletionGate(root, "02-plan", "03-work", "shadow")).allowed).toBe(true);

		await write(".context/compound-engineering/stage-gates/02-plan.json", "{corrupt");
		expect((await evaluateCompletionGate(root, "02-plan", "03-work", "enforce")).allowed).toBe(false);
		expect((await evaluateCompletionGate(root, "02-plan", "03-work", "shadow")).allowed).toBe(true);
	});

	test("an edited artifact makes the record stale and blocks enforce", async () => {
		await write("docs/plans/plan.md", PLAN);
		await seedAccept([{}]);
		await write("docs/plans/plan.md", `${PLAN}\n edited`);
		expect((await evaluateCompletionGate(root, "02-plan", "03-work", "enforce")).allowed).toBe(false);
	});

	test("a new file matching the glob also invalidates the record", async () => {
		await write("docs/plans/plan.md", PLAN);
		await seedAccept([{}]);
		await write("docs/plans/extra.md", PLAN);
		expect((await evaluateCompletionGate(root, "02-plan", "03-work", "enforce")).allowed).toBe(false);
	});

	test("a fresh accept cannot override a now-failing deterministic check", async () => {
		await write("docs/plans/plan.md", PLAN);
		await seedAccept([{}]);
		await write("docs/plans/plan.md", "# Hollow\n\nTODO");
		for (const mode of ["shadow", "enforce"] as const) {
			const result = await evaluateCompletionGate(root, "02-plan", "03-work", mode);
			expect({ mode, allowed: result.allowed }).toEqual({ mode, allowed: false });
		}
	});

	test("fails open with a warning when the gate layer throws", async () => {
		await write("docs/plans/plan.md", PLAN);
		const result = await evaluateCompletionGate(root, "02-plan", "03-work", "enforce", {
			gather: async () => {
				throw new Error("boom");
			},
		});
		expect(result.allowed).toBe(true);
		expect(result.warning).toContain("boom");
	});
});

describe("context_handoff save gate integration (Unit 7)", () => {
	async function save(
		mode: "off" | "shadow" | "enforce",
		input: Record<string, unknown>,
	) {
		const tool = createContextHandoffTool({ gateMode: mode });
		return tool.execute({
			operation: "save",
			repoRoot: root,
			currentStage: "02-plan",
			verification: "bun test: 10 pass, 0 fail",
			...input,
		} as never) as Promise<{
			blocker?: string;
			gateWarning?: string;
			path?: string;
		}>;
	}

	test("shadow allows with a gateWarning; enforce blocks without a record", async () => {
		await write("docs/plans/plan.md", PLAN);
		const shadow = await save("shadow", { nextStage: "03-work" });
		expect(shadow.blocker).toBeUndefined();
		expect(shadow.gateWarning).toBeString();

		const enforce = await save("enforce", { nextStage: "03-work" });
		expect(enforce.blocker).toBeString();
	});

	test("enforce allows a fresh accepting record", async () => {
		await write("docs/plans/plan.md", PLAN);
		await seedAccept([{}]);
		const result = await save("enforce", { nextStage: "03-work" });
		expect(result.blocker).toBeUndefined();
	});

	test("omitting nextStage is still gated (omit bypass closed)", async () => {
		await write("docs/plans/plan.md", PLAN);
		const result = await save("enforce", {});
		expect(result.blocker).toBeString();
	});

	test("an explicit same-stage checkpoint is never gated", async () => {
		await write("docs/plans/hollow.md", "# Hollow\n\nTODO");
		const result = await save("enforce", { nextStage: "02-plan" });
		expect(result.blocker).toBeUndefined();
	});

	test("off mode preserves the original behavior", async () => {
		await write("docs/plans/hollow.md", "# Hollow\n\nTODO");
		const result = await save("off", { nextStage: "03-work" });
		expect(result.blocker).toBeUndefined();
		expect(result.gateWarning).toBeUndefined();
	});
});
