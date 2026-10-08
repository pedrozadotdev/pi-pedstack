// Model routing docs: shadow mode must be documented as record-only, and the
// enforced path must describe the manual `/ped-reload` → `models.sota` flow.
// These assertions stay phrase-level so prose edits do not break them.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");

function read(rel: string): string {
	return readFileSync(path.join(repoRoot, rel), "utf8");
}

/** Every doc that describes the stage-gate `escalate` branch. */
const ESCALATION_DOCS = [
	"AGENTS.md",
	"CONTEXT.md",
	"docs/ARCHITECTURE.md",
	"skills/01-brainstorm/SKILL.md",
	"skills/01-brainstorm/references/handoff.md",
	"skills/02-plan/SKILL.md",
	"skills/02-plan/references/ceo-review-mode.md",
	"skills/02-plan/references/handoff.md",
	"skills/04-5-debug/SKILL.md",
	"skills/references/pipeline-config.md",
];

/** A phrase that records-without-applying shadow semantics, tolerant of wording. */
const SHADOW_NOT_APPLIED = /record(?:ed|s)?[^.]{0,120}(?:not appl|does not switch)/i;

describe("model-routing docs — shadow vs enforced", () => {
	test("every escalation doc preserves /ped-reload as a fallback", () => {
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
				stops: text.includes("stage loop"),
			}).toEqual({ rel, stops: true });
		}
	});

	test("every escalation doc separates shadow mode from enforced application", () => {
		for (const rel of ESCALATION_DOCS) {
			const text = read(rel);
			expect({ rel, shadow: text.includes("shadow") }).toEqual({
				rel,
				shadow: true,
			});
			expect({ rel, recordOnly: SHADOW_NOT_APPLIED.test(text) }).toEqual({
				rel,
				recordOnly: true,
			});
		}
	});

	test("shared pipeline instructions name the enforcement condition", () => {
		const shared = read("skills/references/pipeline-config.md");
		expect(shared).toContain("routing.shadow: false");
		expect(shared).toContain("routing.shadow: true");
		expect(shared).toContain("maxEscalationsPerStage");
		expect(shared).toContain("never suppressed");
	});

	test("architecture reference identifies enforced routing and workflow-scoped reset", () => {
		const readme = read("docs/ARCHITECTURE.md");
		expect(readme.toLowerCase()).toContain("under enforced routing");
		expect(readme).toContain("workflow-scoped");
		expect(readme).toContain("/ped-fix-issues");
		expect(readme).toContain("/ped-reload");
	});

	test("restricted stage instructions do not direct SOTA escalation", () => {
		for (const rel of [
			"skills/03-work/references/handoff.md",
			"skills/04-review/SKILL.md",
			"skills/04-review/references/handoff.md",
			"skills/05-learn/SKILL.md",
			"skills/06-docsync/SKILL.md",
		]) {
			const text = read(rel);
			expect(text).not.toContain("automatically re-enters the same stage under `models.sota`");
		}
	});

	test("shared instructions enumerate escalation-eligible stages", () => {
		const shared = read("skills/references/pipeline-config.md");
		for (const stage of ["01-brainstorm", "02-plan", "04-5-debug", "03-work", "04-review", "05-learn", "06-docsync"])
			expect(shared).toContain(stage);
	});

	test("no escalation doc promises unconditional SOTA application", () => {
		for (const rel of ESCALATION_DOCS) {
			const text = read(rel);
			// The old unqualified wording: "the persisted escalation re-enters
			// this same stage under models.sota." must not survive anywhere.
			expect({
				rel,
				unqualified: /persisted escalation re-enters this same stage under `models\.sota`\./.test(
					text,
				),
			}).toEqual({ rel, unqualified: false });
		}
	});
});
