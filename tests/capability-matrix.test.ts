import { describe, expect, test } from "bun:test";
import {
	ALL_PATH_CLASSES,
	classifyPath,
	evaluateWrite,
	STAGE_CAPABILITIES,
	type PathClass,
} from "../extensions/ce-core/utils/capability-matrix";
import type { PipelineStageKey } from "../extensions/ce-core/commands/pedstack";

// ── Fixtures ───────────────────────────────────────────────────────

const ROOT = "/repo";

/** One representative repo-relative path per path class. */
const CLASS_PATHS: Record<PathClass, string> = {
	brainstorm: "docs/brainstorms/2026-01-01-x-requirements.md",
	plan: "docs/plans/2026-01-01-x-plan.md",
	review: "docs/reviews/2026-01-01-x-review.md",
	solution: "docs/solutions/workflow/x.md",
	docs: "README.md",
	tests: "tests/x.test.ts",
	source: "extensions/ce-core/index.ts",
	config: "package.json",
	deps: "bun.lock",
	"stage-report": ".context/compound-engineering/stage-reports/03-work.md",
	"workflow-state": ".context/compound-engineering/active-stage.json",
	unknown: "assets/logo.png",
};

const STAGES: readonly PipelineStageKey[] = [
	"01-brainstorm",
	"02-plan",
	"03-work",
	"04-review",
	"04-5-debug",
	"05-learn",
	"06-docsync",
];

/**
 * Authoritative ordinary writable classes from the capability matrix.
 * Every stage always allows `unknown`; `stage-report` is handled separately
 * because only the active stage's own canonical report is writable.
 */
const WRITABLE: Record<PipelineStageKey, readonly PathClass[]> = {
	"01-brainstorm": ["brainstorm", "unknown"],
	"02-plan": ["plan", "unknown"],
	"03-work": ["tests", "source", "config", "deps", "unknown"],
	"04-review": ["review", "unknown"],
	"04-5-debug": ["tests", "source", "config", "unknown"],
	"05-learn": ["solution", "unknown"],
	"06-docsync": ["docs", "unknown"],
};

const IDLE_WRITABLE: readonly PathClass[] = [
	"brainstorm",
	"plan",
	"review",
	"solution",
	"docs",
	"tests",
	"source",
	"config",
	"deps",
	"unknown",
];

// ── classifyPath ───────────────────────────────────────────────────

describe("classifyPath", () => {
	test("exposes all 12 path classes", () => {
		expect(ALL_PATH_CLASSES.length).toBe(12);
		expect([...ALL_PATH_CLASSES].sort()).toEqual(
			([
				"brainstorm",
				"config",
				"deps",
				"docs",
				"plan",
				"review",
				"solution",
				"source",
				"stage-report",
				"tests",
				"unknown",
				"workflow-state",
			] as PathClass[]).sort(),
		);
	});

	test("classifies each representative path", () => {
		for (const [cls, p] of Object.entries(CLASS_PATHS)) {
			expect(classifyPath(ROOT, p)).toBe(cls as PathClass);
		}
	});

	test("first match wins for overlapping prefixes", () => {
		expect(classifyPath(ROOT, "docs/brainstorms/x.md")).toBe("brainstorm");
		expect(classifyPath(ROOT, "docs/plans/x.md")).toBe("plan");
		expect(classifyPath(ROOT, "docs/solutions/x.md")).toBe("solution");
		expect(classifyPath(ROOT, "extensions/foo.test.ts")).toBe("tests");
		expect(classifyPath(ROOT, "tests/x.test.ts")).toBe("tests");
		expect(classifyPath(ROOT, "skills/01-brainstorm/SKILL.md")).toBe("source");
		expect(classifyPath(ROOT, "scripts/tool.mjs")).toBe("source");
		expect(classifyPath(ROOT, "README.md")).toBe("docs");
		expect(classifyPath(ROOT, ".github/workflows/ci.yml")).toBe("config");
	});

	test("normalizes separators, dot segments, and absolute paths", () => {
		expect(classifyPath(ROOT, "extensions\\ce-core\\index.ts")).toBe("source");
		expect(classifyPath(ROOT, "./docs/plans/x.md")).toBe("plan");
		expect(classifyPath(ROOT, "docs/plans/x.md/")).toBe("plan");
		// A bare directory path collapses to `docs` (no artifact prefix match).
		expect(classifyPath(ROOT, "docs/plans/")).toBe("docs");
		expect(classifyPath(ROOT, "/repo/docs/plans/x.md")).toBe("plan");
		expect(classifyPath(ROOT, "a/../b")).toBe("unknown");
	});

	test("returns unknown for unclassifiable or out-of-repo input", () => {
		expect(classifyPath(ROOT, "")).toBe("unknown");
		expect(classifyPath(ROOT, ".")).toBe("unknown");
		expect(classifyPath(ROOT, "../../etc/passwd")).toBe("unknown");
		expect(classifyPath(ROOT, "C:/Users/x/file.ts")).toBe("unknown");
		expect(classifyPath(ROOT, "assets/logo.png")).toBe("unknown");
		// Non-string input must not throw; the runtime guard returns unknown.
		expect(classifyPath(ROOT, null as unknown as string)).toBe("unknown");
		expect(classifyPath(ROOT, 42 as unknown as string)).toBe("unknown");
	});

	test("classifies canonical stage reports separately from workflow state", () => {
		expect(
			classifyPath(
				ROOT,
				".context/compound-engineering/stage-reports/03-work.md",
			),
		).toBe("stage-report");
		expect(
			classifyPath(
				ROOT,
				".context/compound-engineering/stage-reports/not-a-stage.md",
			),
		).toBe("workflow-state");
		expect(
			classifyPath(
				ROOT,
				".context/compound-engineering/stage-reports/03-work.json",
			),
		).toBe("workflow-state");
		expect(
			classifyPath(
				ROOT,
				".context/compound-engineering/stage-reports/nested/03-work.md",
			),
		).toBe("workflow-state");
	});

	test("workflow-state invariant wins over conflicting basenames (C1)", () => {
		const fixtures = [
			".context/compound-engineering/package.json",
			".context/compound-engineering/tsconfig.json",
			".context/compound-engineering/bun.lock",
			".context/compound-engineering/notes.test.ts",
			".context/compound-engineering/README.md",
			".context/compound-engineering/active-stage.json",
			".context",
			".context/",
		];
		for (const fixture of fixtures) {
			expect(classifyPath(ROOT, fixture)).toBe("workflow-state");
		}
	});
});

// ── STAGE_CAPABILITIES ─────────────────────────────────────────────

describe("STAGE_CAPABILITIES", () => {
	test("defines a set for every pipeline stage", () => {
		for (const stage of STAGES) {
			expect(STAGE_CAPABILITIES[stage]).toBeInstanceOf(Set);
		}
	});

	test("never broadly grants workflow-state or stage-report, always grants unknown", () => {
		for (const stage of STAGES) {
			expect(STAGE_CAPABILITIES[stage].has("workflow-state")).toBe(false);
			expect(STAGE_CAPABILITIES[stage].has("stage-report")).toBe(false);
			expect(STAGE_CAPABILITIES[stage].has("unknown")).toBe(true);
		}
	});
});

// ── evaluateWrite: exhaustive ordinary matrix + stage reports ─────

describe("evaluateWrite matrix", () => {
	for (const stage of STAGES) {
		for (const cls of ALL_PATH_CLASSES) {
			if (cls === "stage-report") continue;
			const expected = WRITABLE[stage].includes(cls);
			const label = `${stage} ${expected ? "allows" : "blocks"} ${cls}`;
			test(label, () => {
				const verdict = evaluateWrite(stage, ROOT, CLASS_PATHS[cls]);
				expect(verdict.pathClass).toBe(cls);
				expect(verdict.allow).toBe(expected);
				if (!expected) {
					expect(typeof verdict.reason).toBe("string");
				}
			});
		}
	}

	test("each stage may write only its own canonical stage report", () => {
		for (const stage of STAGES) {
			const own = `.context/compound-engineering/stage-reports/${stage}.md`;
			const ownVerdict = evaluateWrite(stage, ROOT, own);
			expect(ownVerdict).toEqual({ allow: true, pathClass: "stage-report" });

			const foreignStage = STAGES.find((candidate) => candidate !== stage)!;
			const foreign =
				`.context/compound-engineering/stage-reports/${foreignStage}.md`;
			const foreignVerdict = evaluateWrite(stage, ROOT, foreign);
			expect(foreignVerdict.allow).toBe(false);
			expect(foreignVerdict.pathClass).toBe("stage-report");
			expect(foreignVerdict.reason).toContain("own canonical stage report");
		}
	});

	test("idle (null stage) blocks workflow-state and stage reports", () => {
		for (const cls of ALL_PATH_CLASSES) {
			const expected = IDLE_WRITABLE.includes(cls);
			const verdict = evaluateWrite(null, ROOT, CLASS_PATHS[cls]);
			expect(verdict.allow).toBe(expected);
		}
	});

	test("undefined stage is treated as idle", () => {
		expect(evaluateWrite(undefined, ROOT, "docs/plans/x.md").allow).toBe(true);
		expect(
			evaluateWrite(undefined, ROOT, ".context/compound-engineering/x.json")
				.allow,
		).toBe(false);
	});

	test("unknown stage string fails open except for workflow-state and stage reports", () => {
		for (const cls of ALL_PATH_CLASSES) {
			const verdict = evaluateWrite("99-other", ROOT, CLASS_PATHS[cls]);
			expect(verdict.allow).toBe(
				cls !== "workflow-state" && cls !== "stage-report",
			);
		}
	});

	test("block reason names stage, class, path, writable classes, and override", () => {
		const verdict = evaluateWrite(
			"02-plan",
			ROOT,
			"extensions/ce-core/index.ts",
		);
		expect(verdict.allow).toBe(false);
		const reason = verdict.reason ?? "";
		expect(reason).toContain("02-plan");
		expect(reason).toContain("source");
		expect(reason).toContain("extensions/ce-core/index.ts");
		expect(reason).toContain("plan");
		expect(reason).toContain("features.stageGuard.disabled");
	});

	test("workflow-state is blocked even without a known stage", () => {
		const verdict = evaluateWrite(
			null,
			ROOT,
			".context/compound-engineering/context-state.json",
		);
		expect(verdict.allow).toBe(false);
		expect(verdict.pathClass).toBe("workflow-state");
		expect(verdict.reason).toContain("workflow-state");
		expect(verdict.reason).toContain("features.stageGuard.disabled");
	});

	test("stage-report exception never opens other workflow-state paths", () => {
		const protectedPaths = [
			".context/compound-engineering/context-state.json",
			".context/compound-engineering/active-stage.json",
			".context/compound-engineering/routing/03-work.json",
			".context/compound-engineering/stage-gates/03-work.json",
			".context/compound-engineering/handoffs/x.md",
			".context/compound-engineering/checkpoints/x.json",
		];
		for (const stage of STAGES) {
			for (const protectedPath of protectedPaths) {
				const verdict = evaluateWrite(stage, ROOT, protectedPath);
				expect(verdict.allow).toBe(false);
				expect(verdict.pathClass).toBe("workflow-state");
			}
		}
	});

	test("blocks conflicting-basename .context paths in every stage (C1)", () => {
		const fixtures = [
			".context/compound-engineering/package.json",
			".context/compound-engineering/bun.lock",
			".context/compound-engineering/notes.test.ts",
			".context/compound-engineering/README.md",
			".context",
		];
		for (const stage of STAGES) {
			for (const fixture of fixtures) {
				const verdict = evaluateWrite(stage, ROOT, fixture);
				expect(verdict.pathClass).toBe("workflow-state");
				expect(verdict.allow).toBe(false);
			}
		}
	});
});
