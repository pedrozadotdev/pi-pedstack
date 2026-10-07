/**
 * Pure stage capability matrix for the `write`/`edit` stage guard.
 *
 * Classifies a repo-relative path into one of 11 {@link PathClass} values and
 * decides whether the active Pedstack stage may modify it. This module is
 * intentionally pure: no I/O, no Pi imports, no environment access. The
 * `tool_call` handler in `index.ts` owns the wiring and escape hatch.
 *
 * @module capability-matrix
 */

import path from "node:path";
import type { PipelineStageKey } from "../commands/pedstack";

/** The 11 path classes used by classification and the capability matrix. */
export type PathClass =
	| "brainstorm"
	| "plan"
	| "review"
	| "solution"
	| "docs"
	| "tests"
	| "source"
	| "config"
	| "deps"
	| "workflow-state"
	| "unknown";

/** All path classes in declaration order. */
export const ALL_PATH_CLASSES: readonly PathClass[] = [
	"brainstorm",
	"plan",
	"review",
	"solution",
	"docs",
	"tests",
	"source",
	"config",
	"deps",
	"workflow-state",
	"unknown",
];

/** Pipeline stages in order. Duplicated data keeps the union and runtime set in sync. */
const PIPELINE_STAGE_KEYS: readonly PipelineStageKey[] = [
	"01-brainstorm",
	"02-plan",
	"03-work",
	"04-review",
	"04-5-debug",
	"05-learn",
	"06-docsync",
];

const STAGE_KEY_SET = new Set<string>(PIPELINE_STAGE_KEYS);

const DEPS_BASENAMES = new Set<string>([
	"bun.lock",
	"package-lock.json",
	"pnpm-lock.yaml",
	"yarn.lock",
]);

const CONFIG_BASENAMES = new Set<string>([
	"package.json",
	"tsconfig.json",
	"bunfig.toml",
]);

const DOC_BASENAMES = new Set<string>(["README.md", "AGENTS.md"]);

const SOURCE_PREFIXES: readonly string[] = [
	"extensions/",
	"skills/",
	"prompts/",
	"rules/",
	"scripts/",
];

const SOURCE_EXTENSION = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const TEST_BASENAME = /\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/;

/**
 * Writable classes per stage. `unknown` is always writable (fail-open);
 * `workflow-state` is never writable in any stage.
 */
export const STAGE_CAPABILITIES: Record<
	PipelineStageKey,
	ReadonlySet<PathClass>
> = {
	"01-brainstorm": new Set<PathClass>(["brainstorm", "unknown"]),
	"02-plan": new Set<PathClass>(["plan", "unknown"]),
	"03-work": new Set<PathClass>([
		"tests",
		"source",
		"config",
		"deps",
		"unknown",
	]),
	"04-review": new Set<PathClass>(["review", "unknown"]),
	"04-5-debug": new Set<PathClass>(["tests", "source", "config", "unknown"]),
	"05-learn": new Set<PathClass>(["solution", "unknown"]),
	"06-docsync": new Set<PathClass>(["docs", "unknown"]),
};

/**
 * Classify a repo-relative (or in-repo absolute) path into a {@link PathClass}.
 *
 * Normalization: backslashes become `/`, `.`/`..` collapse via `path.resolve`,
 * and paths that resolve outside `repoRoot` or to the root itself classify as
 * `unknown`. Matching is case-sensitive; no `realpath`/`fs.stat` is performed.
 */
export function classifyPath(repoRoot: string, rawPath: string): PathClass {
	if (typeof rawPath !== "string" || rawPath.length === 0) return "unknown";

	let rel: string;
	try {
		const normalized = rawPath.replace(/\\/g, "/");
		const resolved = path.resolve(repoRoot, normalized);
		rel = path.relative(repoRoot, resolved).replace(/\\/g, "/");
	} catch {
		return "unknown";
	}

	if (rel === "" || rel.startsWith("../") || path.isAbsolute(rel)) {
		return "unknown";
	}

	return classifyRelative(rel);
}

/** Ordered first-match classification of a normalized repo-relative path. */
function classifyRelative(rel: string): PathClass {
	// Invariant first: workflow state is never writable, so it must not be
	// shadowed by basename rules (package.json → config, *.test.ts → tests).
	if (rel === ".context" || rel.startsWith(".context/")) {
		return "workflow-state";
	}

	const base = path.posix.basename(rel);

	if (DEPS_BASENAMES.has(base)) return "deps";
	if (CONFIG_BASENAMES.has(base) || rel.startsWith(".github/")) return "config";
	if (rel.startsWith("docs/brainstorms/")) return "brainstorm";
	if (rel.startsWith("docs/plans/")) return "plan";
	if (rel.startsWith("docs/reviews/")) return "review";
	if (rel.startsWith("docs/solutions/")) return "solution";
	if (rel.startsWith("tests/") || TEST_BASENAME.test(base)) return "tests";
	if (
		SOURCE_PREFIXES.some((prefix) => rel.startsWith(prefix)) ||
		(!rel.includes("/") && SOURCE_EXTENSION.test(base))
	) {
		return "source";
	}
	if (DOC_BASENAMES.has(base) || rel.startsWith("docs/")) return "docs";

	return "unknown";
}

/** Result of evaluating a `write`/`edit` against the active stage. */
export interface WriteVerdict {
	/** Whether the write is permitted. */
	allow: boolean;
	/** The resolved path class used for the decision. */
	pathClass: PathClass;
	/** Deterministic block reason; present only when `allow` is false. */
	reason?: string;
}

/**
 * Evaluate a `write`/`edit` target against `stage`.
 *
 * Order: `unknown` class always allows; `workflow-state` always blocks; an
 * absent/unknown stage fails open for everything except `workflow-state`;
 * otherwise the write is allowed iff the stage's capability set contains the
 * path class.
 */
export function evaluateWrite(
	stage: string | null | undefined,
	repoRoot: string,
	rawPath: string,
): WriteVerdict {
	const pathClass = classifyPath(repoRoot, rawPath);
	const stageKey = resolveStageKey(stage);

	if (pathClass === "unknown") return { allow: true, pathClass };

	if (pathClass === "workflow-state") {
		return {
			allow: false,
			pathClass,
			reason: workflowStateReason(stageKey, rawPath),
		};
	}

	if (!stageKey) return { allow: true, pathClass };

	if (STAGE_CAPABILITIES[stageKey].has(pathClass)) {
		return { allow: true, pathClass };
	}

	return {
		allow: false,
		pathClass,
		reason: blockedReason(stageKey, pathClass, rawPath),
	};
}

/** Narrow an arbitrary stage string to a known pipeline stage key, else null. */
function resolveStageKey(
	stage: string | null | undefined,
): PipelineStageKey | null {
	if (typeof stage === "string" && STAGE_KEY_SET.has(stage)) {
		return stage as PipelineStageKey;
	}
	return null;
}

/** Deterministic block reason for a foreign class in a known stage. */
function blockedReason(
	stage: PipelineStageKey,
	pathClass: PathClass,
	rawPath: string,
): string {
	const writable = [...STAGE_CAPABILITIES[stage]].sort().join(", ");
	return (
		`Pedstack stage guard blocked this write: stage "${stage}" may not write ` +
		`path "${rawPath}" (class: ${pathClass}). Writable classes for ${stage}: ` +
		`${writable}. Set "features.stageGuard.disabled": true in config.json to bypass.`
	);
}

/** Deterministic block reason for workflow-state, which is never writable. */
function workflowStateReason(
	stage: PipelineStageKey | null,
	rawPath: string,
): string {
	const stageLabel = stage ? `stage "${stage}"` : "the current stage";
	return (
		`Pedstack stage guard blocked this write: ${stageLabel} may never write ` +
		`workflow state path "${rawPath}" (class: workflow-state). Workflow ` +
		`state is managed by extension tools, not write/edit. ` +
		`Set "features.stageGuard.disabled": true in config.json to bypass.`
	);
}
