import { describe, expect, test } from "bun:test";
import {
	countStructuredFindings,
	parseReviewOutcome,
	requiredNextStageForReview,
} from "../extensions/ce-core/utils/review-outcome";

describe("review outcome parser", () => {
	test("clean outcome requires zero structured findings", () => {
		const markdown = `
## Review Outcome
- Status: clean
- Findings: 0

## Merged Reviewer Findings

### High Severity
<!-- - **Finding**: template example only -->
`;
		const outcome = parseReviewOutcome(markdown);
		expect(outcome).toEqual({ valid: true, status: "clean", findings: 0 });
		if (outcome.valid) {
			expect(requiredNextStageForReview(outcome)).toBe("05-learn");
		}
	});

	test("findings outcome routes to work", () => {
		const markdown = `
## Review Outcome
- Status: findings
- Findings: 2

## Merged Reviewer Findings
- **Finding**: first issue
  - **Evidence**: a.ts:1
- **Finding**: second issue
  - **Evidence**: b.ts:2
`;
		const outcome = parseReviewOutcome(markdown);
		expect(outcome).toEqual({ valid: true, status: "findings", findings: 2 });
		if (outcome.valid) {
			expect(requiredNextStageForReview(outcome)).toBe("03-work");
		}
	});

	test("declared count must match actual structured finding entries", () => {
		const outcome = parseReviewOutcome(`
## Review Outcome
- Status: findings
- Findings: 2

- **Finding**: only one
`);
		expect(outcome.valid).toBe(false);
		if (!outcome.valid) {
			expect(outcome.reason).toContain("does not match");
		}
	});

	test("clean cannot hide structured findings", () => {
		const outcome = parseReviewOutcome(`
## Review Outcome
- Status: clean
- Findings: 1

- **Finding**: unresolved issue
`);
		expect(outcome.valid).toBe(false);
	});

	test("findings status requires a non-zero finding count", () => {
		const outcome = parseReviewOutcome(`
## Review Outcome
- Status: findings
- Findings: 0
`);
		expect(outcome.valid).toBe(false);
	});

	test("missing or malformed outcome is invalid", () => {
		expect(parseReviewOutcome("# Review Findings").valid).toBe(false);
		expect(
			parseReviewOutcome(`
## Review Outcome
- Status: maybe
- Findings: lots
`).valid,
		).toBe(false);
	});

	test("HTML-comment template examples are not counted", () => {
		const markdown = `
## Review Outcome
- Status: findings
- Findings: 1

<!--
- **Finding**: example
-->

- **Finding**: real issue
`;
		expect(countStructuredFindings(markdown)).toBe(1);
	});
});
