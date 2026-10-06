// Dry-run-first role migration (plan Unit 8): fold per-stage `model` values
// into the three-role `models` block without guessing model strength.
// Pure and deterministic; the CLI owns all I/O.
import type {
	ModelRolesConfig,
	PiPedstackConfig,
	ReviewableStepConfig,
	StepConfig,
	StepConfigKey,
} from "./config-types";

export type RoleMigrationStatus = "migratable" | "not_migratable" | "noop";

export interface RoleMigrationPlan {
	status: RoleMigrationStatus;
	/** Distinct foldable per-stage models, sorted ascending. */
	distinctModels: string[];
	/** The resolved role block (`{}` when not migratable/noop). */
	roles: ModelRolesConfig;
	/** The resulting config; deep-equal to the input when not migratable/noop. */
	nextConfig: PiPedstackConfig;
	/** Per-stage keys whose `model` was folded and removed. */
	foldedStages: StepConfigKey[];
	/** Why the plan is not migratable. */
	reason?: string;
}

/** Deterministic stage order; role picks depend on it. */
const STAGE_ORDER: StepConfigKey[] = [
	"brainstorm",
	"plan",
	"work",
	"review",
	"debug",
	"learn",
	"docsync",
];

interface FoldableStage {
	stage: StepConfigKey;
	model: string;
	thinkingLevel?: string;
}

interface RoleModels {
	defaultModel: string;
	reviewModel?: string;
	sotaModel?: string;
}

/** A stage with a non-empty `reviewers[]` is an explicit override, kept as-is. */
function isExplicitOverride(
	config: PiPedstackConfig,
	stage: StepConfigKey,
): boolean {
	const stageConfig = config[stage];
	if (!stageConfig || !("reviewers" in stageConfig)) return false;
	const reviewers = (stageConfig as ReviewableStepConfig).reviewers;
	return Array.isArray(reviewers) && reviewers.length > 0;
}

function collectFoldableStages(config: PiPedstackConfig): FoldableStage[] {
	const foldable: FoldableStage[] = [];
	for (const stage of STAGE_ORDER) {
		const stageConfig = config[stage] as StepConfig | undefined;
		if (
			!stageConfig ||
			typeof stageConfig.model !== "string" ||
			stageConfig.model.length === 0 ||
			isExplicitOverride(config, stage)
		) {
			continue;
		}
		foldable.push({
			stage,
			model: stageConfig.model,
			thinkingLevel: stageConfig.thinkingLevel,
		});
	}
	return foldable;
}

/** Most frequent model wins; ties break lexicographically. */
function pickDefaultModel(distinct: string[], foldable: FoldableStage[]): string {
	const counts = new Map<string, number>();
	for (const entry of foldable) {
		counts.set(entry.model, (counts.get(entry.model) ?? 0) + 1);
	}
	let defaultModel = distinct[0];
	for (const model of distinct) {
		if ((counts.get(model) ?? 0) > (counts.get(defaultModel) ?? 0)) {
			defaultModel = model;
		}
	}
	return defaultModel;
}

function resolveRoleModels(foldable: FoldableStage[]): RoleModels {
	const distinct = [...new Set(foldable.map((entry) => entry.model))].sort();
	const defaultModel = pickDefaultModel(distinct, foldable);
	const remaining = distinct.filter((model) => model !== defaultModel);
	const reviewStageModel = foldable.find((entry) => entry.stage === "review")?.model;
	const reviewModel =
		reviewStageModel && reviewStageModel !== defaultModel
			? reviewStageModel
			: remaining[0];
	const sotaCandidates = remaining.filter((model) => model !== reviewModel);
	return {
		defaultModel,
		reviewModel,
		sotaModel:
			sotaCandidates.length > 0
				? sotaCandidates[sotaCandidates.length - 1]
				: undefined,
	};
}

function buildRoles(
	foldable: FoldableStage[],
	{ defaultModel, reviewModel, sotaModel }: RoleModels,
): ModelRolesConfig {
	const roleFor = (model: string): StepConfig => {
		const source = foldable.find(
			(entry) => entry.model === model && entry.thinkingLevel !== undefined,
		);
		return source?.thinkingLevel
			? { model, thinkingLevel: source.thinkingLevel }
			: { model };
	};
	const roles: ModelRolesConfig = { default: roleFor(defaultModel) };
	if (reviewModel) roles.review = roleFor(reviewModel);
	if (sotaModel) roles.sota = roleFor(sotaModel);
	return roles;
}

function emptyPlan(
	status: RoleMigrationStatus,
	nextConfig: PiPedstackConfig,
	reason?: string,
): RoleMigrationPlan {
	return {
		status,
		distinctModels: [],
		roles: {},
		nextConfig,
		foldedStages: [],
		...(reason ? { reason } : {}),
	};
}

/** Builds a behavior-preserving role migration plan, or explains why not. */
export function buildRoleMigration(
	config: PiPedstackConfig | null,
): RoleMigrationPlan {
	if (!config) return emptyPlan("noop", {});
	const foldable = collectFoldableStages(config);
	if (foldable.length === 0) {
		return {
			...emptyPlan("noop", structuredClone(config)),
			roles: config.models ? { ...config.models } : {},
		};
	}

	const distinct = [...new Set(foldable.map((entry) => entry.model))].sort();
	if (distinct.length > 3) {
		return {
			...emptyPlan(
				"not_migratable",
				structuredClone(config),
				`${distinct.length} distinct models exceeds the 3 available roles`,
			),
			distinctModels: distinct,
		};
	}

	const roleModels = resolveRoleModels(foldable);
	const roles = buildRoles(foldable, roleModels);
	const nextConfig = structuredClone(config);
	for (const entry of foldable) {
		delete nextConfig[entry.stage];
	}
	nextConfig.models = roles;

	return {
		status: "migratable",
		distinctModels: distinct,
		roles,
		nextConfig,
		foldedStages: foldable.map((entry) => entry.stage),
	};
}
