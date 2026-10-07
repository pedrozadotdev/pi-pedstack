// Model configuration cleanup (#6/#7): the automatic role-migration helper and
// its CLI are removed, `models.default | review | sota` is the canonical
// configuration, per-stage `model` entries remain explicit overrides, and a
// stage-gate `escalate` is a manual `/ped-reload` path.
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { collectExecutionModels } from "../extensions/ce-core/review/policy";
import { validatePiPedstackConfig } from "../extensions/ce-core/utils/config-types";
import { resolveExecutionRole } from "../extensions/ce-core/utils/model-routing";

const repoRoot = path.resolve(import.meta.dir, "..");

function read(rel: string): string {
	return readFileSync(path.join(repoRoot, rel), "utf8");
}

function listProductionTs(dir: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const abs = path.join(dir, entry.name);
		if (entry.isDirectory()) files.push(...listProductionTs(abs));
		else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(abs);
	}
	return files;
}

describe("legacy role migration is removed", () => {
	test("the helper, CLI, and dedicated test no longer exist", () => {
		expect(
			existsSync(
				path.join(repoRoot, "extensions/ce-core/utils/role-migration.ts"),
			),
		).toBe(false);
		expect(existsSync(path.join(repoRoot, "scripts/migrate-roles.ts"))).toBe(
			false,
		);
		expect(existsSync(path.join(repoRoot, "tests/role-migration.test.ts"))).toBe(
			false,
		);
	});

	test("package.json no longer exposes migrate:roles", () => {
		const pkg = JSON.parse(read("package.json")) as {
			scripts?: Record<string, string>;
		};
		expect(pkg.scripts?.["migrate:roles"]).toBeUndefined();
	});

	test("no production source imports role-migration", () => {
		const offenders = listProductionTs(path.join(repoRoot, "extensions")).filter(
			(file) => readFileSync(file, "utf8").includes("role-migration"),
		);
		expect(offenders).toEqual([]);
	});

	test("active docs no longer describe the migration helper", () => {
		for (const rel of ["README.md", "AGENTS.md", "CONTEXT.md"]) {
			const text = read(rel).toLowerCase();
			expect({ rel, hasHelper: text.includes("buildrolemigration") }).toEqual({
				rel,
				hasHelper: false,
			});
			expect({ rel, hasScript: text.includes("migrate:roles") }).toEqual({
				rel,
				hasScript: false,
			});
			expect({ rel, hasLossless: text.includes("lossless-or-refuse") }).toEqual(
				{ rel, hasLossless: false },
			);
		}
	});

	test("README states the manual migration note for the canonical roles", () => {
		expect(read("README.md")).toContain(
			"manually define `models.default`, `models.review`, and `models.sota`",
		);
	});
});

describe("canonical three-role configuration", () => {
	test("models.default, models.review, and models.sota validate as the canonical block", () => {
		const config = validatePiPedstackConfig({
			models: {
				default: { model: "provider/cheap", thinkingLevel: "medium" },
				review: { model: "provider/review", thinkingLevel: "high" },
				sota: { model: "provider/sota", thinkingLevel: "high" },
			},
			routing: {
				shadow: false,
				sotaMinScore: 0.6,
				sotaMinConfidence: 0.5,
				maxEscalationsPerStage: 1,
			},
		});

		expect(config.models?.default?.model).toBe("provider/cheap");
		expect(config.models?.review?.model).toBe("provider/review");
		expect(config.models?.sota?.model).toBe("provider/sota");
		expect(config.routing?.shadow).toBe(false);
	});

	test("models.review is never an execution role", () => {
		const config = {
			models: {
				default: { model: "provider/cheap" },
				review: { model: "provider/review" },
				sota: { model: "provider/sota" },
			},
		};

		expect(collectExecutionModels(config, "plan")).toEqual([
			"provider/cheap",
			"provider/sota",
		]);

		const decision = resolveExecutionRole({
			overrideModel: null,
			gateEscalate: false,
			jev: { weighted: 0.9, confidence: 0.9, scores: {} },
			escalations: 0,
			thresholds: {
				sotaMinScore: 0.6,
				sotaMinConfidence: 0.5,
				maxEscalationsPerStage: 1,
			},
		});
		expect(["default", "sota"]).toContain(decision.role);
	});
});

const ESCALATION_DOCS = [
	"skills/01-brainstorm/SKILL.md",
	"skills/02-plan/SKILL.md",
	"skills/04-review/SKILL.md",
	"skills/05-learn/SKILL.md",
	"skills/04-5-debug/SKILL.md",
	"skills/06-docsync/SKILL.md",
	"skills/references/pipeline-config.md",
	"skills/02-plan/references/ceo-review-mode.md",
];

describe("manual stage-gate escalation contract", () => {
	test("every escalate branch stops the loop and points at /ped-reload + models.sota", () => {
		for (const rel of ESCALATION_DOCS) {
			const text = read(rel);
			expect({ rel, reload: text.includes("/ped-reload") }).toEqual({
				rel,
				reload: true,
			});
			expect({ rel, sota: text.includes("models.sota") }).toEqual({
				rel,
				sota: true,
			});
			expect({
				rel,
				stops: /stop the (current )?stage loop/i.test(text),
			}).toEqual({ rel, stops: true });
		}
	});

	test("no active doc promises automatic escalated execution", () => {
		for (const rel of ESCALATION_DOCS) {
			expect({ rel, stale: read(rel).includes("proceed to escalated execution") }).toEqual(
				{ rel, stale: false },
			);
		}
	});

	test("shared pipeline instructions separate proactive Jev cost from deterministic escalation", () => {
		const shared = read("skills/references/pipeline-config.md");
		expect(shared).toContain("maxEscalationsPerStage");
		expect(shared).toContain("never suppressed");
		expect(shared).toContain("models.sota");
	});
});
