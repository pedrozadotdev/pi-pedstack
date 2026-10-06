// Docs verification — decision derivation, aggregation, request builder,
// obligation construction (plan Unit 3).
import { describe, expect, test } from "bun:test";
import {
	DOCS_QUESTION_IDS,
	MAX_REQUEST_BODY_BYTES,
	PACKAGE_CAP,
	aggregatePackages,
	buildDocsRequest,
	buildObligation,
	deriveDecision,
	deriveDecisionFromString,
	enforceRequestBodyLimit,
	readDocsAnswers,
	shortCircuitDecision,
} from "../extensions/ce-core/docs-verification/combine.js";
import type {
	DocsAnswers,
	DocsQuestionId,
	DocsUnit,
	DocsUnitRecord,
	PackageFact,
	UnitFacts,
} from "../extensions/ce-core/docs-verification/types.js";
import type { JevAnswer, JevResult } from "../extensions/ce-core/jev/types.js";

function pkg(name: string, over: Partial<PackageFact> = {}): PackageFact {
	return { name, version: "1.0.0", versionUnknown: false, kind: "dependency", ...over };
}

function unitFacts(over: Partial<UnitFacts> = {}): UnitFacts {
	return {
		phase: "observed",
		declaredFiles: [],
		packages: [pkg("typebox")],
		evidence: [],
		versionUnknown: false,
		...over,
	};
}

function answers(over: Partial<DocsAnswers> = {}): DocsAnswers {
	return { external_api_dependence: 0.9, version_sensitivity: 0.9, verification_material: 0.9, ...over };
}

function unit(over: Partial<DocsUnit> = {}): DocsUnit {
	return {
		slug: "frozen-types",
		heading: "Unit 1 — Frozen types",
		hash: "h",
		files: [],
		text: "### Unit 1",
		...over,
	};
}

describe("Unit 3 — decision table", () => {
	test("required when external dependence and a signal are both >= 0.50", () => {
		expect(deriveDecision(answers(), unitFacts())).toBe("required");
		expect(
			deriveDecision(
				answers({ version_sensitivity: 0.5, verification_material: 0 }),
				unitFacts(),
			),
		).toBe("required");
	});

	test("not_required when external dependence and materiality are both < 0.50", () => {
		expect(
			deriveDecision(
				answers({
					external_api_dependence: 0.4,
					version_sensitivity: 0.9,
					verification_material: 0.4,
				}),
				unitFacts(),
			),
		).toBe("not_required");
	});

	test("uncertain otherwise", () => {
		expect(
			deriveDecision(
				answers({
					external_api_dependence: 0.9,
					version_sensitivity: 0.1,
					verification_material: 0.1,
				}),
				unitFacts(),
			),
		).toBe("uncertain");
		expect(
			deriveDecision(
				answers({
					external_api_dependence: 0.1,
					version_sensitivity: 0.1,
					verification_material: 0.9,
				}),
				unitFacts(),
			),
		).toBe("uncertain");
	});

	test("exactly 0.50 counts as true (inclusive >=)", () => {
		expect(
			deriveDecision(
				answers({
					external_api_dependence: 0.5,
					version_sensitivity: 0.5,
					verification_material: 0.5,
				}),
				unitFacts(),
			),
		).toBe("required");
	});
});

describe("Unit 3 — answer reading", () => {
	function result(
		values: Record<string, number | string>,
		confidence = 0.9,
	): JevResult {
		const out: Record<string, JevAnswer> = {};
		for (const [key, value] of Object.entries(values)) {
			out[key] = { type: "noul", noul: value as number, confidence };
		}
		return { answers: out, model: "m", warnings: [] };
	}

	test("reads a full answer set for one unit", () => {
		const req = result(
			Object.fromEntries(DOCS_QUESTION_IDS.map((id: DocsQuestionId) => [`s__${id}`, 0.8])),
		);
		expect(readDocsAnswers(req, "s")).toEqual({
			external_api_dependence: 0.8,
			version_sensitivity: 0.8,
			verification_material: 0.8,
		});
	});

	test("a missing, non-numeric, or low-confidence answer is a degraded reason", () => {
		expect(typeof readDocsAnswers(result({}), "s")).toBe("string");
		expect(
			typeof readDocsAnswers(result({ "s__external_api_dependence": "x" }), "s"),
		).toBe("string");
		expect(
			typeof readDocsAnswers(
				result({ "s__external_api_dependence": 0.8 }, 0.2),
				"s",
			),
		).toBe("string");
	});

	test("deriveDecisionFromString only accepts derived decisions", () => {
		expect(deriveDecisionFromString("required")).toBe("required");
		expect(deriveDecisionFromString("not_required")).toBe("not_required");
		expect(deriveDecisionFromString("uncertain")).toBe("uncertain");
		expect(deriveDecisionFromString("boom")).toBe("uncertain");
	});
});

describe("Unit 3 — version-unknown floor and caps", () => {
	test("a version-unknown fact turns not_required into uncertain", () => {
		const facts = unitFacts({
			packages: [pkg("typebox", { version: null, versionUnknown: true })],
			versionUnknown: true,
		});
		const notRequired = answers({
			external_api_dependence: 0.2,
			verification_material: 0.2,
		});
		expect(deriveDecision(notRequired, facts)).toBe("uncertain");
	});

	test("a unit exceeding the package cap is uncertain", () => {
		const packages = Array.from({ length: PACKAGE_CAP + 1 }, (_, i) =>
			pkg(`p${i}`),
		);
		expect(aggregatePackages(unitFacts({ packages })).truncated).toBe(true);
		expect(deriveDecision(answers(), unitFacts({ packages }))).toBe("uncertain");
	});

	test("aggregation orders by first appearance then name and caps", () => {
		const packages = [pkg("b"), pkg("a"), pkg("b"), pkg("c")];
		expect(aggregatePackages(unitFacts({ packages }))).toEqual({
			names: ["b", "a", "c"],
			truncated: false,
		});
	});
});

describe("Unit 3 — short circuit", () => {
	test("observed unit with no external facts is not_required", () => {
		const facts = unitFacts({ phase: "observed", packages: [], versionUnknown: false });
		expect(shortCircuitDecision(facts)).toBe("not_required");
		expect(deriveDecision(answers(), facts)).toBe("not_required");
	});

	test("planned greenfield unit whose file is missing is uncertain", () => {
		const facts = unitFacts({
			phase: "planned",
			packages: [],
			versionUnknown: false,
			declaredFiles: [{ path: "src/new.ts", exists: false }],
		});
		expect(shortCircuitDecision(facts)).toBe("uncertain");
	});

	test("no short circuit when package facts exist", () => {
		expect(shortCircuitDecision(unitFacts())).toBeNull();
	});
});

describe("Unit 3 — request builder", () => {
	test("emits one request with three questions per scorable unit", () => {
		const units = [unit(), unit({ slug: "second", heading: "Unit 2" })];
		const facts = new Map<DocsUnit, UnitFacts>([
			[units[0], unitFacts()],
			[units[1], unitFacts({ packages: [pkg("left-pad")] })],
		]);
		const request = buildDocsRequest(units, facts);
		expect(Object.keys(request.questions)).toHaveLength(6);
		expect(Object.keys(request.questions)).toContain("frozen-types__external_api_dependence");
		expect(
			request.questions["frozen-types__external_api_dependence"].type,
		).toBe("noul");
		const state = request.state as { units: Array<{ slug: string; text?: string }> };
		expect(state.units.map((u) => u.slug)).toEqual(["frozen-types", "second"]);
		expect(JSON.stringify(request)).not.toContain("import ");
	});

	test("enforceRequestBodyLimit keeps a huge request under the byte cap", () => {
		const huge = unit({ text: `### Unit 1\n${"word ".repeat(20_000)}` });
		const request = buildDocsRequest(
			[huge],
			new Map<DocsUnit, UnitFacts>([[huge, unitFacts()]]),
		);
		enforceRequestBodyLimit(request);
		expect(Buffer.byteLength(JSON.stringify(request))).toBeLessThan(
			MAX_REQUEST_BODY_BYTES,
		);
	});
});

describe("Unit 3 — obligation construction", () => {
	function record(over: Partial<Omit<DocsUnitRecord, "obligation">> = {}): Omit<
		DocsUnitRecord,
		"obligation"
	> {
		return {
			slug: "frozen-types",
			hash: "h",
			phase: "planned",
			facts: unitFacts(),
			decision: "required",
			packages: ["typebox"],
			source: "jev",
			...over,
		};
	}

	test("a required unit produces an open obligation", () => {
		const obligation = buildObligation(record());
		expect(obligation.status).toBe("open");
		expect(obligation.decision).toBe("required");
		expect(obligation.packages).toEqual(["typebox"]);
		expect(obligation.source).toBe("jev");
		expect(typeof obligation.updatedAt).toBe("string");
	});

	test("a not_required unit produces a satisfied obligation", () => {
		expect(
			buildObligation(record({ decision: "not_required" })).status,
		).toBe("satisfied");
	});

	test("an uncertain unit produces an open obligation carrying the reason", () => {
		const obligation = buildObligation(
			record({ decision: "uncertain", reason: "outage" }),
		);
		expect(obligation.status).toBe("open");
		expect(obligation.reason).toBe("outage");
	});
});
