import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFakeJevRuntime } from "../extensions/ce-core/jev/runtime";
import { validateRequest } from "../extensions/ce-core/jev/validate";
import type {
	JevProcessOutput,
	JevRequest,
	JevResult,
	JevRuntime,
} from "../extensions/ce-core/jev/types";
import {
	DEFAULT_SOLUTION_RANKING,
	rankSolutions,
	type SolutionShadowRecord,
} from "../extensions/ce-core/utils/solution-ranking";

const tempRoots: string[] = [];

function makeRepo(): string {
	const root = mkdtempSync(path.join(tmpdir(), "pi-solution-ranking-"));
	tempRoots.push(root);
	return root;
}

function writeCard(repo: string, relPath: string, content: string): void {
	const full = path.join(repo, relPath);
	mkdirSync(path.dirname(full), { recursive: true });
	writeFileSync(full, content, "utf8");
}

function card(
	title: string,
	severity: string,
	tags: string[],
	body = "Body text about cache and widget invalidation.",
): string {
	return [
		"---",
		`title: ${title}`,
		"category: workflow",
		`severity: ${severity}`,
		`tags: [${tags.join(", ")}]`,
		"---",
		"",
		body,
	].join("\n");
}

function jevOutput(answers: Record<string, unknown>): JevProcessOutput {
	return {
		exitCode: 0,
		stdout: JSON.stringify({ answers, model: "fake-jev" }),
		stderr: "",
	};
}

function noul(noul: number, confidence?: number): Record<string, unknown> {
	return confidence === undefined
		? { type: "noul", noul }
		: { type: "noul", noul, confidence };
}

interface Spec {
	relevance?: number;
	applicability?: number;
	reuse?: number;
	duplicate?: number;
	overlap?: number;
	conflict?: number;
	confidence?: number;
}

/** Answers every requested question from a per-candidate-patch spec table. */
function assessmentHandler(byPath: Record<string, Spec>) {
	return (request: JevRequest): JevProcessOutput => {
		const candidate = (request.state as { candidate?: { path?: string } })
			?.candidate;
		const spec = byPath[candidate?.path ?? ""] ?? {};
		const answers: Record<string, unknown> = {};
		for (const id of Object.keys(request.questions)) {
			const value = (spec as Record<string, number | undefined>)[id] ?? 0;
			answers[id] = noul(value, spec.confidence);
		}
		return jevOutput(answers);
	};
}

const HIGH: Spec = { relevance: 0.9, applicability: 0.9, reuse: 0.7 };
const LOW: Spec = { relevance: 0.1, applicability: 0.1, reuse: 0.1 };

function candidatePathOf(request: JevRequest): string {
	return (
		request.state as { candidate: { path: string } }
	).candidate.path;
}

afterEach(() => {
	for (const root of tempRoots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe("solution-ranking — status mapping", () => {
	test("ok: qualifying candidates are returned and ordered by rank", async () => {
		const repo = makeRepo();
		writeCard(repo, "docs/solutions/workflow/a.md", card("A", "high", ["cache"]));
		writeCard(repo, "docs/solutions/workflow/b.md", card("B", "low", ["cache"]));
		const jev = createFakeJevRuntime({
			handler: assessmentHandler({
				"docs/solutions/workflow/a.md": HIGH,
				"docs/solutions/workflow/b.md": LOW,
			}),
		});

		const result = await rankSolutions({
			repoRoot: repo,
			query: "cache widget",
			jev,
			shadow: false,
		});

		expect(result.status).toBe("ok");
		expect(result.degraded).toBe(false);
		expect(result.enforced).toBe(true);
		expect(result.results.map((r) => r.path)).toEqual([
			"docs/solutions/workflow/a.md",
		]);
		expect(result.results[0].source).toBe("jev");
		expect(result.results[0].rank).toBeCloseTo(0.81, 10);
	});

	test("none: successful Jev answers below threshold yield 0 results", async () => {
		const repo = makeRepo();
		writeCard(repo, "docs/solutions/workflow/a.md", card("A", "high", ["cache"]));
		const jev = createFakeJevRuntime({ handler: assessmentHandler({}) });

		const result = await rankSolutions({ repoRoot: repo, query: "cache", jev });

		expect(result.status).toBe("none");
		expect(result.results).toEqual([]);
		expect(result.degraded).toBe(false);
	});

	test("degraded: every candidate failing falls back to top prior, ignoring thresholds", async () => {
		const repo = makeRepo();
		writeCard(repo, "docs/solutions/workflow/high.md", card("High", "critical", ["cache"], "cache widget"));
		writeCard(repo, "docs/solutions/workflow/low.md", card("Low", "low", ["cache"], "cache"));
		const jev = createFakeJevRuntime({
			handler: () => new Error("jev exploded"),
		});

		const result = await rankSolutions({
			repoRoot: repo,
			query: "cache widget",
			jev,
			limit: 1,
		});

		expect(result.status).toBe("degraded");
		expect(result.degraded).toBe(true);
		expect(result.results).toHaveLength(1);
		expect(result.results[0].path).toBe("docs/solutions/workflow/high.md");
		expect(result.results[0].source).toBe("prior");
	});

	test("partial drop: one candidate failing still yields ok for the rest", async () => {
		const repo = makeRepo();
		writeCard(repo, "docs/solutions/workflow/a.md", card("A", "high", ["cache"]));
		writeCard(repo, "docs/solutions/workflow/b.md", card("B", "low", ["cache"]));
		const jev = createFakeJevRuntime({
			handler: assessmentHandler({ "docs/solutions/workflow/a.md": HIGH }),
		});
		// b.md has no spec -> all zeros, still a valid answer, so it must not mention
		const result = await rankSolutions({ repoRoot: repo, query: "cache", jev });

		expect(result.status).toBe("ok");
		expect(result.results.map((r) => r.path)).toEqual([
			"docs/solutions/workflow/a.md",
		]);
	});

	test("empty docs/solutions returns none with no decide calls", async () => {
		const repo = makeRepo();
		const jev = createFakeJevRuntime({ handler: assessmentHandler({}) });

		const result = await rankSolutions({ repoRoot: repo, query: "cache", jev });

		expect(result.status).toBe("none");
		expect(result.results).toEqual([]);
		expect(jev.calls).toHaveLength(0);
	});

	test("shadow default returns enforced false", async () => {
		const repo = makeRepo();
		writeCard(repo, "docs/solutions/workflow/a.md", card("A", "high", ["cache"]));
		const jev = createFakeJevRuntime({
			handler: assessmentHandler({ "docs/solutions/workflow/a.md": HIGH }),
		});

		const result = await rankSolutions({ repoRoot: repo, query: "cache", jev });

		expect(result.enforced).toBe(false);
	});
});

describe("solution-ranking — answer handling", () => {
	test("missing confidence is treated as 1.0", async () => {
		const repo = makeRepo();
		writeCard(repo, "docs/solutions/workflow/a.md", card("A", "high", ["cache"]));
		const jev = createFakeJevRuntime({
			handler: assessmentHandler({ "docs/solutions/workflow/a.md": HIGH }),
		});

		const result = await rankSolutions({ repoRoot: repo, query: "cache", jev });

		expect(result.results[0].confidence).toBe(1);
	});

	test("explicit null or non-finite confidence drops the candidate", async () => {
		const repo = makeRepo();
		writeCard(repo, "docs/solutions/workflow/a.md", card("A", "high", ["cache"]));
		const nullConfidence: JevRuntime = {
			async decide(): Promise<JevResult> {
				return {
					answers: {
						relevance: { type: "noul", noul: 0.9, confidence: null as never },
						applicability: { type: "noul", noul: 0.9 },
						reuse: { type: "noul", noul: 0.5 },
					},
					model: "raw",
					warnings: [],
				};
			},
		};

		const result = await rankSolutions({
			repoRoot: repo,
			query: "cache",
			jev: nullConfidence,
		});

		expect(result.status).toBe("degraded");
	});

	test("non-finite noul values are dropped as invalid, never clamped", async () => {
		const repo = makeRepo();
		writeCard(repo, "docs/solutions/workflow/a.md", card("A", "high", ["cache"]));
		const nanRuntime: JevRuntime = {
			async decide(): Promise<JevResult> {
				return {
					answers: {
						relevance: { type: "noul", noul: Number.NaN },
						applicability: { type: "noul", noul: 0.9 },
						reuse: { type: "noul", noul: 0.5 },
					},
					model: "raw",
					warnings: [],
				};
			},
		};

		const result = await rankSolutions({
			repoRoot: repo,
			query: "cache",
			jev: nanRuntime,
		});

		expect(result.status).toBe("degraded");
	});

	test("a per-candidate timeout drops only that candidate", async () => {
		const repo = makeRepo();
		writeCard(repo, "docs/solutions/workflow/a.md", card("A", "high", ["cache"]));
		writeCard(repo, "docs/solutions/workflow/b.md", card("B", "low", ["cache"]));
		const jev = createFakeJevRuntime({
			handler: (request) =>
				candidatePathOf(request) === "docs/solutions/workflow/b.md"
					? new Error("timeout")
					: {
							exitCode: 0,
							stdout: JSON.stringify({
								answers: {
									relevance: noul(0.9),
									applicability: noul(0.9),
									reuse: noul(0.5),
								},
								model: "fake-jev",
							}),
							stderr: "",
						},
		});

		const result = await rankSolutions({ repoRoot: repo, query: "cache", jev });

		expect(result.status).toBe("ok");
		expect(result.results.map((r) => r.path)).toEqual([
			"docs/solutions/workflow/a.md",
		]);
	});
});

describe("solution-ranking — Jev limits and safety", () => {
	test("never exceeds the configured concurrency", async () => {
		const repo = makeRepo();
		for (let i = 0; i < 6; i++) {
			writeCard(repo, `docs/solutions/workflow/c${i}.md`, card(`C${i}`, "high", ["cache"]));
		}
		const fake = createFakeJevRuntime({ handler: assessmentHandler({}) });
		let inFlight = 0;
		let maxInFlight = 0;
		const counting: JevRuntime = {
			async decide(request, options) {
				inFlight++;
				maxInFlight = Math.max(maxInFlight, inFlight);
				await new Promise((resolve) => setTimeout(resolve, 3));
				try {
					return await fake.decide(request, options);
				} finally {
					inFlight--;
				}
			},
		};

		await rankSolutions({
			repoRoot: repo,
			query: "cache",
			jev: counting,
			thresholds: { concurrency: 2 },
		});

		expect(maxInFlight).toBeLessThanOrEqual(2);
		expect(maxInFlight).toBeGreaterThan(0);
	});

	test("every generated request passes the real validateRequest", async () => {
		const repo = makeRepo();
		writeCard(repo, "docs/solutions/workflow/a.md", card("A", "high", ["cache"]));
		const jev = createFakeJevRuntime({ handler: assessmentHandler({}) });

		await rankSolutions({ repoRoot: repo, query: "cache", jev });

		expect(jev.requests.length).toBeGreaterThan(0);
		for (const request of jev.requests) {
			expect(() => validateRequest(request)).not.toThrow();
		}
	});

	test("oversized query/body excerpts are byte-truncated with a marker", async () => {
		const repo = makeRepo();
		const hugeQuery = "cache ".repeat(3000);
		const hugeBody = "é".repeat(30000);
		writeCard(repo, "docs/solutions/workflow/a.md", card("A", "high", ["cache"], hugeBody));
		const jev = createFakeJevRuntime({ handler: assessmentHandler({}) });

		await rankSolutions({ repoRoot: repo, query: hugeQuery, jev });

		const request = jev.requests[0];
		expect(Buffer.byteLength(JSON.stringify(request), "utf8")).toBeLessThan(65_536);
		const excerpt = (request.state as { candidate: { excerpt: string } }).candidate
			.excerpt;
		expect(Buffer.byteLength(excerpt, "utf8")).toBeLessThanOrEqual(4096 + 64);
		expect(excerpt).toContain("truncated");
		expect(() => validateRequest(request)).not.toThrow();
	});

	test("survivor content is capped and marked; content only on returned results", async () => {
		const repo = makeRepo();
		writeCard(
			repo,
			"docs/solutions/workflow/a.md",
			card("A", "high", ["cache"], "widget ".repeat(5000)),
		);
		writeCard(repo, "docs/solutions/workflow/b.md", card("B", "low", ["cache"]));
		const jev = createFakeJevRuntime({
			handler: assessmentHandler({ "docs/solutions/workflow/a.md": HIGH }),
		});

		const result = await rankSolutions({
			repoRoot: repo,
			query: "cache",
			jev,
			limit: 1,
		});

		expect(result.results).toHaveLength(1);
		expect(Buffer.byteLength(result.results[0].content, "utf8")).toBeLessThanOrEqual(
			8192 + 64,
		);
		expect(result.results[0].content).toContain("truncated");
	});
});

describe("solution-ranking — overlap mode", () => {
	test("uses the overlap question set and surfaces conflict separately", async () => {
		const repo = makeRepo();
		writeCard(repo, "docs/solutions/workflow/a.md", card("A", "high", ["cache"]));
		const records: SolutionShadowRecord[] = [];
		const jev = createFakeJevRuntime({
			handler: assessmentHandler({
				"docs/solutions/workflow/a.md": {
					duplicate: 0.9,
					overlap: 0.8,
					conflict: 0.7,
				},
			}),
		});

		const result = await rankSolutions({
			repoRoot: repo,
			query: "new solution about cache",
			jev,
			mode: "overlap",
			telemetry: (record: SolutionShadowRecord) => records.push(record),
		});

		expect(result.status).toBe("ok");
		const questionIds = Object.keys(jev.requests[0].questions);
		expect(questionIds.sort()).toEqual(["conflict", "duplicate", "overlap"]);
		expect(records[0].conflicts).toContain("docs/solutions/workflow/a.md");
	});

	test("duplicate x overlap drives rank while conflict stays out of the score", async () => {
		const repo = makeRepo();
		writeCard(repo, "docs/solutions/workflow/a.md", card("A", "high", ["cache"]));
		const jev = createFakeJevRuntime({
			handler: assessmentHandler({
				"docs/solutions/workflow/a.md": {
					duplicate: 0.5,
					overlap: 0.5,
					conflict: 1,
				},
			}),
		});

		const result = await rankSolutions({
			repoRoot: repo,
			query: "cache",
			jev,
			mode: "overlap",
		});

		// rank = 0.25 -> below minRank 0.6, regardless of conflict=1
		expect(result.status).toBe("none");
	});
});

describe("solution-ranking — telemetry", () => {
	test("emits one record per run with prior/rank order and drops", async () => {
		const repo = makeRepo();
		writeCard(repo, "docs/solutions/workflow/a.md", card("A", "high", ["cache"]));
		writeCard(repo, "docs/solutions/workflow/b.md", card("B", "low", ["cache"]));
		const records: SolutionShadowRecord[] = [];
		const jev = createFakeJevRuntime({
			handler: (request) =>
				candidatePathOf(request) === "docs/solutions/workflow/b.md"
					? new Error("drop b")
					: jevOutput({
							relevance: noul(0.9),
							applicability: noul(0.9),
							reuse: noul(0.5),
						}),
		});

		await rankSolutions({
			repoRoot: repo,
			query: "cache",
			jev,
			telemetry: (record: SolutionShadowRecord) => records.push(record),
		});

		expect(records).toHaveLength(1);
		expect(records[0].priorOrder).toEqual([
			"docs/solutions/workflow/a.md",
			"docs/solutions/workflow/b.md",
		]);
		expect(records[0].dropped).toContain("docs/solutions/workflow/b.md");
		expect(records[0].queryHash).toHaveLength(16);
	});
});

describe("solution-ranking — defaults", () => {
	test("DEFAULT_SOLUTION_RANKING freezes the documented knobs", () => {
		expect(DEFAULT_SOLUTION_RANKING).toEqual({
			minRank: 0.6,
			minConfidence: 0.5,
			concurrency: 4,
			candidates: 15,
			limit: 3,
			shadow: true,
		});
	});

	test("path escaping docs/solutions is never scored", async () => {
		const repo = makeRepo();
		writeCard(repo, "docs/solutions/workflow/safe.md", card("Safe", "high", ["cache"]));
		const outside = path.join(repo, "outside.md");
		writeFileSync(outside, card("Evil", "critical", ["cache"]), "utf8");
		symlinkSync(outside, path.join(repo, "docs", "solutions", "workflow", "evil.md"));
		const jev = createFakeJevRuntime({ handler: assessmentHandler({}) });

		await rankSolutions({ repoRoot: repo, query: "cache", jev });

		const paths = jev.requests.map(candidatePathOf);
		expect(paths).not.toContain("docs/solutions/workflow/evil.md");
	});
});
