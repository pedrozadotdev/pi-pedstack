// Dry-run-first role migration (plan Unit 8): fold per-stage `model` values
// into the three-role `models` block without guessing model strength.
// Pure and deterministic; the CLI owns all I/O.
//
// Lossless-or-refuse: a `migratable` plan may not silently drop a model, a
// thinkingLevel, an explicit `reviewers[]`, or a pre-existing `models` entry.
// A model whose foldable stages disagree on `thinkingLevel` (including one that
// declared a level and one that declared none) is `not_migratable`, because a
// single role slot cannot carry both without changing observable behavior.
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

const ROLE_ORDER = ["default", "review", "sota"] as const;

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

function groupByModel(
	foldable: FoldableStage[],
): Map<string, FoldableStage[]> {
	const groups = new Map<string, FoldableStage[]>();
	for (const entry of foldable) {
		const existing = groups.get(entry.model);
		if (existing) existing.push(entry);
		else groups.set(entry.model, [entry]);
	}
	return groups;
}

/** First model whose foldable stages disagree on `thinkingLevel`, or null. */
function findThinkingLevelConflict(foldable: FoldableStage[]): string | null {
	for (const [model, entries] of groupByModel(foldable)) {
		const levels = [...new Set(entries.map((entry) => entry.thinkingLevel))];
		if (levels.length <= 1) continue;
		const labels = levels
			.map((level) => (level === undefined ? "(unset)" : level))
			.sort((a, b) => a.localeCompare(b));
		const stages = entries.map((entry) => entry.stage).join(", ");
		return (
			`model ${model} supplies conflicting thinkingLevels ` +
			`(${labels.join(", ")}) across stages ${stages}; a single role ` +
			"slot cannot preserve both"
		);
	}
	return null;
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
	const distinct = [...new Set(foldable.map((entry) => entry.model))].sort((a, b) =>
		a.localeCompare(b),
	);
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
		sotaModel: sotaCandidates.length > 0 ? sotaCandidates.at(-1) : undefined,
	};
}

/**
 * The single `thinkingLevel` for a model, or `undefined`. The conflict check
 * runs first, so all of a model's foldable stages share one value here.
 */
function roleLevel(foldable: FoldableStage[], model: string): string | undefined {
	// The conflict check guarantees every entry for a model agrees on the level.
	return foldable.find((entry) => entry.model === model)?.thinkingLevel;
}

function roleFor(foldable: FoldableStage[], model: string): StepConfig {
	const level = roleLevel(foldable, model);
	return level === undefined ? { model } : { model, thinkingLevel: level };
}

function buildRoles(
	foldable: FoldableStage[],
	{ defaultModel, reviewModel, sotaModel }: RoleModels,
): ModelRolesConfig {
	const roles: ModelRolesConfig = { default: roleFor(foldable, defaultModel) };
	if (reviewModel) roles.review = roleFor(foldable, reviewModel);
	if (sotaModel) roles.sota = roleFor(foldable, sotaModel);
	return roles;
}

function describeRole(role: StepConfig): string {
	return role.thinkingLevel === undefined
		? role.model
		: `${role.model} (${role.thinkingLevel})`;
}

/** First generated role that conflicts with an authored `models` entry, or null. */
function findRoleConflict(
	existing: ModelRolesConfig,
	generated: ModelRolesConfig,
): string | null {
	for (const role of ROLE_ORDER) {
		const generatedRole = generated[role];
		const existingRole = existing[role];
		if (!generatedRole || !existingRole) continue;
		const sameLevel =
			(existingRole.thinkingLevel ?? "") === (generatedRole.thinkingLevel ?? "");
		if (existingRole.model === generatedRole.model && sameLevel) continue;
		return (
			`existing models.${role} (${describeRole(existingRole)}) conflicts ` +
			`with the migrated role (${describeRole(generatedRole)}); refusing ` +
			"to overwrite operator config"
		);
	}
	return null;
}

function emptyPlan(
	status: RoleMigrationStatus,
	nextConfig: PiPedstackConfig,
	reason?: string,
): RoleMigrationPlan {
	const plan: RoleMigrationPlan = {
		status,
		distinctModels: [],
		roles: {},
		nextConfig,
		foldedStages: [],
	};
	if (reason) plan.reason = reason;
	return plan;
}

function distinctModelsOf(foldable: FoldableStage[]): string[] {
	return [...new Set(foldable.map((entry) => entry.model))].sort((a, b) =>
		a.localeCompare(b),
	);
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

	const distinct = distinctModelsOf(foldable);

	const levelConflict = findThinkingLevelConflict(foldable);
	if (levelConflict) {
		return {
			...emptyPlan("not_migratable", structuredClone(config), levelConflict),
			distinctModels: distinct,
		};
	}

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

	const roles = buildRoles(foldable, resolveRoleModels(foldable));
	const existing: ModelRolesConfig = config.models ?? {};
	const roleConflict = findRoleConflict(existing, roles);
	if (roleConflict) {
		return {
			...emptyPlan("not_migratable", structuredClone(config), roleConflict),
			distinctModels: distinct,
		};
	}

	const nextConfig = structuredClone(config);
	for (const entry of foldable) {
		delete nextConfig[entry.stage];
	}
	// Preserve every authored role the fold does not generate.
	nextConfig.models = { ...(nextConfig.models ?? {}), ...roles };

	return {
		status: "migratable",
		distinctModels: distinct,
		roles,
		nextConfig,
		foldedStages: foldable.map((entry) => entry.stage),
	};
}
