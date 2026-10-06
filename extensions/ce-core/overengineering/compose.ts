// Overengineering signal composer (plan Unit 5). Resolves the per-stage
// baseline first, then extracts deterministic facts, then assembles the
// `OverengineeringSignal`. `off` and a missing baseline never touch git.
import type { StageKey } from "../stage-gate/types";
import { resolveBaseline } from "./baseline";
import type { BaselineReadFile } from "./baseline";
import {
	createGitRunner,
	emptyOverengineeringFacts,
	extractComplexityFacts,
} from "./facts";
import type { GitRunner, PackageJsonFile } from "./facts";
import {
	OVERENGINEERING_DIMENSION_IDS,
	type OverengineeringBaselines,
	type OverengineeringDimensionId,
	type OverengineeringMode,
	type OverengineeringSignal,
	type OverengineeringSkip,
} from "./types";

/**
 * Resolves `PEDSTACK_OVERENGINEERING` (the only layer). Missing/invalid values
 * resolve to `shadow`, never `off` by accident.
 */
export function resolveOverengineeringMode(
	env: Record<string, string | undefined>,
): OverengineeringMode {
	const value = env.PEDSTACK_OVERENGINEERING;
	if (value === "off") return "off";
	if (value === "enforce") return "enforce";
	return "shadow";
}

export interface ComposeInput {
	repoRoot: string;
	stage: StageKey;
	mode: OverengineeringMode;
	runGit?: GitRunner;
	now?: () => Date;
	priorPlanReading?: number | null;
	readFile?: BaselineReadFile;
	packageJsons?: PackageJsonFile[];
}

function unavailable(reason: "no_baseline" | "request_too_large"): OverengineeringSignal {
	return {
		status: "unavailable",
		baselines: {},
		baselinePaths: [],
		baselineHash: "",
		facts: emptyOverengineeringFacts([]),
		skippedDimensions: OVERENGINEERING_DIMENSION_IDS.map((dimension) => ({
			dimension,
			reason: "no_baseline" as const,
		})),
		reason,
	};
}

/**
 * Merge baseline-driven skips with the extraction seed. A dimension is skipped
 * when its named baseline is absent; extraction seeds override for the reason.
 */
function mergeSkips(
	baselines: OverengineeringBaselines,
	seed: OverengineeringSkip[],
): OverengineeringSkip[] {
	const byDimension = new Map<OverengineeringDimensionId, OverengineeringSkip>();
	const hasRequirements = baselines.requirements !== undefined;
	const hasPlan = baselines.plan !== undefined;
	const skip = (
		dimension: OverengineeringDimensionId,
		reason: OverengineeringSkip["reason"],
	): void => {
		byDimension.set(dimension, { dimension, reason });
	};
	if (!hasRequirements) skip("scope_fidelity", "no_baseline");
	if (!hasRequirements && !hasPlan) {
		skip("no_unrequested_abstraction", "no_baseline");
		skip("complexity_proportionality", "no_baseline");
		skip("dependency_justification", "no_baseline");
	}
	for (const entry of seed) byDimension.set(entry.dimension, entry);
	return OVERENGINEERING_DIMENSION_IDS.filter((id) => byDimension.has(id)).map(
		(id) => byDimension.get(id) as OverengineeringSkip,
	);
}

/**
 * Compose the overengineering signal for one stage.
 *
 * `off` short-circuits with no reads or git. Otherwise the baseline resolves
 * first; an unavailable baseline short-circuits before any git call. If every
 * dimension ends up skipped, the signal is `unavailable` (the all-skipped rule).
 */
export async function composeOverengineeringSignal(
	input: ComposeInput,
): Promise<OverengineeringSignal> {
	if (input.mode === "off") return unavailable("no_baseline");

	const baseline = await resolveBaseline({
		repoRoot: input.repoRoot,
		stage: input.stage,
		priorPlanReading: input.priorPlanReading,
		readFile: input.readFile,
	});
	if (baseline.status === "unavailable") return unavailable("no_baseline");

	const runGit = input.runGit ?? createGitRunner(input.repoRoot);
	const facts = await extractComplexityFacts({
		repoRoot: input.repoRoot,
		runGit,
		packageJsons: input.packageJsons,
	});
	const skippedDimensions = mergeSkips(baseline.baselines, facts.skippedDimensions);
	const signal: OverengineeringSignal = {
		status: "ready",
		baselines: baseline.baselines,
		baselinePaths: baseline.paths,
		baselineHash: baseline.hash,
		facts,
		skippedDimensions,
	};
	if (skippedDimensions.length >= OVERENGINEERING_DIMENSION_IDS.length) {
		return { ...signal, status: "unavailable", reason: "no_baseline" };
	}
	return signal;
}
