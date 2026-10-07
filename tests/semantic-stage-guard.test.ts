import { describe, expect, test } from "bun:test";
import {
	applyJevAnswers,
	buildGuardRequest,
	JEV_COMMAND_STATE_MAX_CHARS,
	MIN_EFFECT_CONFIDENCE,
	MIN_INTENT_CONFIDENCE,
	MESSAGE_COMMAND_MAX_CHARS,
	planCommandGuard,
	redactCommand,
	TRUNCATION_MARKER,
	truncateCommand,
	type DeterministicPlan,
} from "../extensions/ce-core/utils/semantic-stage-guard";
import type { EffectClass } from "../extensions/ce-core/utils/command-effect";
import type { PathClass } from "../extensions/ce-core/utils/capability-matrix";
import type { JevResult } from "../extensions/ce-core/jev/types";

const ROOT = "/repo";
const ALL_EFFECTS: EffectClass[] = [
	"read_only",
	"mutates_workspace",
	"deletes_or_destructive",
	"installs_dependencies",
	"runs_tests_or_builds",
	"package_runner",
	"pipe_to_shell",
	"container_or_remote",
	"ambiguous",
];

function plan(stage: string | null, command: string): DeterministicPlan {
	return planCommandGuard(stage, ROOT, command);
}

function jevResult(
	effect: EffectClass,
	effectConfidence: number,
	noul: number,
	intentConfidence: number | undefined,
): JevResult {
	return {
		answers: {
			effect: {
				type: "choice",
				choice: effect,
				probabilities: Object.fromEntries(
					ALL_EFFECTS.map((label) => [label, label === effect ? 1 : 0]),
				),
				confidence: effectConfidence,
			},
			intent: {
				type: "noul",
				noul,
				...(intentConfidence === undefined
					? {}
					: { confidence: intentConfidence }),
			},
		},
		model: "fake",
		warnings: [],
	};
}

function manualPlan(
	effect: EffectClass,
	targets: Array<{ path: string; pathClass: PathClass; allow: boolean }>,
): DeterministicPlan {
	return { effect, targets, needsJev: true, verdict: undefined };
}

// ── planCommandGuard: deterministic policy ─────────────────────────

describe("planCommandGuard deterministic policy", () => {
	test("canonical 02-plan examples match the traceability table", () => {
		expect(plan("02-plan", 'grep -rn "foo" extensions/').verdict?.verdict).toBe(
			"allow",
		);
		expect(
			plan("02-plan", "sed -i 's/a/b/' extensions/ce-core/index.ts").verdict
				?.verdict,
		).toBe("block");
		expect(
			plan("02-plan", "echo x > extensions/ce-core/index.ts").verdict?.verdict,
		).toBe("block");
		expect(plan("02-plan", "bun install").verdict?.verdict).toBe("block");
		expect(plan("02-plan", "bun test").verdict?.verdict).toBe("block");
		expect(plan("02-plan", "python gen.py").needsJev).toBe(true);
		expect(plan("02-plan", "node -e \"1\"").needsJev).toBe(true);
		expect(plan("02-plan", "bun run generate").needsJev).toBe(true);
	});

	test("test/build runs are allowed in exactly three stages", () => {
		for (const stage of ["03-work", "04-5-debug", "04-review"]) {
			expect(plan(stage, "bun test").verdict?.verdict).toBe("allow");
		}
		for (const stage of ["01-brainstorm", "02-plan", "05-learn", "06-docsync"]) {
			expect(plan(stage, "bun test").verdict?.verdict).toBe("block");
		}
	});

	test("dependency installs are allowed only in 03-work", () => {
		expect(plan("03-work", "bun install").verdict?.verdict).toBe("allow");
		for (const stage of ["02-plan", "04-review", "06-docsync"]) {
			expect(plan(stage, "npm install left-pad").verdict?.verdict).toBe("block");
		}
	});

	test("idle and unknown stages fail open without a Jev call", () => {
		for (const stage of [null, undefined, "99-other"]) {
			const result = plan(stage as string | null, "rm extensions/foo.ts");
			expect(result.verdict?.verdict).toBe("allow");
			expect(result.needsJev).toBe(false);
		}
	});

	test("bash may publish only the active stage's canonical report", () => {
		const own = plan(
			"03-work",
			"cp stage-reports/03-work.md .context/compound-engineering/stage-reports/03-work.md",
		);
		expect(own.needsJev).toBe(false);
		expect(own.verdict?.verdict).toBe("allow");
		expect(
			own.targets.some(
				(target) =>
					target.pathClass === "stage-report" && target.allow === true,
			),
		).toBe(true);

		const foreign = plan(
			"03-work",
			"cp stage-reports/03-work.md .context/compound-engineering/stage-reports/04-5-debug.md",
		);
		expect(foreign.needsJev).toBe(false);
		expect(foreign.verdict?.verdict).toBe("block");
		expect(
			foreign.targets.some(
				(target) =>
					target.pathClass === "stage-report" && target.allow === false,
			),
		).toBe(true);
	});

	test("read-only is allowed in every stage", () => {
		for (const stage of [
			"01-brainstorm",
			"02-plan",
			"03-work",
			"04-review",
			"04-5-debug",
			"05-learn",
			"06-docsync",
		]) {
			expect(plan(stage, "git status").verdict?.verdict).toBe("allow");
		}
	});
});

// ── planCommandGuard: unresolvable routing ─────────────────────────

describe("planCommandGuard unresolvable routing", () => {
	test("an unresolvable target routes to Jev", () => {
		expect(plan("03-work", "rm $TARGET").needsJev).toBe(true);
		expect(plan("03-work", "sed -i 's/a/b/'").needsJev).toBe(true);
	});

	test("a resolved writable target is a deterministic allow", () => {
		const result = plan("03-work", "rm extensions/foo.ts");
		expect(result.needsJev).toBe(false);
		expect(result.verdict?.verdict).toBe("allow");
	});

	test("a deterministic block never needs Jev", () => {
		const result = plan("02-plan", "rm extensions/foo.ts");
		expect(result.needsJev).toBe(false);
		expect(result.verdict?.verdict).toBe("block");
		expect(result.verdict?.effectSource).toBe("deterministic");
	});
});

// ── applyJevAnswers: mapping, thresholds, invariants ───────────────

describe("applyJevAnswers", () => {
	test("read_only allows regardless of intent", () => {
		const verdict = applyJevAnswers(
			"02-plan",
			ROOT,
			plan("02-plan", "python gen.py"),
			jevResult("read_only", 0.9, 1, 0.9),
		);
		expect(verdict.verdict).toBe("allow");
		expect(verdict.effectSource).toBe("jev");
	});

	test("mutates + intent allows when the stage can write source", () => {
		const verdict = applyJevAnswers(
			"03-work",
			ROOT,
			plan("03-work", "python gen.py"),
			jevResult("mutates_workspace", 0.9, 1, 0.9),
		);
		expect(verdict.verdict).toBe("allow");
	});

	test("mutates + intent blocks when the stage cannot write source", () => {
		const verdict = applyJevAnswers(
			"02-plan",
			ROOT,
			plan("02-plan", "python gen.py"),
			jevResult("mutates_workspace", 0.9, 1, 0.9),
		);
		expect(verdict.verdict).toBe("block");
		expect(verdict.reason).toContain("02-plan");
		expect(verdict.reason).toContain("features.stageGuard.disabled");
	});

	test("mutates without intent allows", () => {
		const verdict = applyJevAnswers(
			"02-plan",
			ROOT,
			plan("02-plan", "python gen.py"),
			jevResult("mutates_workspace", 0.9, 0, 0.9),
		);
		expect(verdict.verdict).toBe("allow");
	});

	test("destructive with no resolved target blocks with the unknown-target template", () => {
		for (const intent of [0, 1]) {
			const verdict = applyJevAnswers(
				"01-brainstorm",
				ROOT,
				plan("01-brainstorm", "python gen.py"),
				jevResult("deletes_or_destructive", 0.9, intent, 0.9),
			);
			expect(verdict.verdict).toBe("block");
			expect(verdict.reason).toContain("no resolvable target");
		}
	});

	test("workflow-state is never allowed via a Jev optimistic answer", () => {
		const verdict = applyJevAnswers(
			"03-work",
			ROOT,
			manualPlan("mutates_workspace", [
				{ path: ".context/compound-engineering/x.json", pathClass: "workflow-state", allow: false },
			]),
			jevResult("mutates_workspace", 0.9, 1, 0.9),
		);
		expect(verdict.verdict).toBe("block");
	});

	test("dependency and test/build Jev effects use the stage policy", () => {
		expect(
			applyJevAnswers(
				"02-plan",
				ROOT,
				plan("02-plan", "python gen.py"),
				jevResult("installs_dependencies", 0.9, 1, 0.9),
			).verdict,
		).toBe("block");
		expect(
			applyJevAnswers(
				"03-work",
				ROOT,
				plan("03-work", "python gen.py"),
				jevResult("installs_dependencies", 0.9, 1, 0.9),
			).verdict,
		).toBe("allow");
		expect(
			applyJevAnswers(
				"03-work",
				ROOT,
				plan("03-work", "python gen.py"),
				jevResult("runs_tests_or_builds", 0.9, 1, 0.9),
			).verdict,
		).toBe("allow");
	});

	test("ambiguous and unmappable effects fall back without blocking", () => {
		for (const effect of ALL_EFFECTS.filter((label) =>
			["package_runner", "pipe_to_shell", "container_or_remote", "ambiguous"].includes(label),
		)) {
			const verdict = applyJevAnswers(
				"02-plan",
				ROOT,
				plan("02-plan", "python gen.py"),
				jevResult(effect, 0.9, 1, 0.9),
			);
			expect(verdict.verdict).toBe("allow");
			expect(verdict.effectSource).toBe("fallback");
			expect(verdict.fallbackReason).toBeString();
		}
	});

	test("below-threshold effect confidence falls back", () => {
		const verdict = applyJevAnswers(
			"02-plan",
			ROOT,
			plan("02-plan", "python gen.py"),
			jevResult("mutates_workspace", MIN_EFFECT_CONFIDENCE - 0.1, 1, 0.9),
		);
		expect(verdict.effectSource).toBe("fallback");
		expect(verdict.verdict).toBe("allow");
	});

	test("missing or below-threshold intent confidence falls back", () => {
		for (const intentConfidence of [undefined, MIN_INTENT_CONFIDENCE - 0.1]) {
			const verdict = applyJevAnswers(
				"02-plan",
				ROOT,
				plan("02-plan", "python gen.py"),
				jevResult("mutates_workspace", 0.9, 1, intentConfidence),
			);
			expect(verdict.effectSource).toBe("fallback");
		}
	});
});

// ── buildGuardRequest ──────────────────────────────────────────────

describe("buildGuardRequest", () => {
	const stage = "02-plan";
	const request = () => buildGuardRequest(stage, "python gen.py", plan(stage, "python gen.py"));

	test("asks exactly the effect and intent questions", () => {
		const built = request();
		expect(Object.keys(built.questions).sort()).toEqual(["effect", "intent"]);
		expect(built.questions.effect.type).toBe("choice");
		expect(built.questions.intent.type).toBe("noul");
	});

	test("effect option keys equal the nine EffectClass labels", () => {
		const question = request().questions.effect;
		if (question.type !== "choice") throw new Error("effect must be a choice");
		expect(Object.keys(question.criteria).sort()).toEqual([...ALL_EFFECTS].sort());
	});

	test("truncates a long command to the state cap with a marker", () => {
		const command = `echo ${"x".repeat(JEV_COMMAND_STATE_MAX_CHARS + 500)}`;
		const built = buildGuardRequest(stage, command, plan(stage, command));
		const state = built.state as { command: string };
		expect(state.command.length).toBe(
			JEV_COMMAND_STATE_MAX_CHARS + TRUNCATION_MARKER.length,
		);
		expect(state.command.endsWith(TRUNCATION_MARKER)).toBe(true);
	});

	test("never embeds raw env-assignment secrets in state", () => {
		const command = "API_KEY=supersecret bun run generate";
		const built = buildGuardRequest(stage, command, plan(stage, command));
		expect(JSON.stringify(built.state)).not.toContain("supersecret");
	});
});

// ── redaction + truncation ─────────────────────────────────────────

describe("redactCommand and truncateCommand", () => {
	test("masks env assignments and quoted literals", () => {
		expect(redactCommand("FOO=bar cmd")).not.toContain("bar");
		expect(redactCommand("FOO=bar cmd")).toContain("FOO=***");
		expect(redactCommand('echo "secret value"')).not.toContain("secret value");
		expect(redactCommand("echo 'secret value'")).not.toContain("secret value");
	});

	test("appends the truncation marker only when cut", () => {
		const short = "echo hi";
		expect(truncateCommand(short, MESSAGE_COMMAND_MAX_CHARS)).toBe(short);
		const long = "y".repeat(MESSAGE_COMMAND_MAX_CHARS + 10);
		const cut = truncateCommand(long, MESSAGE_COMMAND_MAX_CHARS);
		expect(cut).toBe("y".repeat(MESSAGE_COMMAND_MAX_CHARS) + TRUNCATION_MARKER);
	});
});

// ── parseGuardMode ─────────────────────────────────────────────────

