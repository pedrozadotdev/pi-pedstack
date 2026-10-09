import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { matchesReviewOutcomes } from "../docs/benchmarks/issue-62/verify-live-run";

describe("issue #62 review outcome validation", () => {
	test("requires the ordered sequence from accepted review handoffs", () => {
		const rows = [
			{ event: "review_outcome", stage: "04-review", reviewFindings: 2 },
			{ event: "review_outcome", stage: "04-review", reviewFindings: 0 },
		];
		expect(matchesReviewOutcomes(rows, ["findings", "clean"])).toBe(true);
		expect(matchesReviewOutcomes(rows, ["clean", "findings"])).toBe(false);
	});

	test("rejects missing telemetry even if an overwritten report once contained findings", () => {
		const finalReport = "## Review Outcome\nStatus: clean\nFindings: 0";
		expect(finalReport).toContain("Status: clean");
		expect(matchesReviewOutcomes([{ event: "review_outcome", stage: "04-review", reviewFindings: 0 }], ["findings", "clean"])).toBe(false);
	});

	test("ignores review-like text in unrelated Markdown because it consumes no Markdown", () => {
		const unrelatedNotes = "A stale note says Status: findings and Findings: 4";
		expect(unrelatedNotes).toContain("Status: findings");
		expect(matchesReviewOutcomes([], ["findings"])).toBe(false);
	});

	test("recreates every pinned fixture commit identically", async () => {
		const manifest = JSON.parse(await readFile("docs/benchmarks/issue-62/live-scenarios.json", "utf8")) as {
			scenarios: Array<{ id: string; fixture: string; expectedFixtureCommitSha: string }>;
		};
		for (const scenario of manifest.scenarios) {
			const root = await mkdtemp(path.join(tmpdir(), "pedstack-fixture-sha-"));
			try {
				const workspace = path.join(root, "workspace");
				await cp(path.join("docs/benchmarks/issue-62", scenario.fixture), workspace, { recursive: true });
				execFileSync("git", ["-C", workspace, "init", "-q", "-b", "main"]);
				execFileSync("git", ["-C", workspace, "config", "user.name", "Pedstack Benchmark"]);
				execFileSync("git", ["-C", workspace, "config", "user.email", "benchmark@localhost"]);
				execFileSync("git", ["-c", "core.excludesFile=/dev/null", "-C", workspace, "add", "--all"]);
				execFileSync("git", ["-C", workspace, "commit", "-q", "-m", "test: initialize benchmark fixture"], {
					env: { ...process.env, GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z" },
				});
				const actual = execFileSync("git", ["-C", workspace, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
				expect({ scenario: scenario.id, actual }).toEqual({ scenario: scenario.id, actual: scenario.expectedFixtureCommitSha });
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		}
	});
});
