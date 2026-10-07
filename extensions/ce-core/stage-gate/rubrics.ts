// The 7-stage rubric table + pure deterministic evaluator (plan Unit 1).
// Every predicate is a pure function over `Evidence`; no filesystem access here.
import type {
	DeterministicCheck,
	DeterministicCheckResult,
	DeterministicResult,
	Evidence,
	ReviewFindingsFile,
	SemanticDimension,
	StageKey,
	StageRubric,
} from "./types";

const CONTEXT_DIR = ".context/compound-engineering";

function pass(reason: string): DeterministicCheckResult {
	return { pass: true, reason };
}

function fail(reason: string): DeterministicCheckResult {
	return { pass: false, reason };
}

function check(
	id: string,
	critical: boolean,
	evaluate: (evidence: Evidence) => DeterministicCheckResult,
): DeterministicCheck {
	return { id, critical, evaluate };
}

/**
 * Shared conditional findings predicate (Unit 4). A matching sidecar is
 * malformed when its `count` does not equal `findings.length`; a malformed
 * sidecar always fails. A sidecar is required only when the prior fresh gate
 * action demanded `review`, and it must have been observed at or after the
 * demanding record's `updatedAt` (Unit 5). A well-formed zero-finding sidecar
 * that satisfies freshness passes, so a clean review is never a deadlock.
 */
function findingsObservedAtOrAfter(
	file: ReviewFindingsFile,
	updatedAt: string,
): boolean {
	if (typeof file.observedAt !== "string") return false;
	const observed = Date.parse(file.observedAt);
	const demand = Date.parse(updatedAt);
	if (Number.isNaN(observed) || Number.isNaN(demand)) return false;
	return observed >= demand;
}

function findingsPersisted(
	id: string,
	matches: (file: ReviewFindingsFile) => boolean,
): DeterministicCheck {
	return check(id, true, (e) => {
		const files = e.reviewFindings.filter(matches);
		const malformed = files.filter(
			(f) => !Array.isArray(f.findings) || f.count !== f.findings.length,
		);
		if (malformed.length > 0) {
			return fail(
				`${malformed.length} malformed findings file(s): count !== findings.length`,
			);
		}
		const required = e.priorGate?.action === "review";
		if (files.length === 0) {
			return required
				? fail("prior gate action 'review' requires a persisted findings file")
				: pass("no independent review demanded by the prior gate action");
		}
		if (!required) return pass(`${files.length} findings file(s) persisted`);
		const demandAt = e.priorGate?.updatedAt;
		const fresh =
			typeof demandAt === "string"
				? files.filter((f) => findingsObservedAtOrAfter(f, demandAt))
				: [];
		return fresh.length > 0
			? pass(`${fresh.length} findings file(s) satisfy the prior review demand`)
			: fail(
					"prior gate action 'review' requires a findings file observed at or after the gate record (freshness)",
				);
	});
}

/** True when a markdown heading starts with `name` on a word boundary. */
function hasHeading(txt: string, name: string): boolean {
	const target = name.toLowerCase();
	for (const line of txt.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("#")) continue;
		const headingText = trimmed.replace(/^#+\s*/, "").toLowerCase();
		if (!headingText.startsWith(target)) continue;
		const next = headingText.charAt(target.length);
		if (next === "" || !/\w/.test(next)) return true;
	}
	return false;
}

function requiredHeadings(
	id: string,
	headings: readonly string[],
): DeterministicCheck {
	return check(id, true, (e) => {
		const missing = headings.filter((name) => !hasHeading(e.txt, name));
		return missing.length === 0
			? pass(`headings present: ${headings.join(", ")}`)
			: fail(`missing headings: ${missing.join(", ")}`);
	});
}

function minLength(id: string, min: number): DeterministicCheck {
	return check(id, true, (e) => {
		const bytes = Buffer.byteLength(e.txt, "utf8");
		return bytes >= min
			? pass(`${bytes} bytes >= ${min}`)
			: fail(`${bytes} bytes < ${min} required`);
	});
}

const PLACEHOLDER_PATTERN = /(?:^|\W)(TODO|TBD|FIXME|XXX|lorem ipsum)(?:\W|$)/i;
const ANGLE_PLACEHOLDER_PATTERN = /<[a-z][a-z0-9 _-]{2,}>/;

function hasPlaceholder(txt: string): boolean {
	return PLACEHOLDER_PATTERN.test(txt) || ANGLE_PLACEHOLDER_PATTERN.test(txt);
}

const noPlaceholders: DeterministicCheck = check(
	"no_placeholders",
	true,
	(e) =>
		hasPlaceholder(e.txt)
			? fail("artifact contains a placeholder token")
			: pass("no placeholder tokens found"),
);

/**
 * Non-critical docs-verification obligation check. `evidence.ts` owns the store
 * read so no mode logic leaks in here; the verdict matrix follows the
 * requirements (open/stale/missing fail, degraded fails only when fail-closed).
 */
const sourceVerificationObligations = check(
	"source_verification_obligations",
	false,
	(e) => {
		const obligations = e.obligations;
		if (!obligations || !obligations.applicable) {
			return pass("docs-verification not applicable");
		}
		if (!obligations.planHasExternalPackages) {
			return pass("no external packages detected in the plan");
		}
		if (!obligations.storePresent) {
			return fail(
				"plan touches external packages but no docs-verification store is present",
			);
		}
		if (obligations.stale) {
			return fail("docs-verification store is stale against the current plan");
		}
		if (obligations.degraded) {
			return obligations.failClosed
				? fail(
						"docs-verification is degraded and features.docsVerification.failClosed=true",
					)
				: pass("docs-verification degraded but fail-open (failClosed=false)");
		}
		if (obligations.open > 0) {
			return fail(`${obligations.open} open docs-verification obligation(s)`);
		}
		return pass("all tracked docs-verification obligations satisfied or waived");
	},
);

const artifactPresent: DeterministicCheck = check(
	"artifact_present",
	true,
	(e) => {
		if (e.files.length === 0) return fail("no artifact files resolved");
		const empty: string[] = [];
		for (const artifact of e.files) {
			if (artifact.bytes <= 0) empty.push(artifact.path);
		}
		return empty.length === 0
			? pass(`${e.files.length} file(s) present`)
			: fail(`empty files: ${empty.join(", ")}`);
	},
);

const PASS_MARKER = /(pass|passed|green|0 fail)/i;

/** Concatenates the context-state `verification` field and the artifact text. */
function verificationText(e: Evidence): string {
	const raw = e.contextState?.verification;
	const contextPart = typeof raw === "string" ? raw : "";
	return `${contextPart}\n${e.txt}`;
}

/** "0 fail" is a pass marker, so it is stripped before looking for failures. */
function hasFailingTests(text: string): boolean {
	const withoutZeroFails = text.replace(/\b0\s+fail(?:ing|ed|s)?\b/gi, "");
	return /\bfail(?:ing|ed|s)?\b/i.test(withoutZeroFails);
}

function verificationRecorded(id: string): DeterministicCheck {
	return check(id, true, (e) => {
		const text = verificationText(e);
		return PASS_MARKER.test(text)
			? pass("verification pass marker found")
			: fail("no verification pass marker found");
	});
}

const testsNotFailing = check("tests_not_failing", true, (e) => {
	const text = verificationText(e);
	return hasFailingTests(text)
		? fail("verification text reports failing tests")
		: pass("no failing-test markers");
});

const checkpointConsistent = check("checkpoint_consistent", true, (e) => {
	if (e.checkpoints.length === 0) return fail("no checkpoint found");
	const failed = e.checkpoints.filter((c) => c.status === "failed");
	if (failed.length > 0) {
		return fail(`checkpoint status failed: ${failed.map((c) => c.path).join(", ")}`);
	}
	if (e.planText !== null) {
		const hasCompleted = e.checkpoints.some(
			(c) => Array.isArray(c.completedUnits) && c.completedUnits.length >= 1,
		);
		if (!hasCompleted) {
			return fail("a plan is known but no checkpoint lists completed units");
		}
	}
	return pass("checkpoint consistent");
});

const PATH_TOKEN = /`[^`\s]*[./][^`\s]*`/;

function unitBlocks(txt: string): string[] {
	return txt.split(/^###\s+Unit\b[^\n]*$/im).slice(1);
}

const reviewFindingsPersisted = findingsPersisted(
	"review_findings_persisted",
	(f) => /04-review\.json$/.test(f.path),
);

const findingsReferenceFileLine = check(
	"findings_reference_file_line",
	true,
	(e) => {
		const findings = e.reviewFindings.flatMap((f) => f.findings);
		if (findings.length === 0) return pass("no findings to reference");
		const allHaveEvidence = findings.every(
			(f) => typeof f.evidence === "string" && f.evidence.trim().length > 0,
		);
		const anyFileLine = findings.some(
			(f) => typeof f.evidence === "string" && /[\w./-]+:\d+/.test(f.evidence),
		);
		return allHaveEvidence && anyFileLine
			? pass("findings reference paths and lines")
			: fail("a finding is missing evidence or no finding references path:line");
	},
);

const severityClassified = check("severity_classified", true, (e) => {
	const findings = e.reviewFindings.flatMap((f) => f.findings);
	const bad = findings.filter(
		(f) => !["high", "moderate", "low"].includes(String(f.severity)),
	);
	return bad.length === 0
		? pass("all findings classified high|moderate|low")
		: fail(`${bad.length} finding(s) use an unknown severity`);
});

function dimension(
	id: string,
	description: string,
	weight = 1,
): SemanticDimension {
	return { id, weight, description };
}

// D2: proportionate protected-complexity exemption, shared by every
// overengineering question so no protected category is penalized.
const PROPORTIONALITY_NOTE =
	"Complexity that implements a stated requirement or proportionately serves a " +
	"protected category (validation, security, observability, migration, error " +
	"handling, tests) is correct and must not lower this score.";

/** The four floor-only overengineering dimensions, appended to plan/work/review. */
function overengineeringDimensions(): SemanticDimension[] {
	return [
		dimension(
			"no_unrequested_abstraction",
			`No abstraction beyond what the requirement asks for. ${PROPORTIONALITY_NOTE} Judged against both baselines.`,
		),
		dimension(
			"scope_fidelity",
			`The change stays within the baseline scope. ${PROPORTIONALITY_NOTE} Judged against the requirements baseline.`,
		),
		dimension(
			"complexity_proportionality",
			`The amount of complexity is proportional to the requirement at hand. ${PROPORTIONALITY_NOTE} Judged against the plan baseline.`,
		),
		dimension(
			"dependency_justification",
			"Every added dependency is justified; built-ins and already-installed dependencies are preferred. Judged against the plan baseline.",
		),
	];
}

// --- 01-brainstorm ---------------------------------------------------------

const brainstormRubric: StageRubric = {
	stage: "01-brainstorm",
	artifactGlobs: ["docs/brainstorms/*.md"],
	artifactDir: "docs/brainstorms",
	findingsGlob: "*-01-brainstorm.json",
	checks: [
		artifactPresent,
		requiredHeadings("required_headings", [
			"Problem",
			"Goals",
			"Non-goals",
			"Approach",
			"Recommended",
			"Success",
		]),
		minLength("min_length", 600),
		noPlaceholders,
		findingsPersisted("multi_reviewer_findings", (f) =>
			/01-brainstorm\.json$/.test(f.path),
		),
	],
	semanticDimensions: [
		dimension("problem_clarity", "The problem is stated concretely."),
		dimension("goal_specificity", "Goals are specific, not generic."),
		dimension("alternatives_compared", "Alternatives are genuinely compared."),
		dimension("measurable_success", "Success criteria are measurable."),
	],
};

// --- 02-plan ---------------------------------------------------------------

const planRubric: StageRubric = {
	stage: "02-plan",
	artifactGlobs: ["docs/plans/*.md"],
	artifactDir: "docs/plans",
	checks: [
		artifactPresent,
		requiredHeadings("required_headings", [
			"Problem summary",
			"Implementation units",
			"Verification",
		]),
		minLength("min_length", 800),
		noPlaceholders,
		sourceVerificationObligations,
		check("units_present", true, (e) => {
			const hasHeadingLine = hasHeading(e.txt, "Implementation units");
			const hasUnit = /^###\s+Unit\b/im.test(e.txt);
			return hasHeadingLine && hasUnit
				? pass("implementation units present")
				: fail("missing '## Implementation units' or a '### Unit' block");
		}),
		check("units_name_files", true, (e) => {
			const blocks = unitBlocks(e.txt);
			if (blocks.length === 0) return fail("no unit blocks found");
			const bad = blocks.filter(
				(block) => !/\bFiles\b/i.test(block) || !PATH_TOKEN.test(block),
			);
			return bad.length === 0
				? pass("every unit names files")
				: fail(`${bad.length} unit block(s) lack a Files line with a path token`);
		}),
		check("tdd_gates_stated", true, (e) =>
			e.txt.includes("RED") && e.txt.includes("GREEN")
				? pass("RED/GREEN gates stated")
				: fail("RED and GREEN gates are not both stated"),
		),
		check("strict_review_recorded", true, (e) =>
			e.txt.includes("Strict Review")
				? pass("Strict Review recorded")
				: fail("no Strict Review section"),
		),
	],
	semanticDimensions: [
		dimension("unit_atomicity", "Units are atomic and independently testable."),
		dimension("file_targets_specific", "File targets are specific."),
		dimension("failure_modes_covered", "Failure/error modes are covered."),
		dimension("test_plan_coherent", "The test plan is coherent."),
		...overengineeringDimensions(),
	],
};

// --- 03-work ---------------------------------------------------------------

const workRubric: StageRubric = {
	stage: "03-work",
	artifactGlobs: [
		`${CONTEXT_DIR}/stage-reports/03-work.md`,
		`${CONTEXT_DIR}/checkpoints/*.json`,
	],
	artifactDir: `${CONTEXT_DIR}/stage-reports`,
	checks: [
		verificationRecorded("work_verification_recorded"),
		testsNotFailing,
		checkpointConsistent,
		sourceVerificationObligations,
	],
	semanticDimensions: [
		dimension("plan_scope_adherence", "Work adheres to the planned scope."),
		dimension("tests_meaningful", "Tests are meaningful, not trivial."),
		dimension("error_handling_covered", "Error handling is covered."),
		...overengineeringDimensions(),
	],
};

// --- 04-review -------------------------------------------------------------

const reviewRubric: StageRubric = {
	stage: "04-review",
	artifactGlobs: [
		`${CONTEXT_DIR}/review-findings/*-04-review.json`,
		"docs/reviews/*.md",
	],
	artifactDir: `${CONTEXT_DIR}/review-findings`,
	findingsGlob: "*-04-review.json",
	checks: [reviewFindingsPersisted, findingsReferenceFileLine, severityClassified],
	semanticDimensions: [
		dimension("evidence_first_findings", "Findings are evidence-first."),
		dimension("coverage_across_axes", "Coverage spans the review axes."),
		dimension("actionable_recommendations", "Recommendations are actionable."),
		...overengineeringDimensions(),
	],
};

// --- 04-5-debug ------------------------------------------------------------

const debugRubric: StageRubric = {
	stage: "04-5-debug",
	artifactGlobs: [`${CONTEXT_DIR}/stage-reports/04-5-debug.md`],
	artifactDir: `${CONTEXT_DIR}/stage-reports`,
	checks: [
		check("root_cause_stated", true, (e) => {
			const hasRootCause = /(^|\n)(#{1,6}\s*)?Root cause\b/i.test(e.txt);
			return hasRootCause && !hasPlaceholder(e.txt)
				? pass("root cause stated")
				: fail("no non-placeholder 'Root cause' heading or line");
		}),
		verificationRecorded("verification_recorded"),
		check("regression_test_referenced", true, (e) =>
			/tests\/|regression/i.test(e.txt)
				? pass("regression test referenced")
				: fail("no tests/ path or regression mention"),
		),
	],
	semanticDimensions: [
		dimension("root_cause_depth", "Root cause goes past symptoms."),
		dimension("fix_minimality", "The fix is minimal."),
		dimension("repro_regression_value", "Repro/regression value is real."),
	],
};

// --- 05-learn --------------------------------------------------------------

const learnRubric: StageRubric = {
	stage: "05-learn",
	artifactGlobs: ["docs/solutions/**/*.md"],
	artifactDir: "docs/solutions",
	checks: [
		artifactPresent,
		requiredHeadings("required_headings", ["Problem", "Solution"]),
		minLength("min_length", 400),
		noPlaceholders,
		check("overlap_check_referenced", true, (e) =>
			/overlap/i.test(e.txt)
				? pass("overlap check referenced")
				: fail("no overlap mention"),
		),
	],
	semanticDimensions: [
		dimension("reusability_searchability", "The solution is reusable/searchable."),
		dimension(
			"root_cause_resolution_captured",
			"Root cause and resolution are captured.",
		),
		dimension("not_a_diff_restatement", "It is not a restatement of the diff."),
	],
};

// --- 06-docsync ------------------------------------------------------------

const docsyncRubric: StageRubric = {
	stage: "06-docsync",
	artifactGlobs: [`${CONTEXT_DIR}/stage-reports/06-docsync.md`],
	artifactDir: `${CONTEXT_DIR}/stage-reports`,
	checks: [
		check("docsync_evaluated", true, (e) => {
			const mentionsDoc = /README|AGENTS/.test(e.txt);
			const mentionsOutcome = /updated|no-op|no change|rationale/i.test(e.txt);
			return mentionsDoc && mentionsOutcome
				? pass("README/AGENTS outcome recorded")
				: fail("no README/AGENTS updated or explicit no-op rationale");
		}),
		noPlaceholders,
		check("exit_criteria_met", true, (e) =>
			/exit criteria/i.test(e.txt)
				? pass("exit criteria recorded")
				: fail("no exit criteria mention"),
		),
	],
	semanticDimensions: [
		dimension("docs_match_code", "Docs match the code changes."),
		dimension("entry_points_accurate", "Entry points are accurate."),
		dimension("no_stale_statements", "No stale statements remain."),
	],
};

export const stageRubrics: Record<StageKey, StageRubric> = {
	"01-brainstorm": brainstormRubric,
	"02-plan": planRubric,
	"03-work": workRubric,
	"04-review": reviewRubric,
	"04-5-debug": debugRubric,
	"05-learn": learnRubric,
	"06-docsync": docsyncRubric,
};

export function getStageRubric(stage: StageKey): StageRubric {
	return stageRubrics[stage];
}

/** Runs every atomic predicate exactly once, in table order. */
export function evaluateDeterministic(
	rubric: StageRubric,
	evidence: Evidence,
): DeterministicResult[] {
	return rubric.checks.map((entry) => {
		const outcome = entry.evaluate(evidence);
		return {
			id: entry.id,
			critical: entry.critical,
			pass: outcome.pass,
			reason: outcome.reason,
		};
	});
}
