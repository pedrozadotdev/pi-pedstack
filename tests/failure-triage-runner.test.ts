import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createFakeJevRuntime } from "../extensions/ce-core/jev/runtime";
import type { JevFakeRuntime } from "../extensions/ce-core/jev/types";
import {
	runFailureTriage,
	readRecentChange,
	getLowClarityStreak,
	resetLowClarityStreak,
	type FailureTriageDeps,
	type FailureTriageInput,
} from "../extensions/ce-core/tools/failure-triage-runner";
import { readLatestTriage } from "../extensions/ce-core/tools/triage-store";

const CATEGORIES = [
	"implementation_bug",
	"test_fixture",
	"environment_toolchain",
	"dependency_config",
	"flaky_timing",
	"external_service",
	"unknown",
];

function makeTriageStdout(overrides: {
	category?: string;
	noul?: number;
	score?: number;
	confidence?: number;
} = {}): string {
	const category = overrides.category ?? "test_fixture";
	const probabilities: Record<string, number> = {};
	for (const label of CATEGORIES) {
		probabilities[label] = label === category ? 0.7 : 0.05;
	}
	return JSON.stringify({
		model: "typesafe/jev",
		answers: {
			category: {
				type: "choice",
				choice: category,
				probabilities,
				confidence: overrides.confidence ?? 0.72,
			},
			related_to_recent_change: { type: "noul", noul: overrides.noul ?? 1 },
			root_cause_clarity: {
				type: "score",
				score: overrides.score ?? 2,
				legend: { "0": "", "1": "", "2": "", "3": "", "4": "", "5": "" },
				probabilities: {
					"0": 0.1,
					"1": 0.1,
					"2": 0.6,
					"3": 0.1,
					"4": 0.05,
					"5": 0.05,
				},
				confidence: 0.6,
			},
		},
	});
}

function output(stdout: string) {
	return { exitCode: 0, stdout, stderr: "" };
}

function baseInput(overrides: Partial<FailureTriageInput> = {}): FailureTriageInput {
	return {
		toolName: "bash",
		isError: true,
		command: "bun test",
		stage: "03-work",
		content: "FAIL test/foo.test.ts\nexpected 1 received 2",
		...overrides,
	};
}

describe("failure-triage-runner: recent change", () => {
	test("maps a non-empty diff to files + basename summary", async () => {
		const exec = async () => "src/a.ts\nsrc/b.ts\n";
		const change = await readRecentChange("/tmp", exec);
		expect(change?.files).toEqual(["src/a.ts", "src/b.ts"]);
		expect(change?.summary).toBe("a.ts, b.ts");
	});

	test("returns null on an empty diff", async () => {
		const exec = async () => "";
		expect(await readRecentChange("/tmp", exec)).toBeNull();
	});

	test("returns null when git is unavailable", async () => {
		const exec = async () => {
			throw new Error("git: command not found");
		};
		expect(await readRecentChange("/tmp", exec)).toBeNull();
	});
});

describe("failure-triage-runner: execution", () => {
	let repoRoot: string;

	beforeEach(async () => {
		repoRoot = await mkdtemp(path.join(os.tmpdir(), "triage-runner-"));
		resetLowClarityStreak();
	});

	function makeDeps(
		runtime: JevFakeRuntime,
		overrides: Partial<FailureTriageDeps> = {},
	): FailureTriageDeps {
		return {
			runtime,
			repoRoot,
			cwd: repoRoot,
			exec: async () => "",
			now: () => 0,
			...overrides,
		};
	}

	test("annotates with a Jev triage block on the happy path", async () => {
		const runtime = createFakeJevRuntime({
			handler: () => output(makeTriageStdout({ score: 4 })),
		});

		const result = await runFailureTriage(baseInput(), makeDeps(runtime));

		expect(result).not.toBeNull();
		expect(result).toContain("TRIAGE");
		expect(result).toContain("source=jev");
		expect(result?.startsWith(baseInput().content)).toBe(true);
		expect(runtime.calls[0]?.timeoutMs).toBe(2500);
		const state = runtime.requests[0]?.state as {
			stage: string;
			excerpt: string;
		};
		expect(state.stage).toBe("03-work");
		expect(state.excerpt).toContain("FAIL test/foo.test.ts");
	});

	test("falls back to the heuristic when Jev errors", async () => {
		const runtime = createFakeJevRuntime({
			handler: () => new Error("timeout"),
		});

		const result = await runFailureTriage(baseInput(), makeDeps(runtime));

		expect(result).not.toBeNull();
		expect(result).toContain("source=heuristic");
		expect(result?.startsWith(baseInput().content)).toBe(true);
	});

	test("returns null when Jev errors and the heuristic abstains", async () => {
		const runtime = createFakeJevRuntime({
			handler: () => new Error("timeout"),
		});

		const result = await runFailureTriage(
			baseInput({ content: "something opaque happened" }),
			makeDeps(runtime),
		);

		expect(result).toBeNull();
	});

	test("treats an invalid category answer as a Jev failure", async () => {
		const runtime = createFakeJevRuntime({
			handler: () => output(makeTriageStdout({ category: "not_a_category" })),
		});

		const result = await runFailureTriage(baseInput(), makeDeps(runtime));

		expect(result).toContain("source=heuristic");
	});

	test("does not run in an out-of-scope stage", async () => {
		const runtime = createFakeJevRuntime({
			handler: () => output(makeTriageStdout()),
		});

		const result = await runFailureTriage(
			baseInput({ stage: "02-plan" }),
			makeDeps(runtime),
		);

		expect(result).toBeNull();
		expect(runtime.calls.length).toBe(0);
	});

	test("resets the streak on a successful verification command", async () => {
		const runtime = createFakeJevRuntime({
			handler: () => output(makeTriageStdout({ score: 2 })),
		});
		await runFailureTriage(baseInput(), makeDeps(runtime));
		await runFailureTriage(baseInput(), makeDeps(runtime));
		expect(getLowClarityStreak()).toBe(2);

		const result = await runFailureTriage(
			baseInput({ isError: false }),
			makeDeps(runtime),
		);

		expect(result).toBeNull();
		expect(getLowClarityStreak()).toBe(0);
	});

	test("annotates even when persistence fails and reports the persist error", async () => {
		const runtime = createFakeJevRuntime({
			handler: () => output(makeTriageStdout()),
		});
		const persistErrors: unknown[] = [];

		const result = await runFailureTriage(
			baseInput(),
			makeDeps(runtime, {
				repoRoot: "/proc/does-not-exist",
				onPersistError: (error) => persistErrors.push(error),
			}),
		);

		expect(result).toContain("TRIAGE");
		expect(result?.startsWith(baseInput().content)).toBe(true);
		expect(persistErrors.length).toBe(1);
	});
});

describe("failure-triage-runner: low-clarity streak", () => {
	let repoRoot: string;

	beforeEach(async () => {
		repoRoot = await mkdtemp(path.join(os.tmpdir(), "triage-streak-"));
		resetLowClarityStreak();
	});

	function makeDeps(runtime: JevFakeRuntime): FailureTriageDeps {
		return {
			runtime,
			repoRoot,
			cwd: repoRoot,
			exec: async () => "",
			now: () => 0,
		};
	}

	test("increments on low clarity and signals escalation at 3", async () => {
		const runtime = createFakeJevRuntime({
			handler: () => output(makeTriageStdout({ score: 2 })),
		});

		await runFailureTriage(baseInput(), makeDeps(runtime));
		await runFailureTriage(baseInput(), makeDeps(runtime));
		await runFailureTriage(baseInput(), makeDeps(runtime));

		expect(getLowClarityStreak()).toBe(3);
		const latest = await readLatestTriage(repoRoot);
		expect(latest?.escalationSignal).toBe(true);
		expect(latest?.lowClarityStreak).toBe(3);
	});

	test("resets the streak when clarity is >= 3", async () => {
		const low = createFakeJevRuntime({
			handler: () => output(makeTriageStdout({ score: 2 })),
		});
		const high = createFakeJevRuntime({
			handler: () => output(makeTriageStdout({ score: 4 })),
		});

		await runFailureTriage(baseInput(), makeDeps(low));
		expect(getLowClarityStreak()).toBe(1);
		await runFailureTriage(baseInput(), makeDeps(high));
		expect(getLowClarityStreak()).toBe(0);
	});

	test("does not count heuristic fallbacks toward the escalation signal", async () => {
		const runtime = createFakeJevRuntime({
			handler: () => new Error("timeout"),
		});

		await runFailureTriage(baseInput(), makeDeps(runtime));
		await runFailureTriage(baseInput(), makeDeps(runtime));
		await runFailureTriage(baseInput(), makeDeps(runtime));

		expect(getLowClarityStreak()).toBe(0);
		const latest = await readLatestTriage(repoRoot);
		expect(latest?.source).toBe("heuristic");
		expect(latest?.escalationSignal).toBe(false);
	});

	test("records relatedToRecentChange as unknown without a diff", async () => {
		const runtime = createFakeJevRuntime({
			handler: () => output(makeTriageStdout({ noul: 0 })),
		});

		await runFailureTriage(baseInput(), makeDeps(runtime));

		const latest = await readLatestTriage(repoRoot);
		expect(latest?.relatedToRecentChange).toBe("unknown");
	});
});
