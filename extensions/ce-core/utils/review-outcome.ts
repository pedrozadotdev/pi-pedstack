export type ReviewOutcomeStatus = "clean" | "findings";

export type ReviewOutcome =
	| {
			valid: true;
			status: ReviewOutcomeStatus;
			findings: number;
	  }
	| {
			valid: false;
			reason: string;
	  };

function stripHtmlComments(markdown: string): string {
	return markdown.replace(/<!--[\s\S]*?-->/g, "");
}

function reviewOutcomeSection(markdown: string): string | null {
	const lines = markdown.split(/\r?\n/);
	const start = lines.findIndex((line) =>
		/^##\s+Review Outcome\s*$/i.test(line.trim()),
	);
	if (start < 0) return null;
	let end = lines.length;
	for (let i = start + 1; i < lines.length; i += 1) {
		if (/^##\s+/.test(lines[i].trim())) {
			end = i;
			break;
		}
	}
	return lines.slice(start + 1, end).join("\n");
}

export function countStructuredFindings(markdown: string): number {
	const body = stripHtmlComments(markdown);
	return (body.match(/^\s*-\s+\*\*Finding\*\*\s*:/gim) ?? []).length;
}

export function parseReviewOutcome(markdown: string): ReviewOutcome {
	const body = stripHtmlComments(markdown);
	const section = reviewOutcomeSection(body);
	if (!section) {
		return {
			valid: false,
			reason: 'missing "## Review Outcome" section',
		};
	}

	const statusMatch = section.match(
		/^\s*-?\s*Status:\s*(clean|findings)\s*$/im,
	);
	const countMatch = section.match(/^\s*-?\s*Findings:\s*(\d+)\s*$/im);
	if (!statusMatch || !countMatch) {
		return {
			valid: false,
			reason:
				'review outcome must contain "Status: clean|findings" and "Findings: <integer>"',
		};
	}

	const status = statusMatch[1].toLowerCase() as ReviewOutcomeStatus;
	const findings = Number.parseInt(countMatch[1], 10);
	const structured = countStructuredFindings(body);

	if (findings !== structured) {
		return {
			valid: false,
			reason:
				`declared Findings count ${findings} does not match ${structured} structured finding(s)`,
		};
	}
	if (status === "clean" && findings !== 0) {
		return {
			valid: false,
			reason: 'Status "clean" requires Findings: 0',
		};
	}
	if (status === "findings" && findings === 0) {
		return {
			valid: false,
			reason: 'Status "findings" requires at least one structured finding',
		};
	}

	return { valid: true, status, findings };
}

export function requiredNextStageForReview(
	outcome: Extract<ReviewOutcome, { valid: true }>,
): "03-work" | "05-learn" {
	return outcome.status === "findings" ? "03-work" : "05-learn";
}
