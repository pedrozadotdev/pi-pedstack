// Baseline resolution + contamination guard (plan Unit 4). File-based only —
// no network, no `gh` call. The terminal fallback is `unavailable`.
import fs from "node:fs/promises";
import path from "node:path";
import { computeArtifactsHash } from "../stage-gate/evidence";
import type { StageKey } from "../stage-gate/types";
import { canonicalRel, isEscapingSymlink, isInside } from "../utils/repo-paths";
import { truncateUtf8ToBytes } from "../utils/solution-recall";
import type { BaselineRef, OverengineeringBaselines } from "./types";

export const BASELINE_MAX_BYTES = 2048;
const REQUIREMENTS_DIR = "docs/brainstorms";
const PLAN_DIR = "docs/plans";

/** Injectable read seam: returns `null` for an unreadable repo-relative path. */
export type BaselineReadFile = (rel: string) => Promise<string | null>;

export interface ResolveBaselineInput {
	repoRoot: string;
	stage: StageKey;
	planText?: string | null;
	requirementsText?: string | null;
	issueContextText?: string | null;
	/** Prior 02-plan overengineering reading; `< 0.5` triggers the guard. */
	priorPlanReading?: number | null;
	readFile?: BaselineReadFile;
}

export interface BaselineResolution {
	status: "ready" | "unavailable";
	baselines: OverengineeringBaselines;
	paths: string[];
	hash: string;
	provenance?: string;
	reason?: "no_baseline";
}

interface Candidate {
	path: string;
	mtimeMs: number;
}

interface LoadedBaseline {
	ref: BaselineRef;
	path: string;
}

function defaultReadFile(repoRoot: string): BaselineReadFile {
	return async (rel) => {
		try {
			return await fs.readFile(path.join(repoRoot, rel), "utf8");
		} catch {
			return null;
		}
	};
}

function isIssueName(rel: string): boolean {
	return /issue/i.test(path.posix.basename(rel));
}

async function candidateFor(
	repoRoot: string,
	dirAbs: string,
	name: string,
	accept: (rel: string) => boolean,
): Promise<Candidate | null> {
	if (!name.endsWith(".md")) return null;
	const full = path.join(dirAbs, name);
	const rel = canonicalRel(repoRoot, full);
	if (!isInside(rel) || !accept(rel)) return null;
	if (await isEscapingSymlink(repoRoot, full)) return null;
	try {
		const stat = await fs.stat(full);
		return stat.isFile() ? { path: rel, mtimeMs: stat.mtimeMs } : null;
	} catch {
		return null;
	}
}

async function findNewest(
	repoRoot: string,
	dir: string,
	accept: (rel: string) => boolean,
): Promise<Candidate | null> {
	const dirAbs = path.join(repoRoot, dir);
	let entries;
	try {
		entries = await fs.readdir(dirAbs, { withFileTypes: true });
	} catch {
		return null;
	}
	const candidates: Candidate[] = [];
	for (const entry of entries) {
		const candidate = await candidateFor(repoRoot, dirAbs, entry.name, accept);
		if (candidate) candidates.push(candidate);
	}
	if (candidates.length === 0) return null;
	candidates.sort((a, b) =>
		b.mtimeMs - a.mtimeMs !== 0 ? b.mtimeMs - a.mtimeMs : a.path.localeCompare(b.path),
	);
	return candidates[0];
}

function toRef(text: string, relPath: string): BaselineRef {
	return {
		text: truncateUtf8ToBytes(text, BASELINE_MAX_BYTES),
		paths: [relPath],
		truncated: Buffer.byteLength(text, "utf8") > BASELINE_MAX_BYTES,
	};
}

async function loadBaseline(
	repoRoot: string,
	dir: string,
	accept: (rel: string) => boolean,
	override: string | null | undefined,
	readFile: BaselineReadFile,
): Promise<LoadedBaseline | null> {
	if (typeof override === "string" && override.length > 0) {
		// ponytail: an injected text still uses the newest discovered path so the
		// freshness hash stays anchored to a real file.
		const found = await findNewest(repoRoot, dir, accept);
		if (!found) return null;
		return { ref: toRef(override, found.path), path: found.path };
	}
	const found = await findNewest(repoRoot, dir, accept);
	if (!found) return null;
	const text = await readFile(found.path);
	if (text === null) return null;
	return { ref: toRef(text, found.path), path: found.path };
}

function collect(loaded: Array<LoadedBaseline | null>): {
	baselines: OverengineeringBaselines;
	paths: string[];
} {
	const baselines: OverengineeringBaselines = {};
	const paths: string[] = [];
	for (const entry of loaded) {
		if (!entry) continue;
		if (entry.ref.paths[0].startsWith(REQUIREMENTS_DIR)) {
			baselines.requirements = entry.ref;
		} else if (entry.ref.paths[0].startsWith(PLAN_DIR)) {
			baselines.plan = entry.ref;
		}
		paths.push(entry.path);
	}
	return { baselines, paths: [...new Set(paths)].sort() };
}

async function finish(
	repoRoot: string,
	collected: { baselines: OverengineeringBaselines; paths: string[] },
	provenance: string,
): Promise<BaselineResolution> {
	if (collected.paths.length === 0) {
		return {
			status: "unavailable",
			baselines: {},
			paths: [],
			hash: await computeArtifactsHash(repoRoot, []),
			provenance: "unavailable",
			reason: "no_baseline",
		};
	}
	return {
		status: "ready",
		baselines: collected.baselines,
		paths: collected.paths,
		hash: await computeArtifactsHash(repoRoot, collected.paths),
		provenance,
	};
}

type BaselineLoader = () => Promise<LoadedBaseline | null>;

interface StageResolution {
	loaded: Array<LoadedBaseline | null>;
	provenance: string;
}

async function resolvePlanStage(
	requirements: BaselineLoader,
	issue: BaselineLoader,
): Promise<StageResolution> {
	const req = await requirements();
	if (req) return { loaded: [req], provenance: "requirements" };
	return { loaded: [await issue()], provenance: "issue-context" };
}

async function resolveWorkStage(
	reading: number | null,
	plan: BaselineLoader,
	requirements: BaselineLoader,
	issue: BaselineLoader,
): Promise<StageResolution> {
	const planEntry = reading !== null && reading < 0.5 ? null : await plan();
	if (planEntry) {
		let provenance: string;
		if (reading === null) provenance = "no-prior-reading";
		else if (reading < 0.75) provenance = "plan-review-band";
		else provenance = "plan";
		return { loaded: [planEntry], provenance };
	}
	const fallbackProvenance =
		reading !== null && reading < 0.5 ? "prior-plan-low" : "plan-unavailable";
	const req = await requirements();
	if (req) return { loaded: [req], provenance: fallbackProvenance };
	return { loaded: [await issue()], provenance: fallbackProvenance };
}

async function resolveReviewStage(
	requirements: BaselineLoader,
	plan: BaselineLoader,
): Promise<StageResolution> {
	const req = await requirements();
	const planEntry = await plan();
	let provenance: string;
	if (req && planEntry) provenance = "review-dual";
	else if (req) provenance = "review-requirements";
	else if (planEntry) provenance = "review-plan";
	else provenance = "unavailable";
	return { loaded: [req, planEntry], provenance };
}

/**
 * Resolve the per-stage normative baseline. `02-plan` uses requirements (then a
 * local issue-context file); `03-work` uses the plan behind a contamination
 * guard; `04-review` uses requirements + plan together.
 */
export async function resolveBaseline(
	input: ResolveBaselineInput,
): Promise<BaselineResolution> {
	const { repoRoot, stage } = input;
	const readFile = input.readFile ?? defaultReadFile(repoRoot);
	const plan = (): Promise<LoadedBaseline | null> =>
		loadBaseline(repoRoot, PLAN_DIR, () => true, input.planText, readFile);
	const requirements = (): Promise<LoadedBaseline | null> =>
		loadBaseline(
			repoRoot,
			REQUIREMENTS_DIR,
			(rel) => !isIssueName(rel),
			input.requirementsText,
			readFile,
		);
	const issue = (): Promise<LoadedBaseline | null> =>
		loadBaseline(
			repoRoot,
			REQUIREMENTS_DIR,
			isIssueName,
			input.issueContextText,
			readFile,
		);

	let resolution: StageResolution;
	if (stage === "02-plan") {
		resolution = await resolvePlanStage(requirements, issue);
	} else if (stage === "03-work") {
		resolution = await resolveWorkStage(
			input.priorPlanReading ?? null,
			plan,
			requirements,
			issue,
		);
	} else if (stage === "04-review") {
		resolution = await resolveReviewStage(requirements, plan);
	} else {
		resolution = { loaded: [], provenance: "unavailable" };
	}
	return finish(repoRoot, collect(resolution.loaded), resolution.provenance);
}
