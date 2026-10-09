import { mkdtempSync, rmSync } from "node:fs";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { mkdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
import {
	readPiPedstackConfig,
	getConfigKeyForSkill,
	type PiPedstackConfig,
	type StepConfigKey,
} from "../utils/config-types";
import { filterIndependentReviewers } from "../review/policy";
import { normalizeSlug } from "../utils/name-utils";
import { createAgyCommand, isGeminiModel, runAgyReviewer } from "../review/agy-runner";
import { isStageKey, readLatestRecord, isRecordFresh } from "../stage-gate/store";
import { recordDiagnostic } from "../diagnostics";

export interface ReviewerConfig {
	model: string;
	thinkingLevel?: string;
}

/** Explicit review depth. Omitted keeps legacy behavior. */
export type MultiReviewerMode = "single" | "deep";

export interface MultiReviewerInput {
	stepName: string;
	primaryOutput: string;
	repoRoot: string;
	mode?: MultiReviewerMode;
}

export interface ReviewFinding {
	severity: "high" | "moderate" | "low";
	summary: string;
	evidence: string;
	recommendedAction: string;
	relatedPlanUnit?: string;
	relatedLearning?: string;
	reviewer?: string;
	autofixable?: boolean;
	autofixApplied?: boolean;
	autofixSummary?: string;
}

export interface MultiReviewerResult {
	findings: ReviewFinding[];
	compiledSummary: string;
	/**
	 * Absolute path to the persisted findings JSON file inside
	 * `.context/compound-engineering/review-findings/`. Present whenever a
	 * reviewer ran — including a clean run that produced zero findings.
	 */
	findingsPath?: string;
	/**
	 * Repo-relative path to the persisted findings JSON file. Stable across
	 * machines and safe to embed in handoffs.
	 */
	findingsRelativePath?: string;
}

const REVIEW_FINDINGS_DIR = "review-findings";

function reviewFindingsDir(repoRoot: string): string {
	return path.join(
		repoRoot,
		".context",
		"compound-engineering",
		REVIEW_FINDINGS_DIR,
	);
}

function buildReviewFindingsFileName(
	stepName: string,
	timestamp: string,
): string {
	const slug = normalizeSlug(stepName) || "review";
	// Example: 2026-06-28T21-47-30-007Z-04-review.json
	const safeTs = timestamp.replace(/[:.]/g, "-");
	return `${safeTs}-${slug}.json`;
}

async function persistFindings(
	repoRoot: string,
	stepName: string,
	findings: ReviewFinding[],
	compiledSummary: string,
	reviewedGate?: { updatedAt: string; artifactsHash: string },
): Promise<{ absolute: string; relative: string }> {
	const dir = reviewFindingsDir(repoRoot);
	await mkdir(dir, { recursive: true });

	const timestamp = new Date().toISOString();
	const fileName = buildReviewFindingsFileName(stepName, timestamp);
	const absolute = path.join(dir, fileName);
	const relative = path.join(
		".context",
		"compound-engineering",
		REVIEW_FINDINGS_DIR,
		fileName,
	);

	const payload = {
		stepName,
		generatedAt: timestamp,
		count: findings.length,
		findings,
		compiledSummary,
		...(reviewedGate ? { completed: true, reviewedGate } : {}),
	};

	await writeFile(absolute, JSON.stringify(payload, null, 2), "utf8");

	return { absolute, relative };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	if (process.platform === "win32") {
		// ponytail: invoke the published npm JS bin directly; artifact text must never enter cmd.exe.
		for (const directory of (process.env.PATH ?? "").split(";").filter(Boolean)) {
			const executable = path.join(directory, "pi.exe");
			if (fs.existsSync(executable)) return { command: executable, args };
			if (!fs.existsSync(path.join(directory, "pi.cmd"))) continue;
			const packageRoot = path.join(directory, "node_modules", "@earendil-works", "pi-coding-agent");
			try {
				const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")) as { name?: unknown; bin?: { pi?: unknown } };
				if (manifest.name !== "@earendil-works/pi-coding-agent" || typeof manifest.bin?.pi !== "string") throw new Error("unknown Pi npm bin contract");
				const script = path.resolve(packageRoot, manifest.bin.pi);
				const relative = path.relative(packageRoot, script);
				if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || !script.endsWith(".js") || !fs.statSync(script).isFile()) throw new Error("invalid Pi npm entrypoint");
				return { command: process.execPath, args: [script, ...args] };
			} catch (error) {
				throw new Error(`Cannot resolve shell-free Windows Pi npm entrypoint: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		throw new Error("Cannot resolve shell-free Windows Pi executable; install Pi with npm or launch from its script/binary");
	}
	return { command: "pi", args };
}

function extractFindings(
	text: string,
	defaultReviewerName: string,
): ReviewFinding[] {
	const match = text.match(/^\s*```json\s*([\s\S]*?)\s*```\s*$/);
	const jsonStr = match ? match[1] : text;
	let parsed: unknown;
	try {
		parsed = JSON.parse(jsonStr.trim()) as unknown;
	} catch {
		throw new Error(`Reviewer ${defaultReviewerName} returned malformed findings JSON`);
	}
	if (!Array.isArray(parsed)) throw new Error(`Reviewer ${defaultReviewerName} did not return a findings array`);
	return parsed.map((item: unknown): ReviewFinding => {
		if (typeof item !== "object" || item === null || Array.isArray(item)) {
			throw new Error(`Reviewer ${defaultReviewerName} returned a non-object finding`);
		}
		const finding = item as Record<string, unknown>;
		const { severity, summary, evidence } = finding;
		const recommendedAction = finding.recommendedAction || finding.recommended_action;
		if (severity !== "high" && severity !== "moderate" && severity !== "low") {
			throw new Error(`Reviewer ${defaultReviewerName} returned an invalid finding severity`);
		}
		if (typeof summary !== "string" || !summary.trim() || typeof evidence !== "string" || !evidence.trim() || typeof recommendedAction !== "string" || !recommendedAction.trim()) {
			throw new Error(`Reviewer ${defaultReviewerName} returned a finding with missing required text`);
		}
		return {
			severity,
			summary,
			evidence,
			recommendedAction,
			relatedPlanUnit: finding.relatedPlanUnit
				? String(finding.relatedPlanUnit)
				: undefined,
			relatedLearning: finding.relatedLearning
				? String(finding.relatedLearning)
				: undefined,
			reviewer: finding.reviewer ? String(finding.reviewer) : defaultReviewerName,
			autofixable: !!finding.autofixable,
		};
	});
}

function buildReviewerPrompt(stepName: string, reviewerName: string): string {
	let normalizedKey = stepName.trim().toLowerCase();
	if (normalizedKey.startsWith("0")) {
		const mapped = getConfigKeyForSkill(normalizedKey);
		if (mapped) normalizedKey = mapped;
	}
	const prompts: Record<string, { role: string; task: string; evidence: string }> = {
		brainstorm: { role: "You are a product owner and systems architect design validator.", task: "Analyze the requirements discovery artifact for ambiguity, boundary cases, unstated assumptions, and architecture feasibility.", evidence: "quote or section in the requirements document" },
		plan: { role: "You are a principal engineer and planning validator.", task: "Analyze the implementation plan for completeness, ordering, API documentation validation, and TDD enforcement.", evidence: "quote or section in the plan document" },
		review: { role: "You are a senior code review and verification validator.", task: "Analyze the review findings report for soundness, cited evidence, and complete verification steps.", evidence: "finding description or evidence cited" },
		learn: { role: "You are a knowledge manager and solution card validator.", task: "Analyze the proposed solution card for context, categories, tags, overlap rules, and search strategy.", evidence: "quote or section in the solution card" },
	};
	const prompt = prompts[normalizedKey] ?? { role: "You are a professional peer reviewer.", task: "Perform a critical review of the provided artifact/work output.", evidence: "specific quote or section of the artifact" };
	return `${prompt.role} ${prompt.task}
Compile a list of findings following this JSON schema:
[
  {
    "severity": "high" | "moderate" | "low",
    "summary": "one-line description",
    "evidence": "${prompt.evidence}",
    "recommendedAction": "what should be done to address the finding",
    "reviewer": "${reviewerName}",
    "autofixable": false
  }
]
Format your response as a JSON array of findings wrapped in a markdown code block. Do not output anything else.`;
}

async function runReviewerProcess(
	reviewer: ReviewerConfig,
	index: number,
	primaryOutput: string,
	repoRoot: string,
	stepName: string,
): Promise<ReviewFinding[]> {
	const reviewerName = `Reviewer #${index + 1} (${reviewer.model})`;
	const systemPrompt = buildReviewerPrompt(stepName, reviewerName);
	if (isGeminiModel(reviewer.model)) {
		const stateRoot = mkdtempSync(path.join(tmpdir(), "pi-pedstack-agy-state-"));
		try {
			return await runAgyReviewer({
				model: reviewer.model,
				reviewer: reviewerName,
				stage: stepName,
				repoRoot,
				task: systemPrompt,
				prompt: primaryOutput,
				thinkingLevel: reviewer.thinkingLevel,
				stateRoot,
				shippedPluginDirectory: path.resolve(import.meta.dirname, "../../../plugins/agy-reviewer"),
			});
		} finally {
			rmSync(stateRoot, { recursive: true, force: true });
		}
	}
	const args: string[] = [
		"--mode",
		"json",
		"-p",
		"--no-session",
		"--model",
		reviewer.model,
	];
	// Only an explicit reviewer that set a level (or the models.review role, which
	// defaults to high in resolveReviewRole) passes --thinking.
	if (reviewer.thinkingLevel) {
		args.push("--thinking", reviewer.thinkingLevel);
	}
	args.push(
		"--system-prompt",
		systemPrompt,
		`Review the following artifact/work output:\n\n${primaryOutput}`,
	);

	const invocation = getPiInvocation(args);
	const result = await createAgyCommand()(invocation.command, invocation.args, { cwd: repoRoot });
	if (result.code !== 0) throw new Error(`Reviewer process ${index + 1} exited with code ${result.code}`);

	let stdout = "";
	const processLine = (line: string) => {
		if (!line.trim()) return;
		try {
			const event = JSON.parse(line);
			if (event.type === "message_end" && event.message) {
				const content = event.message.content;
				if (Array.isArray(content)) {
					for (const part of content) {
						if (part.type === "text") stdout += part.text;
					}
				}
			}
		} catch {
			// Not a JSON event or malformed line.
		}
	};
	for (const line of result.stdout.split("\n")) processLine(line);
	return extractFindings(stdout, reviewerName);
}

/**
 * Resolve the `models.review` role as a single reviewer. Review independence
 * comes from the dedicated no-session reviewer process, so this role may reuse
 * the same model id as default/SOTA execution.
 */
function resolveReviewRole(
	config: PiPedstackConfig | null,
	_configKey: StepConfigKey | null,
): ReviewerConfig[] | undefined {
	const review = config?.models?.review;
	if (!review?.model) return undefined;
	return [{ model: review.model, thinkingLevel: review.thinkingLevel ?? "high" }];
}

/** The config key for a stage name (`02-plan`) or a bare key (`plan`). */
const BARE_CONFIG_KEYS = new Map<string, StepConfigKey>();
for (const stageName of [
	"01-brainstorm",
	"02-plan",
	"03-work",
	"04-review",
	"04-5-debug",
	"05-learn",
	"06-docsync",
]) {
	const key = getConfigKeyForSkill(stageName);
	if (key) BARE_CONFIG_KEYS.set(key, key);
}

function resolveConfigKey(stepName: string): StepConfigKey | null {
	const normalized = stepName.trim().toLowerCase();
	return getConfigKeyForSkill(normalized) ?? BARE_CONFIG_KEYS.get(normalized) ?? null;
}

/** Non-empty explicit `reviewers[]` for the stage, or undefined. */
function explicitReviewers(
	config: PiPedstackConfig | null,
	configKey: StepConfigKey | null,
): ReviewerConfig[] | undefined {
	if (!config || !configKey) return undefined;
	const stage = config[configKey];
	if (!stage || !("reviewers" in stage)) return undefined;
	const reviewers = stage.reviewers;
	if (!Array.isArray(reviewers) || reviewers.length === 0) return undefined;
	const mapped = reviewers.map((reviewer) => ({
		model: reviewer.model,
		thinkingLevel: reviewer.thinkingLevel,
	}));
	const { reviewers: filteredReviewers } = filterIndependentReviewers(
		mapped,
		config,
		configKey,
	);
	return filteredReviewers.length > 0 ? filteredReviewers : undefined;
}

export function createMultiReviewerTool() {
	return {
		name: "multi_reviewer",
		async execute(input: MultiReviewerInput): Promise<MultiReviewerResult> {
			// Read configuration automatically
			const config = await readPiPedstackConfig(input.repoRoot);
			const configKey = resolveConfigKey(input.stepName);

			// Explicit reviewers[] win; otherwise fall back to the `models.review` role.
			// `single` bounds the selection to one reviewer; omitted mode keeps legacy behavior.
			let reviewers = explicitReviewers(config, configKey);
			if (!reviewers || reviewers.length === 0) {
				reviewers = resolveReviewRole(config, configKey);
			}
			if (reviewers && input.mode === "single") {
				reviewers = reviewers.slice(0, 1);
			}

			if (!reviewers || reviewers.length === 0) {
				recordDiagnostic({ feature: "review", event: "review_skipped", stage: input.stepName, independentReviewers: 0, outcome: "success" });
				return {
					findings: [],
					compiledSummary: "No reviewers configured.",
				};
			}

			// Bind completion to the gate that requested review, when one exists.
			const stage = input.stepName.trim();
			const requestedGate = isStageKey(stage)
				? await readLatestRecord(input.repoRoot, stage)
				: null;
			const reviewGate = requestedGate?.verdict === "review" && requestedGate.review?.action === "review" && await isRecordFresh(input.repoRoot, requestedGate)
				? { updatedAt: requestedGate.updatedAt, artifactsHash: requestedGate.artifactsHash }
				: undefined;

			// Run all reviewer processes concurrently
			const promises = reviewers.map((reviewer, idx) =>
				runReviewerProcess(
					reviewer,
					idx,
					input.primaryOutput,
					input.repoRoot,
					input.stepName,
				),
			);
			const settled = await Promise.allSettled(promises);
			recordDiagnostic({ feature: "review", event: "review_attempt", stage: input.stepName, independentReviewers: reviewers.length, outcome: settled.some((result) => result.status === "rejected") ? "failure" : "success" });
			const failures = settled.flatMap((result, index) => result.status === "rejected"
				? [`Reviewer #${index + 1} (${reviewers[index]?.model ?? "unknown"}): ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`]
				: []);
			if (failures.length > 0) throw new Error(`Review incomplete; no success sidecar was written. ${failures.join("; ")}`);
			const findings = settled.flatMap((result) => result.status === "fulfilled" ? result.value : []);

			// Compile markdown summary of findings
			let summary = `# Multi-Model Review Summary\n\n`;
			summary += `We ran the review across ${reviewers.length} reviewer model(s). `;
			summary += `A total of ${findings.length} finding(s) were flagged.\n\n`;

			const high = findings.filter((f) => f.severity === "high");
			const moderate = findings.filter((f) => f.severity === "moderate");
			const low = findings.filter((f) => f.severity === "low");

			if (high.length > 0) {
				summary += `## 🔴 High Severity (${high.length})\n\n`;
				for (const f of high) {
					summary += `- **[${f.reviewer ?? "Reviewer"}]**: ${f.summary}\n`;
					summary += `  - *Evidence*: \`${f.evidence}\`\n`;
					summary += `  - *Recommendation*: ${f.recommendedAction}\n`;
				}
				summary += `\n`;
			}

			if (moderate.length > 0) {
				summary += `## 🟡 Moderate Severity (${moderate.length})\n\n`;
				for (const f of moderate) {
					summary += `- **[${f.reviewer ?? "Reviewer"}]**: ${f.summary}\n`;
					summary += `  - *Evidence*: \`${f.evidence}\`\n`;
					summary += `  - *Recommendation*: ${f.recommendedAction}\n`;
				}
				summary += `\n`;
			}

			if (low.length > 0) {
				summary += `## 🟢 Low Severity (${low.length})\n\n`;
				for (const f of low) {
					summary += `- **[${f.reviewer ?? "Reviewer"}]**: ${f.summary}\n`;
					summary += `  - *Evidence*: \`${f.evidence}\`\n`;
					summary += `  - *Recommendation*: ${f.recommendedAction}\n`;
				}
				summary += `\n`;
			}

			if (findings.length === 0) {
				summary += `### ✅ No issues identified.\n`;
			}

			const trimmedSummary = summary.trim();

			// Persist findings JSON inside .context/ so it is gitignored automatically.
			// The previous behavior was to let the agent write a stray review-findings.json
			// to the repo root, which leaked into git history. A zero-finding run still
			// writes the empty sidecar so a clean review is auditable and does not deadlock
			// the completion gate (`count: 0` === `findings.length`).
			const stillFresh = requestedGate && reviewGate && await isRecordFresh(input.repoRoot, requestedGate);
			const persisted = await persistFindings(
				input.repoRoot,
				input.stepName,
				findings,
				trimmedSummary,
				stillFresh ? reviewGate : undefined,
			);

			return {
				findings,
				compiledSummary: trimmedSummary,
				findingsPath: persisted.absolute,
				findingsRelativePath: persisted.relative,
			};
		},
	};
}
