// Workflow lifecycle: a genuinely new workflow must not inherit the previous
// workflow's proactive escalation budget or its persisted stage-gate
// escalation/review state. `/ped-start` and `/ped-fix-issues` are the only
// workflow roots; the reset must be scoped to exactly that state.
import { afterEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	readRoutingRecord,
	writeRoutingRecord,
	type RoutingRecord,
} from "../extensions/ce-core/utils/routing-store";
import { stageGatePath } from "../extensions/ce-core/stage-gate/store";
import { resetWorkflowRoutingState } from "../extensions/ce-core/utils/workflow-reset";

const tempRoots: string[] = [];

function makeRepo(): string {
	const root = mkdtempSync(path.join(tmpdir(), "pi-workflow-reset-"));
	tempRoots.push(root);
	return root;
}

function writeFile(repoRoot: string, rel: string, content: string): string {
	const file = path.join(repoRoot, rel);
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, content, "utf8");
	return file;
}

function writeRouting(repoRoot: string, stage: string, escalations: number): Promise<string> {
	const record: RoutingRecord = {
		schema: 1,
		stage,
		role: "sota",
		reason: "jev",
		source: "jev",
		scores: null,
		weighted: 0.9,
		confidence: 0.9,
		attempts: 1,
		escalations,
		revisions: 0,
		reviews: 0,
		updatedAt: "2026-10-06T00:00:00.000Z",
	};
	return writeRoutingRecord(repoRoot, record);
}

function writeStageGate(repoRoot: string, stage: string): void {
	const file = stageGatePath(repoRoot, stage as never);
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(
		file,
		JSON.stringify({ stage, attempts: [{ verdict: "escalate" }] }),
		"utf8",
	);
}

afterEach(() => {
	for (const root of tempRoots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe("resetWorkflowRoutingState", () => {
	test("removes routing and stage-gate records", async () => {
		const repo = makeRepo();
		await writeRouting(repo, "03-work", 1);
		writeStageGate(repo, "03-work");

		await resetWorkflowRoutingState(repo);

		expect(await readRoutingRecord(repo, "03-work")).toBeNull();
		expect(existsSync(stageGatePath(repo, "03-work"))).toBe(false);
	});

	test("is idempotent when there is nothing to remove", async () => {
		const repo = makeRepo();

		await expect(resetWorkflowRoutingState(repo)).resolves.toBeUndefined();
		await expect(resetWorkflowRoutingState(repo)).resolves.toBeUndefined();
	});

	test("removes a corrupt routing record without throwing", async () => {
		const repo = makeRepo();
		writeFile(
			repo,
			".context/compound-engineering/routing/03-work.json",
			"{ not json",
		);

		await expect(resetWorkflowRoutingState(repo)).resolves.toBeUndefined();
		expect(existsSync(path.join(repo, ".context", "compound-engineering", "routing"))).toBe(false);
	});

	test("preserves user artifacts, handoffs, context state, and unrelated workflow state", async () => {
		const repo = makeRepo();
		await writeRouting(repo, "03-work", 1);
		writeStageGate(repo, "03-work");
		const handoff = writeFile(
			repo,
			".context/compound-engineering/handoffs/latest.md",
			"# handoff\n",
		);
		const contextState = writeFile(
			repo,
			".context/compound-engineering/context-state.json",
			'{"currentStage":"03-work"}',
		);
		const screens = writeFile(
			repo,
			".context/compound-engineering/injection-screens.jsonl",
			"{}\n",
		);
		const plan = writeFile(repo, "docs/plans/2026-10-06-plan.md", "# plan\n");
		const solution = writeFile(
			repo,
			"docs/solutions/workflow/card.md",
			"# card\n",
		);

		await resetWorkflowRoutingState(repo);

		for (const file of [handoff, contextState, screens, plan, solution]) {
			expect(existsSync(file)).toBe(true);
		}
		expect(readFileSync(plan, "utf8")).toBe("# plan\n");
	});
});
