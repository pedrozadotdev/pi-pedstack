import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { hasAppliedSotaRole, matchesInitialFixtureCommit, matchesReviewOutcomes } from "../docs/benchmarks/issue-62/verify-live-run";

describe("issue #62 review outcome validation", () => {
	test("live runner loads only the pinned extension checkout and retains failed sessions", async () => {
		const runner = await readFile("docs/benchmarks/issue-62/run-live.sh", "utf8");
		expect(runner).toContain("pi --approve --no-extensions --extension");
		expect(runner).toContain("pi_exit_code=$?");
		expect(runner).toContain('touch "$output_dir/diagnostics.jsonl"');
		expect(runner).toContain('BENCH_PI_EXIT="$pi_exit_code"');
		const validator = await readFile("docs/benchmarks/issue-62/verify-live-run.ts", "utf8");
		expect(validator).toContain("piExit: metadata.piExitCode === 0");
	});

	test("requires successful SOTA activation rather than a routing recommendation", () => {
		const selected = { feature: "routing", event: "role_selected", stage: "02-plan", role: "sota", outcome: "success" };
		const failed = { feature: "routing", event: "role_apply_failed", stage: "02-plan", role: "sota", outcome: "failure" };
		const applied = { feature: "routing", event: "role_applied", stage: "02-plan", role: "sota", outcome: "success" };
		expect(hasAppliedSotaRole([selected])).toBe(false);
		expect(hasAppliedSotaRole([selected, failed])).toBe(false);
		expect(hasAppliedSotaRole([selected, applied])).toBe(true);
	});

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

	test("recognizes the fixture root after a workflow creates a later commit", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "pedstack-fixture-head-"));
		try {
			const workspace = path.join(root, "workspace");
			await cp("docs/benchmarks/issue-62/fixtures/debug-verify", workspace, { recursive: true });
			execFileSync("git", ["-C", workspace, "init", "-q", "-b", "main"]);
			execFileSync("git", ["-C", workspace, "config", "user.name", "Pedstack Benchmark"]);
			execFileSync("git", ["-C", workspace, "config", "user.email", "benchmark@localhost"]);
			execFileSync("git", ["-c", "core.excludesFile=/dev/null", "-C", workspace, "add", "--all"]);
			execFileSync("git", ["-C", workspace, "commit", "-q", "-m", "test: initialize benchmark fixture"], {
				env: { ...process.env, GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z" },
			});
			const initial = execFileSync("git", ["-C", workspace, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
			await Bun.write(path.join(workspace, "workflow-change.txt"), "record a later workflow commit\n");
			execFileSync("git", ["-C", workspace, "add", "workflow-change.txt"]);
			execFileSync("git", ["-C", workspace, "commit", "-q", "-m", "test: record workflow change"], {
				env: { ...process.env, GIT_AUTHOR_DATE: "2000-01-02T00:00:00Z", GIT_COMMITTER_DATE: "2000-01-02T00:00:00Z" },
			});
			const head = execFileSync("git", ["-C", workspace, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
			const roots = execFileSync("git", ["-C", workspace, "rev-list", "--max-parents=0", "HEAD"], { encoding: "utf8" }).trim().split(/\s+/);
			expect(head).not.toBe(initial);
			expect(matchesInitialFixtureCommit(roots, initial, "5b3e07f799d9408895529225fbf4283985381d75")).toBe(true);
			expect(matchesInitialFixtureCommit([initial, "another-root"], initial, initial)).toBe(false);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
