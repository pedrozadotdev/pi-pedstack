import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { normalizeSlug } from "../utils/name-utils";
import { evaluateCompletionGate } from "../stage-gate/guard";
import { isCompletionSave } from "../stage-gate/store";
import type { StageGateMode } from "../stage-gate/types";
import { THRESHOLDS_VERSION } from "../handoff-readiness/combine";
import {
	DRIFT_DIR,
	isDriftRecordFresh,
	readDriftRecord,
	shouldBlockCompletion,
	type DriftRecord,
} from "../drift/store";
import type {
	DriftDimensionId,
	DriftMode,
	DriftSource,
	DriftVerdict,
} from "../drift/types";
import {
	createReadinessGuard,
	type ReadinessGuard,
} from "../handoff-readiness/guard";
import {
	pairSlug,
	readReadinessRecord,
	stagePairFromHandoffPath,
} from "../handoff-readiness/store";
import { createJevRuntime } from "../jev/runtime";
import type { JevRuntime } from "../jev/types";
import type {
	ReadinessMode,
	ReadinessOutcome,
	ReadinessResult,
	ReadinessState,
} from "../handoff-readiness/types";
import { readChecklist } from "./checklist";

type ContextHealth = "good" | "watch" | "heavy" | "critical";

type ContextHandoffRecommendedAction =
	| "continue"
	| "save_handoff"
	| "fill_required_context";

interface ContextHandoffValidationCheck {
	name: string;
	passed: boolean;
	reason: string;
}

interface ContextHandoffValidationProbes {
	recall: boolean;
	continuation: boolean;
	artifact: boolean;
	decision: boolean;
}

export interface ContextHandoffInput {
	operation: "save" | "load" | "latest" | "status" | "validate";
	repoRoot: string;
	currentStage?: string;
	nextStage?: string;
	contextHealth?: ContextHealth;
	activeFiles?: string[];
	blocker?: string;
	verification?: string;
	artifacts?: Record<string, string | undefined>;
	handoffMarkdown?: string;
	handoffPath?: string;
	currentTruth?: string[];
	invalidatedAssumptions?: string[];
	openDecisions?: string[];
	recentlyAccessedFiles?: string[];
	compressionRisk?: string[];
	activeRules?: string[];
}

interface ContextStateEntry {
	currentStage: string;
	nextStage?: string;
	contextHealth: ContextHealth;
	latestHandoffPath?: string;
	latestDatedHandoffPath?: string;
	activeFiles: string[];
	blocker?: string;
	verification?: string;
	artifacts: Record<string, string | undefined>;
	currentTruth: string[];
	invalidatedAssumptions: string[];
	openDecisions: string[];
	recentlyAccessedFiles: string[];
	compressionRisk: string[];
	activeRules: string[];
	recommendNewSession: boolean;
	updatedAt: string;
}

interface ContextHandoffResult {
	operation: string;
	found?: boolean;
	path?: string;
	latestPath?: string;
	currentStage?: string;
	nextStage?: string;
	contextHealth?: ContextHealth;
	activeFiles?: string[];
	blocker?: string;
	verification?: string;
	artifacts?: Record<string, string | undefined>;
	recommendNewSession?: boolean;
	handoffMarkdown?: string;
	currentTruth?: string[];
	invalidatedAssumptions?: string[];
	openDecisions?: string[];
	recentlyAccessedFiles?: string[];
	compressionRisk?: string[];
	activeRules?: string[];
	updatedAt?: string;
	gateWarning?: string;
	readiness?: ReadinessOutcome;
	drift?: ContextHandoffDriftAdvice;
	// Validation fields
	ok?: boolean;
	probes?: ContextHandoffValidationProbes;
	checks?: ContextHandoffValidationCheck[];
	missing?: string[];
	warnings?: string[];
	recommendedAction?: ContextHandoffRecommendedAction;
}

function ceDir(repoRoot: string): string {
	return path.join(repoRoot, ".context", "compound-engineering");
}

function handoffDir(repoRoot: string): string {
	return path.join(ceDir(repoRoot), "handoffs");
}

function stateFilePath(repoRoot: string): string {
	return path.join(ceDir(repoRoot), "context-state.json");
}

function latestHandoffPath(repoRoot: string): string {
	return path.join(handoffDir(repoRoot), "latest.md");
}

function toRepoRelative(repoRoot: string, filePath: string): string {
	return path.relative(repoRoot, filePath).replace(/\\/g, "/");
}

function resolveRepoPath(repoRoot: string, filePath: string): string {
	return path.isAbsolute(filePath) ? filePath : path.join(repoRoot, filePath);
}

function stageSlug(value?: string): string {
	if (!value || value.trim().length === 0) return "unknown";
	return normalizeSlug(value);
}

function buildDatedHandoffPath(
	repoRoot: string,
	currentStage?: string,
	nextStage?: string,
): string {
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	const fileName = `${timestamp}-${stageSlug(currentStage)}-to-${stageSlug(nextStage)}.md`;
	return path.join(handoffDir(repoRoot), fileName);
}

function computeRecommendNewSession(
	currentStage?: string,
	nextStage?: string,
	contextHealth: ContextHealth = "watch",
): boolean {
	const isCrossPhase = Boolean(
		currentStage && nextStage && currentStage !== nextStage,
	);
	const isHeavy = contextHealth === "heavy" || contextHealth === "critical";
	return isCrossPhase && isHeavy;
}

function formatBullets(items: string[]): string {
	if (items.length === 0) return "- N/A";
	return items.map((item) => `- ${item}`).join("\n");
}

function formatArtifacts(
	artifacts: Record<string, string | undefined>,
): string {
	const lines = Object.entries(artifacts)
		.filter(([, value]) => Boolean(value && value.trim().length > 0))
		.map(([key, value]) => `- ${key}: ${value}`);

	if (lines.length === 0) return "- N/A";
	return lines.join("\n");
}

function buildDefaultHandoffMarkdown(input: {
	currentStage: string;
	nextStage?: string;
	activeFiles: string[];
	artifacts: Record<string, string | undefined>;
	blocker?: string;
	verification?: string;
	currentTruth: string[];
	invalidatedAssumptions: string[];
	openDecisions: string[];
	recentlyAccessedFiles: string[];
	compressionRisk: string[];
	activeRules: string[];
}): string {
	const currentTask = input.nextStage
		? `Continue from ${input.currentStage} to ${input.nextStage}.`
		: `Continue ${input.currentStage}.`;

	const hotContext = formatBullets(input.activeFiles.slice(0, 5));

	const verifiedFacts = formatBullets([
		`Current stage: ${input.currentStage}`,
		`Next stage: ${input.nextStage ?? "N/A"}`,
	]);

	const activeFiles = formatBullets(input.activeFiles.slice(0, 5));
	const artifacts = formatArtifacts(input.artifacts);
	const blocker = input.blocker ?? "N/A";
	const verification = input.verification ?? "Not run";
	const nextMinimalStep = input.nextStage ? `/ped-next` : "N/A";

	return [
		"## Current Task",
		currentTask,
		"",
		"## Hot Context",
		hotContext,
		"",
		"## Current Truth",
		formatBullets(input.currentTruth),
		"",
		"## Verified Facts",
		verifiedFacts,
		"",
		"## Invalidated Assumptions",
		formatBullets(input.invalidatedAssumptions),
		"",
		"## Open Decisions",
		formatBullets(input.openDecisions),
		"",
		"## Active Files",
		activeFiles,
		"",
		"## Active Rules",
		formatBullets(input.activeRules),
		"",
		"## Recently Accessed Files",
		formatBullets(input.recentlyAccessedFiles),
		"",
		"## Artifacts",
		artifacts,
		"",
		"## Current Blocker",
		`- ${blocker}`,
		"",
		"## Verification",
		`- ${verification}`,
		"",
		"## Compression Risk",
		formatBullets(input.compressionRisk),
		"",
		"## Do Not Repeat",
		"- Do not reload full history unless the handoff lacks required evidence.",
		"",
		"## Next Minimal Step",
		`- ${nextMinimalStep}`,
		"",
	].join("\n");
}

function toStringArray(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string")
		: [];
}

function normalizeStateEntry(raw: unknown): ContextStateEntry | null {
	if (!raw || typeof raw !== "object") return null;

	const state = raw as Record<string, unknown>;
	const activeFiles = toStringArray(state.activeFiles);

	return {
		currentStage:
			typeof state.currentStage === "string" ? state.currentStage : "unknown",
		nextStage:
			typeof state.nextStage === "string" ? state.nextStage : undefined,
		contextHealth: isContextHealth(state.contextHealth)
			? state.contextHealth
			: "watch",
		latestHandoffPath:
			typeof state.latestHandoffPath === "string"
				? state.latestHandoffPath
				: undefined,
		latestDatedHandoffPath:
			typeof state.latestDatedHandoffPath === "string"
				? state.latestDatedHandoffPath
				: undefined,
		activeFiles,
		blocker: typeof state.blocker === "string" ? state.blocker : undefined,
		verification:
			typeof state.verification === "string" ? state.verification : undefined,
		artifacts: isStringRecord(state.artifacts) ? state.artifacts : {},
		currentTruth: toStringArray(state.currentTruth),
		invalidatedAssumptions: toStringArray(state.invalidatedAssumptions),
		openDecisions: toStringArray(state.openDecisions),
		recentlyAccessedFiles:
			toStringArray(state.recentlyAccessedFiles).length > 0
				? toStringArray(state.recentlyAccessedFiles)
				: activeFiles.slice(0, 5),
		compressionRisk: toStringArray(state.compressionRisk),
		activeRules: toStringArray(state.activeRules),
		recommendNewSession:
			typeof state.recommendNewSession === "boolean"
				? state.recommendNewSession
				: false,
		updatedAt:
			typeof state.updatedAt === "string"
				? state.updatedAt
				: new Date(0).toISOString(),
	};
}

function isContextHealth(value: unknown): value is ContextHealth {
	return (
		value === "good" ||
		value === "watch" ||
		value === "heavy" ||
		value === "critical"
	);
}

function isStringRecord(
	value: unknown,
): value is Record<string, string | undefined> {
	if (!value || typeof value !== "object") return false;
	return Object.values(value).every(
		(item) => item === undefined || typeof item === "string",
	);
}

async function readState(repoRoot: string): Promise<ContextStateEntry | null> {
	const filePath = stateFilePath(repoRoot);
	if (!existsSync(filePath)) return null;

	try {
		const content = await readFile(filePath, "utf8");
		return normalizeStateEntry(JSON.parse(content));
	} catch {
		return null;
	}
}

async function writeState(
	repoRoot: string,
	state: ContextStateEntry,
): Promise<void> {
	const filePath = stateFilePath(repoRoot);
	await mkdir(path.dirname(filePath), { recursive: true });
	await writeFile(filePath, JSON.stringify(state, null, 2), "utf8");
}

export interface ContextHandoffReadinessOptions {
	mode: ReadinessMode;
	failClosed: boolean;
	/** Test injection; a lazy `createJevRuntime` is used otherwise. */
	runtime?: JevRuntime;
	now?: () => Date;
	fileExists?: (repoRoot: string, relPath: string) => boolean;
}

export interface ContextHandoffDriftOptions {
	mode: DriftMode;
	failClosed: boolean;
	sessionKey: () => string;
	now?: () => Date;
	/** Test injection; defaults to the shared drift store reader. */
	readRecord?: (
		repoRoot: string,
		stage: string,
	) => Promise<DriftRecord | null>;
}

/** Advisory (no-Jev) drift summary surfaced from `validate` (AD-4). */
interface ContextHandoffDriftAdvice {
	verdict: DriftVerdict;
	source: DriftSource;
	triggered: DriftDimensionId[];
	fresh: boolean;
	reason?: string;
	correction?: string;
}

export function createContextHandoffTool(
	options: {
		gateMode?: StageGateMode;
		readiness?: ContextHandoffReadinessOptions;
		drift?: ContextHandoffDriftOptions;
	} = {},
) {
	const gateMode = options.gateMode ?? "off";
	const readiness = options.readiness;
	const drift = options.drift;
	const readinessGuard = readiness
		? createReadinessGuard({
				mode: readiness.mode,
				failClosed: readiness.failClosed,
				createJev: () => readiness.runtime ?? createJevRuntime(),
				now: readiness.now,
				fileExists: readiness.fileExists,
			})
		: null;
	return {
		name: "context_handoff",
		async execute(input: ContextHandoffInput): Promise<ContextHandoffResult> {
			switch (input.operation) {
				case "save":
					return save(input, gateMode, readinessGuard, drift);
				case "load":
					return load(input);
				case "latest":
					return latest(input);
				case "status":
					return status(input);
				case "validate":
					return validate(input, readiness, drift);
				default:
					throw new Error(`Unknown operation: ${input.operation}`);
			}
		},
	};
}

/** Runs the stage gate for a save and returns a blocker or a warning only. */
async function runCompletionGate(
	input: ContextHandoffInput,
	currentStage: string,
	nextStage: string | undefined,
	gateMode: StageGateMode,
): Promise<{ blocker?: string; warning?: string }> {
	try {
		const gate = await evaluateCompletionGate(
			input.repoRoot,
			currentStage,
			nextStage,
			gateMode,
		);
		if (gate.gated && !gate.allowed) return { blocker: gate.blocker };
		if (gate.warning) return { warning: gate.warning };
		return {};
	} catch {
		// evaluateCompletionGate fails open internally; belt-and-braces.
		return {};
	}
}

interface ReadinessRunParams {
	repoRoot: string;
	currentStage: string;
	nextStage?: string;
	handoffMarkdown: string;
	blocker?: string;
	verification?: string;
	activeFiles: string[];
	artifacts: Record<string, string | undefined>;
	currentTruth: string[];
	invalidatedAssumptions: string[];
	openDecisions: string[];
	recentlyAccessedFiles: string[];
	activeRules: string[];
	guard: ReadinessGuard | null;
}

interface ReadinessRun {
	blocked: boolean;
	blocker?: string;
	warning?: string;
	outcome?: ReadinessOutcome;
}

function cleanArtifacts(
	artifacts: Record<string, string | undefined>,
): Record<string, string> {
	const clean: Record<string, string> = {};
	for (const [key, value] of Object.entries(artifacts)) {
		if (typeof value === "string") clean[key] = value;
	}
	return clean;
}

/** Exact Jev `state` shape, built from the save's normalized fields. */
function buildReadinessState(params: ReadinessRunParams): ReadinessState {
	return {
		currentStage: params.currentStage,
		nextStage: params.nextStage ?? "",
		handoffMarkdown: params.handoffMarkdown,
		currentTask: extractSection(params.handoffMarkdown, "Current Task"),
		nextMinimalStep: extractSection(
			params.handoffMarkdown,
			"Next Minimal Step",
		),
		verification:
			params.verification ??
			extractSection(params.handoffMarkdown, "Verification"),
		blocker: params.blocker ?? "",
		openDecisions: params.openDecisions,
		currentTruth: params.currentTruth,
		invalidatedAssumptions: params.invalidatedAssumptions,
		activeFiles: params.activeFiles,
		recentlyAccessedFiles: params.recentlyAccessedFiles,
		artifacts: cleanArtifacts(params.artifacts),
		activeRules: params.activeRules,
	};
}

function toReadinessOutcome(
	result: ReadinessResult,
): ReadinessOutcome | undefined {
	if (!result.verdict || !result.source) return undefined;
	return {
		verdict: result.verdict,
		source: result.source,
		dimensions: result.dimensions ?? [],
		corrections: result.corrections ?? [],
		...(result.reason ? { reason: result.reason } : {}),
	};
}

/** Runs the readiness guard when configured; a block returns before any write. */
async function runReadinessGuard(
	params: ReadinessRunParams,
): Promise<ReadinessRun> {
	if (!params.guard) return { blocked: false };
	const result = await params.guard.evaluate({
		repoRoot: params.repoRoot,
		currentStage: params.currentStage,
		nextStage: params.nextStage ?? "",
		state: buildReadinessState(params),
	});
	const outcome = toReadinessOutcome(result);
	if (result.gated && !result.allowed && result.blocker) {
		return { blocked: true, blocker: result.blocker, outcome };
	}
	return { blocked: false, warning: result.warning, outcome };
}

function resolveReadinessPair(
	input: ContextHandoffInput,
	state: ContextStateEntry | null,
	handoffFile: string,
): string | null {
	if (isMeaningfulStage(input.currentStage)) {
		return pairSlug(input.currentStage, input.nextStage);
	}
	if (state && isMeaningfulStage(state.currentStage)) {
		return pairSlug(state.currentStage, state.nextStage);
	}
	const fromPath = stagePairFromHandoffPath(input.handoffPath ?? handoffFile);
	if (fromPath) return pairSlug(fromPath.currentStage, fromPath.nextStage);
	return null;
}

/**
 * Advisory surfacing for `validate`. Never calls Jev. Keyed on the resolved
 * pair + thresholds version so a record written by a blocked save (which leaves
 * no handoff artifact) is still readable.
 */
async function surfaceReadiness(
	input: ContextHandoffInput,
	readiness: ContextHandoffReadinessOptions | undefined,
	state: ContextStateEntry | null,
	handoffFile: string,
): Promise<ReadinessOutcome | undefined> {
	if (!readiness || readiness.mode === "off") return undefined;
	const pair = resolveReadinessPair(input, state, handoffFile);
	if (!pair) return undefined;
	const record = await readReadinessRecord(input.repoRoot, pair);
	if (
		!record ||
		record.pair !== pair ||
		record.thresholdsVersion !== THRESHOLDS_VERSION
	) {
		return undefined;
	}
	return {
		verdict: record.verdict,
		source: record.source,
		dimensions: record.dimensions,
		corrections: record.corrections,
		...(record.reason ? { reason: record.reason } : {}),
	};
}

interface DriftRun {
	blocked: boolean;
	blocker?: string;
	warning?: string;
	advice?: ContextHandoffDriftAdvice;
}

function driftRecordRelPath(stage: string): string {
	return `${DRIFT_DIR}/${normalizeSlug(stage) || "unknown"}.json`;
}

function driftAdvice(
	record: DriftRecord,
	fresh: boolean,
): ContextHandoffDriftAdvice {
	return {
		verdict: record.verdict,
		source: record.source,
		triggered: record.triggered,
		fresh,
		...(record.reason ? { reason: record.reason } : {}),
		...(record.correction ? { correction: record.correction } : {}),
	};
}

function strongDriftBlocker(record: DriftRecord): string {
	const dims =
		record.triggered.length > 0 ? record.triggered.join(", ") : "unspecified";
	const reason = record.reason ? `${record.reason}. ` : "";
	return (
		`Cannot save cross-stage handoff: stage "${record.stage}" has unresolved ` +
		`strong drift: ${dims}. ${reason}` +
		`Do in-scope work for 2 turns to clear, delete ` +
		`${driftRecordRelPath(record.stage)} to clear, or set ` +
		`PEDSTACK_DRIFT_GUARD=off (restart required).`
	);
}

function degradedDriftBlocker(stage: string): string {
	return (
		`Cannot save cross-stage handoff: drift status is unknown for stage ` +
		`"${stage}" (semantic drift layer degraded) and ` +
		`PEDSTACK_DRIFT_GUARD_FAILCLOSED=1. Re-run in-scope work, delete ` +
		`${driftRecordRelPath(stage)} to clear, or set PEDSTACK_DRIFT_GUARD=off ` +
		`(restart required).`
	);
}

/** Shared read of the latest record; a reader failure is treated as absent. */
async function readDriftRecordSafe(
	drift: ContextHandoffDriftOptions,
	repoRoot: string,
	stage: string,
): Promise<DriftRecord | null> {
	try {
		const read = drift.readRecord ?? readDriftRecord;
		return await read(repoRoot, stage);
	} catch {
		return null;
	}
}

/**
 * AD-5 completion rule. Off/same-stage are not gated; shadow warns only;
 * enforce blocks a fresh `jev` strong record and (with failClosed) an unknown
 * drift status. Every read goes through the shared freshness predicate.
 */
async function runDriftCompletion(
	drift: ContextHandoffDriftOptions | undefined,
	repoRoot: string,
	currentStage: string,
	nextStage: string | undefined,
): Promise<DriftRun> {
	if (!drift || drift.mode === "off") return { blocked: false };
	if (!isCompletionSave(currentStage, nextStage)) return { blocked: false };

	const now = (drift.now ?? (() => new Date()))();
	const sessionKey = drift.sessionKey();
	const record = await readDriftRecordSafe(drift, repoRoot, currentStage);
	const fresh = isDriftRecordFresh(record, currentStage, sessionKey, now);
	const advice = record ? driftAdvice(record, fresh) : undefined;

	if (drift.mode === "enforce") {
		if (shouldBlockCompletion(record, currentStage, sessionKey, now)) {
			return {
				blocked: true,
				blocker: strongDriftBlocker(record as DriftRecord),
				advice,
			};
		}
		if (drift.failClosed && !fresh) {
			return {
				blocked: true,
				blocker: degradedDriftBlocker(currentStage),
				advice,
			};
		}
		return { blocked: false, advice };
	}

	if (shouldBlockCompletion(record, currentStage, sessionKey, now)) {
		const dims =
			(record as DriftRecord).triggered.join(", ") || "unspecified";
		return {
			blocked: false,
			warning:
				`unresolved drift warning: stage "${currentStage}" has strong drift ` +
				`(${dims}); shadow mode does not block.`,
			advice,
		};
	}
	return { blocked: false, advice };
}

/** Advisory drift read for `validate`; never calls Jev (AD-4). */
async function surfaceDrift(
	input: ContextHandoffInput,
	drift: ContextHandoffDriftOptions | undefined,
	state: ContextStateEntry | null,
	handoffFile: string,
): Promise<ContextHandoffDriftAdvice | undefined> {
	if (!drift || drift.mode === "off") return undefined;
	const fromPath = stagePairFromHandoffPath(input.handoffPath ?? handoffFile);
	const stage =
		input.currentStage ?? state?.currentStage ?? fromPath?.currentStage;
	if (!stage) return undefined;

	const record = await readDriftRecordSafe(drift, input.repoRoot, stage);
	if (!record) return undefined;
	const now = (drift.now ?? (() => new Date()))();
	return driftAdvice(
		record,
		isDriftRecordFresh(record, stage, drift.sessionKey(), now),
	);
}

async function save(
	input: ContextHandoffInput,
	gateMode: StageGateMode,
	readinessGuard: ReadinessGuard | null,
	drift: ContextHandoffDriftOptions | undefined,
): Promise<ContextHandoffResult> {
	const currentStage = input.currentStage ?? "unknown";
	const nextStage = input.nextStage;
	const contextHealth = input.contextHealth ?? "watch";

	// Block cross-stage saves when checklist is non-empty
	if (nextStage) {
		try {
			const checklist = await readChecklist(input.repoRoot);
			if (checklist.items.length > 0) {
				const taskList = checklist.items
					.map(
						(item: { description: string }, idx: number) =>
							idx + 1 + ". " + item.description,
					)
					.join("\n");
				return {
					operation: "save",
					found: true,
					currentStage,
					nextStage,
					contextHealth,
					blocker:
						"Cannot save cross-stage handoff: checklist has " +
						checklist.items.length +
						" pending task(s).\n\nPending tasks:\n" +
						taskList +
						"\n\nUse \\`checklist_del\\` to remove completed tasks before saving.",
				};
			}
		} catch {
			// If readChecklist throws unexpectedly, allow save to proceed safely
		}
	}
	// Stage gate: deterministic floor in both modes, record check in enforce (AD-2).
	const gate = await runCompletionGate(input, currentStage, nextStage, gateMode);
	if (gate.blocker) {
		return {
			operation: "save",
			found: true,
			currentStage,
			nextStage,
			contextHealth,
			blocker: gate.blocker,
		};
	}
	const gateWarning = gate.warning;

	// Drift block: after the stage gate, before the readiness guard (AD-5).
	const driftRun = await runDriftCompletion(
		drift,
		input.repoRoot,
		currentStage,
		nextStage,
	);
	if (driftRun.blocked) {
		return {
			operation: "save",
			found: true,
			currentStage,
			nextStage,
			contextHealth,
			blocker: driftRun.blocker,
			drift: driftRun.advice,
		};
	}

	const activeFiles = input.activeFiles ?? [];
	// Normalize: treat placeholder/N/A-ish blockers as absent so they don't block /ped-next
	const blocker =
		input.blocker && !isPlaceholder(input.blocker) ? input.blocker : undefined;
	const verification = input.verification;
	const artifacts = input.artifacts ?? {};
	const currentTruth = input.currentTruth ?? [];
	const invalidatedAssumptions = input.invalidatedAssumptions ?? [];
	const openDecisions = input.openDecisions ?? [];
	const recentlyAccessedFiles = input.recentlyAccessedFiles?.length
		? input.recentlyAccessedFiles
		: activeFiles.slice(0, 5);
	const compressionRisk = input.compressionRisk ?? [];
	const activeRules = input.activeRules ?? [];

	const handoffMarkdown = input.handoffMarkdown?.trim().length
		? input.handoffMarkdown
		: buildDefaultHandoffMarkdown({
				currentStage,
				nextStage,
				activeFiles,
				artifacts,
				blocker,
				verification,
				currentTruth,
				invalidatedAssumptions,
				openDecisions,
				recentlyAccessedFiles,
				compressionRisk,
				activeRules,
			});

	const readinessRun = await runReadinessGuard({
		repoRoot: input.repoRoot,
		currentStage,
		nextStage,
		handoffMarkdown,
		blocker,
		verification,
		activeFiles,
		artifacts,
		currentTruth,
		invalidatedAssumptions,
		openDecisions,
		recentlyAccessedFiles,
		activeRules,
		guard: readinessGuard,
	});
	if (readinessRun.blocked) {
		return {
			operation: "save",
			found: true,
			currentStage,
			nextStage,
			contextHealth,
			blocker: readinessRun.blocker,
			readiness: readinessRun.outcome,
			drift: driftRun.advice,
		};
	}

	const recommendNewSession = computeRecommendNewSession(
		currentStage,
		nextStage,
		contextHealth,
	);
	const latestPath = latestHandoffPath(input.repoRoot);
	const datedPath = buildDatedHandoffPath(
		input.repoRoot,
		currentStage,
		nextStage,
	);
	const relativeLatestPath = toRepoRelative(input.repoRoot, latestPath);
	const relativeDatedPath = toRepoRelative(input.repoRoot, datedPath);

	await mkdir(path.dirname(latestPath), { recursive: true });
	await writeFile(latestPath, handoffMarkdown, "utf8");
	await writeFile(datedPath, handoffMarkdown, "utf8");

	const state: ContextStateEntry = {
		currentStage,
		nextStage,
		contextHealth,
		latestHandoffPath: relativeLatestPath,
		latestDatedHandoffPath: relativeDatedPath,
		activeFiles,
		blocker,
		verification,
		artifacts,
		currentTruth,
		invalidatedAssumptions,
		openDecisions,
		recentlyAccessedFiles,
		compressionRisk,
		activeRules,
		recommendNewSession,
		updatedAt: new Date().toISOString(),
	};

	await writeState(input.repoRoot, state);

	const combinedWarning =
		[gateWarning, driftRun.warning, readinessRun.warning]
			.filter((entry): entry is string => Boolean(entry))
			.join(" ") || undefined;

	return {
		operation: "save",
		found: true,
		path: relativeDatedPath,
		latestPath: relativeLatestPath,
		currentStage,
		nextStage,
		contextHealth,
		activeFiles,
		blocker,
		verification,
		artifacts,
		currentTruth,
		invalidatedAssumptions,
		openDecisions,
		recentlyAccessedFiles,
		compressionRisk,
		activeRules,
		recommendNewSession,
		updatedAt: state.updatedAt,
		gateWarning: combinedWarning,
		readiness: readinessRun.outcome,
		drift: driftRun.advice,
	};
}

async function load(input: ContextHandoffInput): Promise<ContextHandoffResult> {
	const state = await readState(input.repoRoot);
	if (!state) {
		return {
			operation: "load",
			found: false,
			contextHealth: "watch",
			recommendNewSession: false,
		};
	}

	const targetPath =
		input.handoffPath ??
		state.latestHandoffPath ??
		latestHandoffPath(input.repoRoot);
	const absoluteTargetPath = resolveRepoPath(input.repoRoot, targetPath);
	let markdown = "";
	if (existsSync(absoluteTargetPath)) {
		markdown = await readFile(absoluteTargetPath, "utf8");
	}

	return {
		operation: "load",
		found: true,
		path: targetPath,
		latestPath: state.latestHandoffPath,
		currentStage: state.currentStage,
		nextStage: state.nextStage,
		contextHealth: state.contextHealth,
		activeFiles: state.activeFiles,
		blocker: state.blocker,
		verification: state.verification,
		artifacts: state.artifacts,
		currentTruth: state.currentTruth,
		invalidatedAssumptions: state.invalidatedAssumptions,
		openDecisions: state.openDecisions,
		recentlyAccessedFiles: state.recentlyAccessedFiles,
		compressionRisk: state.compressionRisk,
		activeRules: state.activeRules,
		recommendNewSession: state.recommendNewSession,
		handoffMarkdown: markdown,
		updatedAt: state.updatedAt,
	};
}

async function latest(
	input: ContextHandoffInput,
): Promise<ContextHandoffResult> {
	const state = await readState(input.repoRoot);
	if (!state || !state.latestHandoffPath) {
		return {
			operation: "latest",
			found: false,
			contextHealth: "watch",
			recommendNewSession: false,
		};
	}

	return {
		operation: "latest",
		found: true,
		path: state.latestDatedHandoffPath,
		latestPath: state.latestHandoffPath,
		currentStage: state.currentStage,
		nextStage: state.nextStage,
		contextHealth: state.contextHealth,
		activeFiles: state.activeFiles,
		blocker: state.blocker,
		verification: state.verification,
		artifacts: state.artifacts,
		currentTruth: state.currentTruth,
		invalidatedAssumptions: state.invalidatedAssumptions,
		openDecisions: state.openDecisions,
		recentlyAccessedFiles: state.recentlyAccessedFiles,
		compressionRisk: state.compressionRisk,
		activeRules: state.activeRules,
		recommendNewSession: state.recommendNewSession,
		updatedAt: state.updatedAt,
	};
}

const PLACEHOLDER_VALUES = new Set(["n/a", "na", "not run", "none", "", "-"]);
const PLACEHOLDER_PREFIXES = ["- n/a", "- na", "- not run", "- none", "- "];

function isPlaceholder(text: string): boolean {
	const trimmed = text.trim().toLowerCase();
	if (PLACEHOLDER_VALUES.has(trimmed)) return true;
	for (const prefix of PLACEHOLDER_PREFIXES) {
		if (trimmed === prefix) return true;
	}
	// Catch strings that start with a placeholder like "N/A — all premises confirmed"
	for (const val of PLACEHOLDER_VALUES) {
		if (val.length > 0 && trimmed.startsWith(val)) return true;
	}
	return false;
}

function isMeaningfulText(value?: string): boolean {
	return Boolean(value && !isPlaceholder(value));
}

function toPublicHandoffPath(repoRoot: string, filePath: string): string {
	return path.isAbsolute(filePath)
		? toRepoRelative(repoRoot, filePath)
		: filePath.replace(/\\/g, "/");
}

function extractSection(markdown: string, heading: string): string {
	const lines = markdown.split("\n");
	const sectionLines: string[] = [];
	let inSection = false;

	for (const line of lines) {
		if (line.startsWith("## ")) {
			if (inSection) break;
			if (line.slice(3).trim() === heading) {
				inSection = true;
			}
			continue;
		}
		if (inSection) {
			sectionLines.push(line);
		}
	}

	return sectionLines.join("\n").trim();
}

function sectionHasMeaningfulContent(
	markdown: string,
	heading: string,
): boolean {
	const section = extractSection(markdown, heading);
	if (!section) return false;

	const lines = section.split("\n");
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		if (!isPlaceholder(trimmed)) return true;
	}
	return false;
}

function hasMeaningfulArray(arr: string[]): boolean {
	return arr.some((item) => isMeaningfulText(item));
}

function hasMeaningfulRecord(rec: Record<string, string | undefined>): boolean {
	return Object.values(rec).some(isMeaningfulText);
}

function isMeaningfulStage(value?: string): boolean {
	return Boolean(
		value &&
			value.trim().length > 0 &&
			value !== "unknown" &&
			!isPlaceholder(value),
	);
}

async function validate(
	input: ContextHandoffInput,
	readiness?: ContextHandoffReadinessOptions,
	drift?: ContextHandoffDriftOptions,
): Promise<ContextHandoffResult> {
	const checks: ContextHandoffValidationCheck[] = [];
	const missing: string[] = [];
	const warnings: string[] = [];

	// Read state
	const state = await readState(input.repoRoot);
	const hasState = state !== null;

	// Read markdown
	let markdown = "";
	let hasMarkdown = false;
	let handoffFile = "";

	if (input.handoffPath) {
		const absolutePath = resolveRepoPath(input.repoRoot, input.handoffPath);
		if (existsSync(absolutePath)) {
			markdown = await readFile(absolutePath, "utf8");
			hasMarkdown = markdown.trim().length > 0;
			handoffFile = toPublicHandoffPath(input.repoRoot, input.handoffPath);
		}
	}

	if (!hasMarkdown && state?.latestHandoffPath) {
		const absolutePath = resolveRepoPath(
			input.repoRoot,
			state.latestHandoffPath,
		);
		if (existsSync(absolutePath)) {
			markdown = await readFile(absolutePath, "utf8");
			hasMarkdown = markdown.trim().length > 0;
			handoffFile = toPublicHandoffPath(
				input.repoRoot,
				state.latestHandoffPath,
			);
		}
	}

	if (!hasMarkdown) {
		const latestPath = latestHandoffPath(input.repoRoot);
		if (existsSync(latestPath)) {
			markdown = await readFile(latestPath, "utf8");
			hasMarkdown = markdown.trim().length > 0;
			handoffFile = toRepoRelative(input.repoRoot, latestPath);
		}
	}

	const found = hasState || hasMarkdown;

	checks.push({
		name: "state_exists",
		passed: hasState,
		reason: hasState
			? "Found context-state.json"
			: "No context-state.json found",
	});

	checks.push({
		name: "handoff_exists",
		passed: hasMarkdown,
		reason: hasMarkdown
			? "Found handoff markdown"
			: "No handoff markdown found",
	});

	// --- Recall probe ---
	const hasCurrentTruth = state
		? hasMeaningfulArray(state.currentTruth)
		: false;
	const hasCurrentStage = state ? isMeaningfulStage(state.currentStage) : false;
	const hasCurrentTaskSection =
		hasMarkdown && sectionHasMeaningfulContent(markdown, "Current Task");

	const recallPass =
		hasCurrentTruth ||
		(hasCurrentStage && (hasMarkdown || state?.nextStage !== undefined)) ||
		hasCurrentTaskSection;

	checks.push({
		name: "recall_current_truth",
		passed: hasCurrentTruth,
		reason: hasCurrentTruth
			? `Found ${state!.currentTruth.length} current truth entries`
			: "No current truth entries",
	});

	checks.push({
		name: "recall_current_task",
		passed: hasCurrentTaskSection,
		reason: hasCurrentTaskSection
			? "Current Task section has meaningful content"
			: "Current Task section is missing or placeholder",
	});

	checks.push({
		name: "recall_current_stage",
		passed: hasCurrentStage,
		reason: hasCurrentStage
			? `Current stage: ${state!.currentStage}`
			: "No meaningful current stage",
	});

	if (!recallPass) {
		missing.push("recall: current task or goal evidence");
	}

	// --- Continuation probe ---
	// Tightened: only actionable next-step evidence passes
	const hasNextStage = state ? isMeaningfulStage(state.nextStage) : false;
	const hasNextMinimalStep =
		hasMarkdown && sectionHasMeaningfulContent(markdown, "Next Minimal Step");

	const continuationPass = hasNextMinimalStep || hasNextStage;

	checks.push({
		name: "continuation_next_stage",
		passed: hasNextStage,
		reason: hasNextStage
			? `Next stage: ${state!.nextStage}`
			: "No meaningful next stage",
	});

	checks.push({
		name: "continuation_next_minimal_step",
		passed: hasNextMinimalStep,
		reason: hasNextMinimalStep
			? "Next Minimal Step has meaningful content"
			: "Next Minimal Step is missing or placeholder",
	});

	// Diagnostic checks (do not affect continuation pass)
	const hasBlocker = state
		? Boolean(state.blocker && !isPlaceholder(state.blocker))
		: false;
	const hasVerification = state
		? Boolean(state.verification && !isPlaceholder(state.verification))
		: false;
	const hasVerificationSection =
		hasMarkdown && sectionHasMeaningfulContent(markdown, "Verification");

	checks.push({
		name: "continuation_blocker",
		passed: hasBlocker,
		reason: hasBlocker
			? `Blocker: ${state!.blocker}`
			: "No blocker information",
	});

	checks.push({
		name: "continuation_verification",
		passed: hasVerification || hasVerificationSection,
		reason:
			hasVerification || hasVerificationSection
				? "Verification evidence present"
				: "No verification information",
	});

	if (!continuationPass) {
		missing.push("continuation: next minimal step or next stage evidence");
	}

	// --- Artifact probe ---
	const hasActiveFiles = state ? hasMeaningfulArray(state.activeFiles) : false;
	const hasRecentlyAccessed = state
		? hasMeaningfulArray(state.recentlyAccessedFiles)
		: false;
	const hasArtifacts = state ? hasMeaningfulRecord(state.artifacts) : false;
	const hasActiveFilesSection =
		hasMarkdown && sectionHasMeaningfulContent(markdown, "Active Files");
	const hasRecentlyAccessedSection =
		hasMarkdown &&
		sectionHasMeaningfulContent(markdown, "Recently Accessed Files");
	const hasArtifactsSection =
		hasMarkdown && sectionHasMeaningfulContent(markdown, "Artifacts");

	const artifactPass =
		hasActiveFiles ||
		hasRecentlyAccessed ||
		hasArtifacts ||
		hasActiveFilesSection ||
		hasRecentlyAccessedSection ||
		hasArtifactsSection;

	checks.push({
		name: "artifact_active_files",
		passed: hasActiveFiles || hasActiveFilesSection,
		reason:
			hasActiveFiles || hasActiveFilesSection
				? "Active files present"
				: "No active files",
	});

	if (!artifactPass) {
		warnings.push("artifact: active files or artifacts are missing");
	}

	// --- Decision probe ---
	const hasOpenDecisions = state
		? hasMeaningfulArray(state.openDecisions)
		: false;
	const hasInvalidatedAssumptions = state
		? hasMeaningfulArray(state.invalidatedAssumptions)
		: false;
	const hasOpenDecisionsSection =
		hasMarkdown && sectionHasMeaningfulContent(markdown, "Open Decisions");
	const hasInvalidatedSection =
		hasMarkdown &&
		sectionHasMeaningfulContent(markdown, "Invalidated Assumptions");
	const hasCurrentTruthSection =
		hasMarkdown && sectionHasMeaningfulContent(markdown, "Current Truth");

	const decisionPass =
		hasOpenDecisions ||
		hasInvalidatedAssumptions ||
		hasCurrentTruth ||
		hasOpenDecisionsSection ||
		hasInvalidatedSection ||
		hasCurrentTruthSection;

	checks.push({
		name: "decision_open_decisions",
		passed: hasOpenDecisions || hasOpenDecisionsSection,
		reason:
			hasOpenDecisions || hasOpenDecisionsSection
				? "Open decisions present"
				: "No open decisions",
	});

	if (!decisionPass) {
		warnings.push("decision: decisions or invalidated assumptions are missing");
	}

	// --- Checklist probe ---
	let checklistNonEmpty = false;
	try {
		const checklist = await readChecklist(input.repoRoot);
		checklistNonEmpty = checklist.items.length > 0;
		if (checklistNonEmpty) {
			const summary = checklist.items
				.map((item, idx) => idx + 1 + ". " + item.description)
				.join("; ");
			warnings.push(
				"checklist: " +
					checklist.items.length +
					" pending task(s) — " +
					summary,
			);
		}
	} catch {
		// If readChecklist throws, skip the probe
	}

	checks.push({
		name: "checklist_empty",
		passed: !checklistNonEmpty,
		reason: checklistNonEmpty
			? "Checklist has pending tasks that should be completed before handoff"
			: "Checklist is empty or absent",
	});

	// --- ok derivation ---
	const ok = recallPass && continuationPass && !checklistNonEmpty;

	// --- recommended action ---
	let recommendedAction: ContextHandoffRecommendedAction;
	if (!found) {
		recommendedAction = "save_handoff";
	} else if (!ok) {
		recommendedAction = "fill_required_context";
	} else {
		recommendedAction = "continue";
	}

	const readinessOutcome = await surfaceReadiness(
		input,
		readiness,
		state,
		handoffFile,
	);
	const driftOutcome = await surfaceDrift(input, drift, state, handoffFile);

	return {
		operation: "validate",
		found,
		ok,
		path: handoffFile || undefined,
		probes: {
			recall: recallPass,
			continuation: continuationPass,
			artifact: artifactPass,
			decision: decisionPass,
		},
		checks,
		missing,
		warnings,
		recommendedAction,
		currentStage: state?.currentStage,
		nextStage: state?.nextStage,
		contextHealth: state?.contextHealth,
		updatedAt: state?.updatedAt,
		readiness: readinessOutcome,
		drift: driftOutcome,
	};
}

async function status(
	input: ContextHandoffInput,
): Promise<ContextHandoffResult> {
	const state = await readState(input.repoRoot);

	if (!state) {
		return {
			operation: "status",
			found: false,
			contextHealth: "watch",
			recommendNewSession: false,
			activeFiles: [],
			artifacts: {},
		};
	}

	return {
		operation: "status",
		found: true,
		path: state.latestDatedHandoffPath,
		latestPath: state.latestHandoffPath,
		currentStage: state.currentStage,
		nextStage: state.nextStage,
		contextHealth: state.contextHealth,
		activeFiles: state.activeFiles,
		blocker: state.blocker,
		verification: state.verification,
		artifacts: state.artifacts,
		currentTruth: state.currentTruth,
		invalidatedAssumptions: state.invalidatedAssumptions,
		openDecisions: state.openDecisions,
		recentlyAccessedFiles: state.recentlyAccessedFiles,
		compressionRisk: state.compressionRisk,
		activeRules: state.activeRules,
		recommendNewSession: state.recommendNewSession,
		updatedAt: state.updatedAt,
	};
}
