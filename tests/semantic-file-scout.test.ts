import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { JevRuntimeError } from "../extensions/ce-core/jev/errors";
import { createFakeJevRuntime } from "../extensions/ce-core/jev/runtime";
import type {
	JevProcessOutput,
	JevRequest,
	JevResult,
	JevRuntime,
} from "../extensions/ce-core/jev/types";
import { validateRequest } from "../extensions/ce-core/jev/validate";
import { scoutSemanticFiles } from "../extensions/ce-core/utils/semantic-file-ask";

const tempRoots: string[] = [];

function makeRepo(): string {
	const root = mkdtempSync(path.join(tmpdir(), "pi-semantic-scout-"));
	tempRoots.push(root);
	return root;
}

function write(repo: string, rel: string, content: string): void {
	const full = path.join(repo, rel);
	mkdirSync(path.dirname(full), { recursive: true });
	writeFileSync(full, content);
}

function output(answers: Record<string, unknown>): JevProcessOutput {
	return { exitCode: 0, stdout: JSON.stringify({ answers, model: "fake-jev" }), stderr: "" };
}

/** Answers any question with a valid response; a `choice` question returns `choicePath`. */
function autoHandler(choicePath?: string) {
	return (request: JevRequest): JevProcessOutput => {
		const answers: Record<string, unknown> = {};
		for (const [id, question] of Object.entries(request.questions)) {
			if (question.type === "noul") {
				answers[id] = { type: "noul", noul: 0.8, confidence: 0.9 };
			} else if (question.type === "choice") {
				const keys = Object.keys(question.criteria);
				const chosen = choicePath ?? keys[0];
				const probabilities = Object.fromEntries(
					keys.map((key) => [key, key === chosen ? 0.9 : 0.1 / Math.max(1, keys.length - 1)]),
				);
				answers[id] = { type: "choice", choice: chosen, probabilities, confidence: 0.9 };
			} else {
				const keys = question.criteria.map((_, index) => String(index));
				answers[id] = {
					type: "score",
					score: 0,
					legend: Object.fromEntries(keys.map((key) => [key, `level ${key}`])),
					probabilities: Object.fromEntries(keys.map((key, i) => [key, i === 0 ? 0.99 : 0.01])),
					confidence: 0.9,
				};
			}
		}
		return output(answers);
	};
}

function noulResult(): JevResult {
	return { answers: { q: { type: "noul", noul: 0.8, confidence: 0.9 } }, model: "stub", warnings: [] };
}

function choiceResult(pathKey: string, keys: string[]): JevResult {
	return {
		answers: {
			select: {
				type: "choice",
				choice: pathKey,
				probabilities: Object.fromEntries(keys.map((key) => [key, key === pathKey ? 0.9 : 0.1 / Math.max(1, keys.length - 1)])),
				confidence: 0.9,
			},
		},
		model: "stub",
		warnings: [],
	};
}

afterEach(() => {
	for (const root of tempRoots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe("scoutSemanticFiles — expansion, dedupe, ordering", () => {
	test("expands dir + glob + file targets, dedupes and orders deterministically", async () => {
		const repo = makeRepo();
		write(repo, "src/a.ts", "export const a = 1;\n");
		write(repo, "src/b.ts", "export const b = 2;\n");
		write(repo, "src/sub/c.ts", "export const c = 3;\n");
		write(repo, "other/d.ts", "export const d = 4;\n");
		const fake = createFakeJevRuntime({ handler: autoHandler() });

		const result = await scoutSemanticFiles({
			repoRoot: repo,
			targets: ["src", "src/*.ts", "other/d.ts", "src/a.ts"],
			question: "What does this file export?",
			select: false,
			jev: fake,
		});

		expect(result.status).toBe("ok");
		expect(result.results.map((entry) => entry.path)).toEqual([
			"other/d.ts",
			"src/a.ts",
			"src/b.ts",
			"src/sub/c.ts",
		]);
		expect(result.counts).toEqual({
			totalFound: 4,
			eligible: 4,
			returned: 4,
			omitted: 0,
			answered: 4,
			failed: 0,
		});
	});

	test("prunes lock/minified/generated/.map files out of eligible", async () => {
		const repo = makeRepo();
		write(repo, "src/a.ts", "export const a = 1;\n");
		write(repo, "src/bundle.min.js", "!function(){}\n");
		write(repo, "src/thing.pb.ts", "export const t = 1;\n");
		write(repo, "src/a.ts.map", "{}\n");
		write(repo, "bun.lock", "{}\n");
		const fake = createFakeJevRuntime({ handler: autoHandler() });

		const result = await scoutSemanticFiles({
			repoRoot: repo,
			targets: ["src", "bun.lock"],
			question: "q",
			select: false,
			jev: fake,
		});

		expect(result.counts.totalFound).toBe(5);
		expect(result.counts.eligible).toBe(1);
		expect(result.results.map((entry) => entry.path)).toEqual(["src/a.ts"]);
	});

	test("caps eligible at limit and reports omitted", async () => {
		const repo = makeRepo();
		for (let i = 0; i < 5; i++) write(repo, `f${i}.ts`, `export const x = ${i};\n`);
		const fake = createFakeJevRuntime({ handler: autoHandler() });

		const result = await scoutSemanticFiles({
			repoRoot: repo,
			targets: ["."],
			question: "q",
			select: false,
			limit: 2,
			jev: fake,
		});

		expect(result.counts.eligible).toBe(5);
		expect(result.counts.returned).toBe(2);
		expect(result.counts.omitted).toBe(3);
		expect(result.results).toHaveLength(2);
	});

	test("clamps limit above 32", async () => {
		const repo = makeRepo();
		for (let i = 0; i < 35; i++) write(repo, `f${String(i).padStart(2, "0")}.ts`, "x\n");
		const fake = createFakeJevRuntime({ handler: autoHandler() });

		const result = await scoutSemanticFiles({
			repoRoot: repo,
			targets: ["."],
			question: "q",
			select: false,
			limit: 100,
			jev: fake,
		});

		expect(result.counts.returned).toBe(32);
		expect(result.counts.omitted).toBe(3);
	});

	test("an empty target set is empty with zero spawns", async () => {
		const repo = makeRepo();
		const fake = createFakeJevRuntime({ handler: autoHandler() });

		const result = await scoutSemanticFiles({
			repoRoot: repo,
			targets: [],
			question: "q",
			jev: fake,
		});

		expect(result.status).toBe("empty");
		expect(result.results).toEqual([]);
		expect(result.message ?? "").toMatch(/no eligible files/i);
		expect(fake.calls.length).toBe(0);
	});
});

describe("scoutSemanticFiles — target validation", () => {
	test("rejects unsupported glob syntax and escapes as invalid_target", async () => {
		const repo = makeRepo();
		write(repo, "src/a.ts", "x\n");
		const fake = createFakeJevRuntime({ handler: autoHandler() });

		for (const targets of [
			["src/**/*.?s"],
			["src/{a,b}.ts"],
			["../*"],
			["/etc/hosts"],
		]) {
			const result = await scoutSemanticFiles({
				repoRoot: repo,
				targets,
				question: "q",
				jev: fake,
			});
			expect(result.status).toBe("error");
			expect(result.reason).toBe("invalid_target");
		}
		expect(fake.calls.length).toBe(0);
	});

	test("rejects an empty question as invalid_question", async () => {
		const repo = makeRepo();
		const fake = createFakeJevRuntime({ handler: autoHandler() });

		const result = await scoutSemanticFiles({
			repoRoot: repo,
			targets: ["."],
			question: "  ",
			jev: fake,
		});

		expect(result.reason).toBe("invalid_question");
		expect(fake.calls.length).toBe(0);
	});
});

describe("scoutSemanticFiles — status ladder and savings", () => {
	test("binary/empty files fail per-path while others answer (partial)", async () => {
		const repo = makeRepo();
		write(repo, "ok.ts", "export const a = 1;\n");
		writeFileSync(path.join(repo, "bin.ts"), Buffer.from("abc\0def"));
		write(repo, "empty.ts", "");
		const fake = createFakeJevRuntime({ handler: autoHandler() });

		const result = await scoutSemanticFiles({
			repoRoot: repo,
			targets: ["."],
			question: "q",
			select: false,
			jev: fake,
		});

		expect(result.status).toBe("partial");
		expect(result.counts.answered).toBe(1);
		expect(result.counts.failed).toBe(2);
		const byPath = Object.fromEntries(result.results.map((entry) => [entry.path, entry]));
		expect(byPath["bin.ts"].reason).toBe("binary");
		expect(byPath["empty.ts"].reason).toBe("empty");
		expect("answer" in byPath["ok.ts"]).toBe(true);
	});

	test("computes savings as Σ fileBytes − Σ excerptBytes", async () => {
		const repo = makeRepo();
		write(repo, "big.ts", `${"line\n".repeat(200)}`);
		write(repo, "small.ts", "tiny\n");
		const fake = createFakeJevRuntime({ handler: autoHandler() });

		const result = await scoutSemanticFiles({
			repoRoot: repo,
			targets: ["."],
			question: "q",
			select: false,
			budgets: { excerptBytes: 32 },
			jev: fake,
		});

		const fileBytes = result.results.reduce((sum, entry) => sum + (entry.fileBytes ?? 0), 0);
		const excerptBytes = result.results.reduce((sum, entry) => sum + (entry.excerptBytes ?? 0), 0);
		expect(result.savings.totalFileBytes).toBe(fileBytes);
		expect(result.savings.totalExcerptBytes).toBe(excerptBytes);
		expect(result.savings.savedBytes).toBe(Math.max(0, fileBytes - excerptBytes));
		expect(result.savings.savedBytes).toBeGreaterThan(0);
	});

	test("degrades when every decision fails to spawn", async () => {
		const repo = makeRepo();
		write(repo, "a.ts", "x\n");
		write(repo, "b.ts", "y\n");
		const fake = createFakeJevRuntime({
			handler: () => {
				throw new JevRuntimeError({ code: "spawn_failed", message: "no cmd" });
			},
		});

		const result = await scoutSemanticFiles({
			repoRoot: repo,
			targets: ["."],
			question: "q",
			jev: fake,
		});

		expect(result.status).toBe("degraded");
		expect(result.degradedReason).toBe("spawn_failed");
		expect(result.guidance ?? "").toMatch(/read/);
		expect(result.counts.answered).toBe(0);
	});
});

describe("scoutSemanticFiles — deadline", () => {
	test("a hanging decision times out while a fast path survives", async () => {
		const repo = makeRepo();
		write(repo, "fast.ts", "x\n");
		write(repo, "slow.ts", "y\n");

		const stub: JevRuntime = {
			async decide(request: JevRequest): Promise<JevResult> {
				const state = request.state as { path?: string };
				if (state?.path === "fast.ts") return noulResult();
				return new Promise<JevResult>(() => {
					/* never settles */
				});
			},
		};

		const result = await scoutSemanticFiles({
			repoRoot: repo,
			targets: ["."],
			question: "q",
			select: false,
			budgets: { deadlineMs: 40 },
			jev: stub,
		});

		expect(result.timedOut).toBe(true);
		expect(result.status).toBe("partial");
		const byPath = Object.fromEntries(result.results.map((entry) => [entry.path, entry]));
		expect(byPath["fast.ts"].reason).toBeNull();
		expect("answer" in byPath["fast.ts"]).toBe(true);
		expect(byPath["slow.ts"].reason).toBe("timeout");
	});
});

describe("scoutSemanticFiles — second-pass recommendation", () => {
	test("recommends via a second-pass Choice when select is on", async () => {
		const repo = makeRepo();
		write(repo, "alpha.ts", "a\n");
		write(repo, "beta.ts", "b\n");
		write(repo, "gamma.ts", "c\n");
		const fake = createFakeJevRuntime({ handler: autoHandler() });

		const result = await scoutSemanticFiles({
			repoRoot: repo,
			targets: ["."],
			question: "Which should I open?",
			select: true,
			jev: fake,
		});

		expect(result.recommendation?.source).toBe("jev");
		expect(result.recommendation?.path).toBe("alpha.ts");
		// per-path noul requests + one select choice request
		const selectRequest = fake.requests.at(-1) as JevRequest;
		expect(selectRequest.questions.select?.type).toBe("choice");
	});

	test("falls back to ordered when the Choice errors", async () => {
		const repo = makeRepo();
		write(repo, "alpha.ts", "a\n");
		write(repo, "beta.ts", "b\n");
		const fake = createFakeJevRuntime({
			handler: (request) => {
				if ("select" in request.questions) {
					throw new JevRuntimeError({ code: "nonzero_exit", message: "choice down" });
				}
				return output({ q: { type: "noul", noul: 0.8, confidence: 0.9 } });
			},
		});

		const result = await scoutSemanticFiles({
			repoRoot: repo,
			targets: ["."],
			question: "Which should I open?",
			select: true,
			jev: fake,
		});

		expect(result.status).toBe("ok");
		expect(result.recommendation).toEqual({
			path: "alpha.ts",
			probabilities: {},
			confidence: 1,
			source: "ordered",
		});
	});

	test("caps options at selectLimit and keeps the choice request under 64 KiB", async () => {
		const repo = makeRepo();
		for (let i = 0; i < 6; i++) write(repo, `f${i}.ts`, "x\n");
		const fake = createFakeJevRuntime({ handler: autoHandler() });

		const result = await scoutSemanticFiles({
			repoRoot: repo,
			targets: ["."],
			question: "Which should I open?",
			select: true,
			budgets: { selectLimit: 3, maxPaths: 6 },
			jev: fake,
		});

		expect(result.recommendation?.source).toBe("jev");
		const selectRequest = fake.requests.at(-1) as JevRequest;
		const choiceQuestion = selectRequest.questions.select;
		expect(choiceQuestion.type).toBe("choice");
		if (choiceQuestion.type === "choice") {
			expect(Object.keys(choiceQuestion.criteria)).toHaveLength(3);
		}
		expect(Buffer.byteLength(JSON.stringify(selectRequest), "utf8")).toBeLessThan(65_536);
		expect(() => validateRequest(selectRequest)).not.toThrow();
	});

	test("worst-case per-path and choice requests stay under 64 KiB and validate", async () => {
		const repo = makeRepo();
		write(repo, "big-a.ts", "a".repeat(20_000));
		write(repo, "big-b.ts", "b".repeat(20_000));
		const fake = createFakeJevRuntime({ handler: autoHandler() });

		await scoutSemanticFiles({
			repoRoot: repo,
			targets: ["."],
			question: "Q".repeat(2000),
			select: true,
			jev: fake,
		});

		expect(fake.requests.length).toBeGreaterThanOrEqual(3);
		for (const request of fake.requests) {
			expect(Buffer.byteLength(JSON.stringify(request), "utf8")).toBeLessThan(65_536);
			expect(() => validateRequest(request)).not.toThrow();
		}
	});
});
