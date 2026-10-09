import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

interface Scenario {
	id: string;
	stages: string[];
	expectedStageStarts: string[];
	expectedTransitions: number;
	expectedReviewOutcomes?: string[];
	terminalCompletion?: boolean;
	requiresCheckpoint?: boolean;
	requiresSotaRole?: boolean;
	verificationOutcomes?: string[];
}

interface Row {
	feature?: string;
	event?: string;
	stage?: string;
	role?: string;
	outcome?: string;
	stageTransitions?: number;
}

async function walkMarkdown(root: string): Promise<string[]> {
	const files: string[] = [];
	for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
		const target = path.join(root, entry.name);
		if (entry.isDirectory()) files.push(...await walkMarkdown(target));
		else if (entry.isFile() && entry.name.endsWith(".md")) files.push(target);
	}
	return files;
}

function followsExpectedStages(rows: Row[], expected: string[]): boolean {
	const actual = rows.filter((row) => row.event === "stage_start").map((row) => row.stage);
	return JSON.stringify(actual) === JSON.stringify(expected);
}

function hasReviewOutcome(content: string, expected: string): boolean {
	if (expected === "findings") return /Status:\s*findings/i.test(content) && /Findings:\s*[1-9]\d*/i.test(content);
	if (expected === "clean, zero findings") return /Status:\s*clean/i.test(content) && /Findings:\s*0\b/i.test(content);
	return false;
}

async function existsInTree(root: string): Promise<boolean> {
	for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
		const target = path.join(root, entry.name);
		if (entry.isFile()) return true;
		if (entry.isDirectory() && await existsInTree(target)) return true;
	}
	return false;
}

async function treeHash(root: string): Promise<string> {
	const files: string[] = [];
	async function collect(dir: string): Promise<void> {
		for (const entry of await readdir(dir, { withFileTypes: true })) {
			const target = path.join(dir, entry.name);
			if (entry.isDirectory()) await collect(target);
			else if (entry.isFile()) files.push(target);
		}
	}
	await collect(root);
	files.sort();
	const hash = createHash("sha256");
	for (const file of files) {
		hash.update(path.relative(root, file).split(path.sep).join("/"));
		hash.update("\0");
		hash.update(await readFile(file));
		hash.update("\0");
	}
	return hash.digest("hex");
}

async function main(): Promise<void> {
	const runDir = process.argv[2];
	if (!runDir || !path.isAbsolute(runDir)) throw new Error("expected an absolute run directory");
	const manifest = JSON.parse(await readFile(new URL("./live-scenarios.json", import.meta.url), "utf8")) as { scenarios: Scenario[] };
	const metadata = JSON.parse(await readFile(path.join(runDir, "metadata.json"), "utf8")) as {
		scenario: string;
		artifactsSha256?: string;
		operatorDecisionPlanSha256?: string;
	};
	const scenario = manifest.scenarios.find((entry) => entry.id === metadata.scenario);
	if (!scenario) throw new Error("scenario missing from manifest");
	const rows = (await readFile(path.join(runDir, "diagnostics.jsonl"), "utf8")).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as Row);
	const workspace = path.join(runDir, "workspace");
	const artifactsSha256 = await treeHash(workspace);
	const decisions = rows.filter((row) => ["stage_start", "stage_transition", "review_attempt", "role_selected"].includes(row.event ?? "")).map((row) => ({
		event: row.event,
		stage: row.stage,
		role: row.role,
		outcome: row.outcome,
		stageTransitions: row.stageTransitions,
	}));
	const observedDecisionSha256 = createHash("sha256").update(JSON.stringify(decisions)).digest("hex");
	const reviewDocs = await walkMarkdown(workspace);
	const reviewText = (await Promise.all(reviewDocs.map((file) => readFile(file, "utf8")))).join("\n");
	const checks: Record<string, boolean> = {
		stageTrace: followsExpectedStages(rows, scenario.expectedStageStarts),
		stageTransitions: rows.filter((row) => row.event === "stage_transition").reduce((sum, row) => sum + (row.stageTransitions ?? 0), 0) === scenario.expectedTransitions,
		terminalCompletion: scenario.terminalCompletion !== true || rows.some((row) => row.event === "workflow_complete"),
		reviewOutcomes: (scenario.expectedReviewOutcomes ?? []).every((outcome) => hasReviewOutcome(reviewText, outcome)),
		checkpoint: scenario.requiresCheckpoint !== true || await existsInTree(path.join(workspace, ".context", "compound-engineering", "checkpoints")),
		sotaRole: scenario.requiresSotaRole !== true || rows.some((row) => row.feature === "routing" && row.stage === "02-plan" && row.role === "sota"),
		verificationOutcomes: (scenario.verificationOutcomes ?? []).every((outcome) => rows.some((row) => row.feature === "verification" && row.outcome === outcome)),
		artifactHash: artifactsSha256 === metadata.artifactsSha256,
	};
	const result = { scenario: scenario.id, checks, artifactsSha256, operatorDecisionPlanSha256: metadata.operatorDecisionPlanSha256, observedDecisionSha256, decisions, passed: Object.values(checks).every(Boolean) };
	await writeFile(path.join(runDir, "validation.json"), `${JSON.stringify(result, null, 2)}\n`);
	console.log(JSON.stringify(result, null, 2));
	if (!result.passed) process.exitCode = 1;
}

await main();
