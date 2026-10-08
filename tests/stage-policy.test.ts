// Unit 1 — explicit stage-policy registry (mandate/forbidden) owned outside
// the command layer and reused by prose injection + drift prompts.
import { describe, expect, test } from "bun:test";
import {
	STAGE_DISCIPLINES as RELOCATED,
	getStageDiscipline,
} from "../extensions/ce-core/utils/stage-policy";
import {
	STAGE_DISCIPLINES as REEXPORTED,
	buildSystemPromptAppend,
} from "../extensions/ce-core/commands/prompt-inject";

describe("getStageDiscipline", () => {
	test("returns the known discipline for a valid stage", () => {
		const discipline = getStageDiscipline("02-plan");
		expect(discipline).not.toBeNull();
		expect(discipline?.forbidden).toContain("source code");
		expect(discipline?.mandate).toContain("implementation plan");
		expect(discipline?.nextStage).toBe("03-work");
	});

	test("04-review injects a conditional findings-to-work completion rule", () => {
		const discipline = getStageDiscipline("04-review");
		expect(discipline?.nextStage).toBe("05-learn");
		expect(discipline?.completionInstruction).toContain("03-work");
		expect(discipline?.completionInstruction).toContain("Status");
		expect(discipline?.completionInstruction).toContain("Findings: 0");

		const append = buildSystemPromptAppend("/skills/04-review/SKILL.md", []);
		expect(append).toContain("target **03-work**");
		expect(append).toContain("target **05-learn**");
		expect(append).not.toContain("targeting the next stage: **05-learn**");
	});

	test("returns null for an unknown or absent stage", () => {
		expect(getStageDiscipline("09-nope")).toBeNull();
		expect(getStageDiscipline(null)).toBeNull();
		expect(getStageDiscipline(undefined)).toBeNull();
	});
});

describe("prompt-inject compatibility", () => {
	test("re-exports the relocated registry", () => {
		expect(REEXPORTED).toBe(RELOCATED);
	});

	test("keeps the 02-plan system prompt text unchanged", () => {
		const append = buildSystemPromptAppend("/skills/02-plan/SKILL.md", []);
		expect(append).toContain("You are entering stage **02-plan**");
		expect(append).toContain(
			"**Your mandate:** Translate brainstorm output into a concrete, actionable implementation plan",
		);
		expect(append).toContain(
			"**Forbidden:** Do NOT write or edit any source code",
		);
		expect(append).toContain("targeting the next stage: **03-work**");
	});
});
