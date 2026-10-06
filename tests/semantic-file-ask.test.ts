import { afterEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { JevRuntimeError } from "../extensions/ce-core/jev/errors";
import { createFakeJevRuntime } from "../extensions/ce-core/jev/runtime";
import type {
	JevProcessOutput,
	JevRequest,
	JevRuntime,
} from "../extensions/ce-core/jev/types";
import { askSemanticFile } from "../extensions/ce-core/utils/semantic-file-ask";

const tempRoots: string[] = [];

function makeRepo(): string {
	const root = mkdtempSync(path.join(tmpdir(), "pi-semantic-ask-"));
	tempRoots.push(root);
	return root;
}

function write(repo: string, rel: string, content: string | Buffer): string {
	const full = path.join(repo, rel);
	mkdirSync(path.dirname(full), { recursive: true });
	writeFileSync(full, content);
	return full;
}

function output(answers: Record<string, unknown>): JevProcessOutput {
	return {
		exitCode: 0,
		stdout: JSON.stringify({ answers, model: "fake-jev" }),
		stderr: "",
	};
}

/** Answers whatever question type is asked with a valid, deterministic response. */
function autoHandler(): (request: JevRequest) => JevProcessOutput {
	return (request) => {
		const answers: Record<string, unknown> = {};
		for (const [id, question] of Object.entries(request.questions)) {
			if (question.type === "noul") {
				answers[id] = { type: "noul", noul: 0.8, confidence: 0.9 };
			} else if (question.type === "choice") {
				const keys = Object.keys(question.criteria);
				const probabilities = Object.fromEntries(
					keys.map((key, index) => [key, index === 0 ? 0.99 : 0.01]),
				);
				answers[id] = {
					type: "choice",
					choice: keys[0],
					probabilities,
					confidence: 0.9,
				};
			} else {
				const keys = question.criteria.map((_, index) => String(index));
				const probabilities = Object.fromEntries(
					keys.map((key, index) => [key, index === 0 ? 0.99 : 0.01]),
				);
				answers[id] = {
					type: "score",
					score: 0,
					legend: Object.fromEntries(keys.map((key) => [key, `level ${key}`])),
					probabilities,
					confidence: 0.9,
				};
			}
		}
		return output(answers);
	};
}

afterEach(() => {
	for (const root of tempRoots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe("askSemanticFile — typed answers", () => {
	test("noul: returns the typed answer plus deterministic facts, never a body", async () => {
		const repo = makeRepo();
		write(repo, "a.ts", "SECRET_BODY export const x = 1;\n");
		const fake = createFakeJevRuntime({ handler: autoHandler() });

		const result = await askSemanticFile({
			repoRoot: repo,
			path: "a.ts",
			question: "Does this file export anything?",
			jev: fake,
		});

		expect(result.status).toBe("ok");
		expect(result.path).toBe("a.ts");
		expect(result.reason).toBeNull();
		expect(result.answer).toEqual({ kind: "noul", value: 0.8, confidence: 0.9 });
		expect(result.fileBytes).toBe(Buffer.byteLength("SECRET_BODY export const x = 1;\n"));
		expect(result.excerptBytes).toBe(result.fileBytes);
		expect(result.truncated).toBe(false);
		expect(JSON.stringify(result)).not.toContain("SECRET_BODY");
		expect(fake.calls.length).toBe(1);
	});

	test("choice: returns label + probabilities", async () => {
		const repo = makeRepo();
		write(repo, "a.ts", "export const x = 1;\n");
		const fake = createFakeJevRuntime({ handler: autoHandler() });

		const result = await askSemanticFile({
			repoRoot: repo,
			path: "a.ts",
			question: "Which category?",
			type: "choice",
			criteria: { alpha: "first", beta: "second" },
			jev: fake,
		});

		expect(result.status).toBe("ok");
		expect(result.answer?.kind).toBe("choice");
		expect(result.answer).toMatchObject({
			kind: "choice",
			label: "alpha",
			confidence: 0.9,
		});
	});

	test("score: returns value + legend + probabilities", async () => {
		const repo = makeRepo();
		write(repo, "a.ts", "export const x = 1;\n");
		const fake = createFakeJevRuntime({ handler: autoHandler() });

		const result = await askSemanticFile({
			repoRoot: repo,
			path: "a.ts",
			question: "How complex?",
			type: "score",
			criteria: ["low", "mid", "high"],
			jev: fake,
		});

		expect(result.status).toBe("ok");
		expect(result.answer).toMatchObject({ kind: "score", value: 0, confidence: 0.9 });
	});
});

describe("askSemanticFile — validation before spawn", () => {
	test("rejects empty and oversized questions without spawning", async () => {
		const repo = makeRepo();
		write(repo, "a.ts", "x");
		const fake = createFakeJevRuntime({ handler: autoHandler() });

		for (const question of ["", "   ", "x".repeat(2001)]) {
			const result = await askSemanticFile({
				repoRoot: repo,
				path: "a.ts",
				question,
				jev: fake,
			});
			expect(result.status).toBe("error");
			expect(result.reason).toBe("invalid_question");
		}
		expect(fake.calls.length).toBe(0);
	});

	test("rejects an unknown question type without spawning", async () => {
		const repo = makeRepo();
		write(repo, "a.ts", "x");
		const fake = createFakeJevRuntime({ handler: autoHandler() });

		const result = await askSemanticFile({
			repoRoot: repo,
			path: "a.ts",
			question: "q",
			type: "bogus" as never,
			jev: fake,
		});

		expect(result.status).toBe("error");
		expect(result.reason).toBe("invalid_question");
		expect(fake.calls.length).toBe(0);
	});

	test("rejects malformed criteria for each type without spawning", async () => {
		const repo = makeRepo();
		write(repo, "a.ts", "x");
		const fake = createFakeJevRuntime({ handler: autoHandler() });

		const cases: Array<{ type: string; criteria: unknown }> = [
			{ type: "noul", criteria: { true: "" } },
			{ type: "noul", criteria: { true: 1 } },
			{ type: "choice", criteria: { onlyOne: "x" } },
			{ type: "choice", criteria: { "": "x", b: "y" } },
			{ type: "choice", criteria: { a: 1, b: "y" } },
			{ type: "choice", criteria: "not-an-object" },
			{ type: "score", criteria: ["only-one"] },
			{ type: "score", criteria: ["a", 1] },
			{ type: "score", criteria: "not-an-array" },
		];

		for (const { type, criteria } of cases) {
			const result = await askSemanticFile({
				repoRoot: repo,
				path: "a.ts",
				question: "q",
				type: type as never,
				criteria,
				jev: fake,
			});
			expect(result.reason).toBe("invalid_criteria");
		}
		expect(fake.calls.length).toBe(0);
	});
});

describe("askSemanticFile — path safety and file facts", () => {
	test("rejects traversal and absolute paths as outside_repo", async () => {
		const repo = makeRepo();
		write(repo, "a.ts", "x");
		const fake = createFakeJevRuntime({ handler: autoHandler() });

		for (const bad of ["../secret.ts", "/etc/hosts", path.join(tmpdir(), "x.ts")]) {
			const result = await askSemanticFile({
				repoRoot: repo,
				path: bad,
				question: "q",
				jev: fake,
			});
			expect(result.reason).toBe("outside_repo");
		}
		expect(fake.calls.length).toBe(0);
	});

	test("rejects a symlink escaping the repo as unsafe_path", async () => {
		const repo = makeRepo();
		const outside = makeRepo();
		write(outside, "target.ts", "x");
		symlinkSync(path.join(outside, "target.ts"), path.join(repo, "link.ts"));

		const fake = createFakeJevRuntime({ handler: autoHandler() });
		const result = await askSemanticFile({
			repoRoot: repo,
			path: "link.ts",
			question: "q",
			jev: fake,
		});

		expect(result.reason).toBe("unsafe_path");
		expect(fake.calls.length).toBe(0);
	});

	test("reports a missing file as not_found", async () => {
		const repo = makeRepo();
		const fake = createFakeJevRuntime({ handler: autoHandler() });

		const result = await askSemanticFile({
			repoRoot: repo,
			path: "missing.ts",
			question: "q",
			jev: fake,
		});

		expect(result.reason).toBe("not_found");
	});

	test("reports NUL-byte and UTF-16 BOM files as binary", async () => {
		const repo = makeRepo();
		write(repo, "nul.ts", Buffer.from("abc\0def"));
		write(repo, "bom.ts", Buffer.from([0xff, 0xfe, 0x61, 0x00]));
		write(repo, "image.png", "not really an image");
		const fake = createFakeJevRuntime({ handler: autoHandler() });

		for (const file of ["nul.ts", "bom.ts", "image.png"]) {
			const result = await askSemanticFile({
				repoRoot: repo,
				path: file,
				question: "q",
				jev: fake,
			});
			expect(result.reason).toBe("binary");
			expect(result.excerptBytes).toBe(0);
		}
	});

	test("reports a zero-byte file as empty", async () => {
		const repo = makeRepo();
		write(repo, "empty.ts", "");
		const fake = createFakeJevRuntime({ handler: autoHandler() });

		const result = await askSemanticFile({
			repoRoot: repo,
			path: "empty.ts",
			question: "q",
			jev: fake,
		});

		expect(result.reason).toBe("empty");
	});

	test.skipIf(process.getuid?.() === 0)(
		"reports an unreadable file as unreadable",
		async () => {
			const repo = makeRepo();
			const full = write(repo, "secret.ts", "top secret");
			chmodSync(full, 0o000);
			const fake = createFakeJevRuntime({ handler: autoHandler() });

			const result = await askSemanticFile({
				repoRoot: repo,
				path: "secret.ts",
				question: "q",
				jev: fake,
			});

			expect(result.reason).toBe("unreadable");
		},
	);
});

describe("askSemanticFile — excerpt window", () => {
	test("truncates a larger file on a line boundary and reports true sizes", async () => {
		const repo = makeRepo();
		const content = Array.from(
			{ length: 50 },
			(_, index) => `line ${String(index).padStart(3, "0")} of the file`,
		).join("\n");
		write(repo, "big.ts", content);
		const fake = createFakeJevRuntime({ handler: autoHandler() });

		const result = await askSemanticFile({
			repoRoot: repo,
			path: "big.ts",
			question: "q",
			budgets: { excerptBytes: 64 },
			jev: fake,
		});

		expect(result.status).toBe("ok");
		expect(result.truncated).toBe(true);
		expect(result.fileBytes).toBe(Buffer.byteLength(content));
		expect(result.excerptBytes ?? 0).toBeLessThanOrEqual(64);
		const excerpt = (fake.requests[0].state as { excerpt: string }).excerpt;
		expect(excerpt.endsWith("\n")).toBe(true);
		expect(Buffer.byteLength(excerpt)).toBe(result.excerptBytes ?? -1);
	});

	test("bounds a single-line file with no newline", async () => {
		const repo = makeRepo();
		const content = "A".repeat(100);
		write(repo, "one.ts", content);
		const fake = createFakeJevRuntime({ handler: autoHandler() });

		const result = await askSemanticFile({
			repoRoot: repo,
			path: "one.ts",
			question: "q",
			budgets: { excerptBytes: 32 },
			jev: fake,
		});

		expect(result.truncated).toBe(true);
		expect(result.excerptBytes).toBeLessThanOrEqual(32);
	});

	test("does not mark a file at or below the budget as truncated", async () => {
		const repo = makeRepo();
		write(repo, "small.ts", "tiny\n");
		const fake = createFakeJevRuntime({ handler: autoHandler() });

		const result = await askSemanticFile({
			repoRoot: repo,
			path: "small.ts",
			question: "q",
			budgets: { excerptBytes: 64 },
			jev: fake,
		});

		expect(result.truncated).toBe(false);
		expect(result.excerptBytes).toBe(result.fileBytes);
	});
});

describe("askSemanticFile — degraded and robustness", () => {
	test("degrades on a spawn failure with non-empty guidance", async () => {
		const repo = makeRepo();
		write(repo, "a.ts", "x");
		const fake = createFakeJevRuntime({
			handler: () => {
				throw new JevRuntimeError({ code: "spawn_failed", message: "no cmd" });
			},
		});

		const result = await askSemanticFile({
			repoRoot: repo,
			path: "a.ts",
			question: "q",
			jev: fake,
		});

		expect(result.status).toBe("degraded");
		expect(result.degradedReason).toBe("spawn_failed");
		expect(result.guidance ?? "").toMatch(/read/);
		expect(result.guidance ?? "").toMatch(/grep/);
	});

	test("folds missing_executable into spawn_failed", async () => {
		const repo = makeRepo();
		write(repo, "a.ts", "x");
		const fake = createFakeJevRuntime({
			handler: () => {
				throw new JevRuntimeError({
					code: "missing_executable",
					message: "no cmd",
				});
			},
		});

		const result = await askSemanticFile({
			repoRoot: repo,
			path: "a.ts",
			question: "q",
			jev: fake,
		});

		expect(result.status).toBe("degraded");
		expect(result.degradedReason).toBe("spawn_failed");
	});

	test("never throws when the runtime throws a non-Error", async () => {
		const repo = makeRepo();
		write(repo, "a.ts", "x");
		const throwingStub: JevRuntime = {
			async decide() {
				throw "not an error object";
			},
		};

		const result = await askSemanticFile({
			repoRoot: repo,
			path: "a.ts",
			question: "q",
			jev: throwingStub,
		});

		expect(result.status).toBe("error");
		expect(result.reason).toBe("jev_error");
	});
});
