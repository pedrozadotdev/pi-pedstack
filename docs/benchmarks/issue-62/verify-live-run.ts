import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

interface Scenario {
	id: string;
	stages: string[];
	expectedStageStarts: string[];
	expectedTransitions: number;
	expectedFixtureCommitSha?: string;
	expectedReviewOutcomes?: Array<"clean" | "findings">;
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
	routingApplyFailure?: string;
	stageTransitions?: number;
	reviewFindings?: number;
}

function followsExpectedStages(rows: Row[], expected: string[]): boolean {
	const actual = rows.filter((row) => row.event === "stage_start").map((row) => row.stage);
	return JSON.stringify(actual) === JSON.stringify(expected);
}

export function matchesReviewOutcomes(rows: Row[], expected: Array<"clean" | "findings">): boolean {
	const actual = rows
		.filter((row) => row.event === "review_outcome" && row.stage === "04-review" && typeof row.reviewFindings === "number")
		.map((row) => row.reviewFindings === 0 ? "clean" : "findings");
	return JSON.stringify(actual) === JSON.stringify(expected);
}

export function matchesInitialFixtureCommit(roots: string[], recorded: string | undefined, expected: string | undefined): boolean {
	return roots.length === 1 && roots[0] === recorded && (!expected || roots[0] === expected);
}

export function hasAppliedSotaRole(rows: Row[]): boolean {
	return rows.some((row) => row.feature === "routing" && row.event === "role_applied" && row.stage === "02-plan" && row.role === "sota" && row.outcome === "success");
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
			if (entry.name === ".git") continue;
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
		initialFixtureCommitSha?: string;
		artifactsSha256?: string;
		piExitCode?: number;
		reportExitCode?: number;
		operatorDecisionPlanSha256?: string;
	};
	const scenario = manifest.scenarios.find((entry) => entry.id === metadata.scenario);
	if (!scenario) throw new Error("scenario missing from manifest");
	let rows: Row[] = [];
	let diagnosticsReadable = true;
	try {
		rows = (await readFile(path.join(runDir, "diagnostics.jsonl"), "utf8")).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as Row);
	} catch {
		diagnosticsReadable = false;
	}
	const workspace = path.join(runDir, "workspace");
	const artifactsSha256 = await treeHash(workspace);
	const finalHeadSha = execFileSync("git", ["-C", workspace, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
	const fixtureRoots = execFileSync("git", ["-C", workspace, "rev-list", "--max-parents=0", "HEAD"], { encoding: "utf8" }).trim().split(/\s+/).filter(Boolean);
	const initialFixtureCommitSha = fixtureRoots[0] ?? "";
	const decisions = rows.filter((row) => ["stage_start", "stage_transition", "review_attempt", "role_selected", "role_applied", "role_apply_failed"].includes(row.event ?? "")).map((row) => ({
		event: row.event,
		stage: row.stage,
		role: row.role,
		outcome: row.outcome,
		routingApplyFailure: row.routingApplyFailure,
		stageTransitions: row.stageTransitions,
	}));
	const observedDecisionSha256 = createHash("sha256").update(JSON.stringify(decisions)).digest("hex");
	const checks: Record<string, boolean> = {
		piExit: metadata.piExitCode === 0,
		reportExit: metadata.reportExitCode === 0,
		diagnosticsReadable,
		stageTrace: followsExpectedStages(rows, scenario.expectedStageStarts),
		stageTransitions: rows.filter((row) => row.event === "stage_transition").reduce((sum, row) => sum + (row.stageTransitions ?? 0), 0) === scenario.expectedTransitions,
		terminalCompletion: scenario.terminalCompletion !== true || rows.some((row) => row.event === "workflow_complete"),
		reviewOutcomes: matchesReviewOutcomes(rows, scenario.expectedReviewOutcomes ?? []),
		checkpoint: scenario.requiresCheckpoint !== true || await existsInTree(path.join(workspace, ".context", "compound-engineering", "checkpoints")),
		sotaRole: scenario.requiresSotaRole !== true || hasAppliedSotaRole(rows),
		verificationOutcomes: (scenario.verificationOutcomes ?? []).every((outcome) => rows.some((row) => row.feature === "verification" && row.outcome === outcome)),
		artifactHash: artifactsSha256 === metadata.artifactsSha256,
		initialFixtureCommit: matchesInitialFixtureCommit(fixtureRoots, metadata.initialFixtureCommitSha, scenario.expectedFixtureCommitSha),
	};
	const reviewOutcomesObserved = rows.filter((row) => row.event === "review_outcome" && row.stage === "04-review").map((row) => row.reviewFindings === 0 ? "clean" : "findings");
	const result = { scenario: scenario.id, checks, artifactsSha256, initialFixtureCommitSha, finalHeadSha, operatorDecisionPlanSha256: metadata.operatorDecisionPlanSha256, observedDecisionSha256, decisions, reviewOutcomesObserved, passed: Object.values(checks).every(Boolean) };
	await writeFile(path.join(runDir, "validation.json"), `${JSON.stringify(result, null, 2)}\n`);
	console.log(JSON.stringify(result, null, 2));
	if (!result.passed) process.exitCode = 1;
}

if (import.meta.main) await main();
