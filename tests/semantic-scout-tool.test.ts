import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFakeJevRuntime } from "../extensions/ce-core/jev/runtime";
import type { JevProcessOutput, JevRequest } from "../extensions/ce-core/jev/types";
import { createSemanticScoutTool } from "../extensions/ce-core/tools/semantic-scout";

const tempRoots: string[] = [];

function makeRepo(): string {
	const root = mkdtempSync(path.join(tmpdir(), "pi-semantic-scout-tool-"));
	tempRoots.push(root);
	return root;
}

function write(repo: string, rel: string, content: string): void {
	const full = path.join(repo, rel);
	mkdirSync(path.dirname(full), { recursive: true });
	writeFileSync(full, content);
}

function autoHandler() {
	return (request: JevRequest): JevProcessOutput => {
		const answers: Record<string, unknown> = {};
		for (const [id, question] of Object.entries(request.questions)) {
			if (question.type === "noul") {
				answers[id] = { type: "noul", noul: 0.8, confidence: 0.9 };
			} else {
				const keys = Object.keys(question.criteria);
				answers[id] = {
					type: "choice",
					choice: keys[0],
					probabilities: Object.fromEntries(
						keys.map((key, index) => [key, index === 0 ? 0.9 : 0.1 / Math.max(1, keys.length - 1)]),
					),
					confidence: 0.9,
				};
			}
		}
		return { exitCode: 0, stdout: JSON.stringify({ answers, model: "fake-jev" }), stderr: "" };
	};
}

afterEach(() => {
	for (const root of tempRoots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe("semantic_scout tool", () => {
	test("exposes model-facing metadata with guidance and a no-body claim", () => {
		const tool = createSemanticScoutTool();

		expect(tool.name).toBe("semantic_scout");
		const description = tool.description.toLowerCase();
		expect(description).toContain("read");
		expect(description).toContain("grep");
		expect(description).toContain("never file bodies");
	});

	test("ok: surfaces omitted and savings", async () => {
		const repo = makeRepo();
		for (let i = 0; i < 4; i++) write(repo, `f${i}.ts`, `${"line\n".repeat(50)}`);
		const tool = createSemanticScoutTool({
			jev: createFakeJevRuntime({ handler: autoHandler() }),
		});

		const { text, result } = await tool.execute({
			repoRoot: repo,
			targets: ["."],
			question: "Which should I open?",
			select: false,
			limit: 2,
		});

		expect(result.counts.omitted).toBe(2);
		expect(text).toContain("omitted");
		expect(text).toContain("savedBytes");
	});

	test("empty: explicitly reports no eligible files", async () => {
		const repo = makeRepo();
		const tool = createSemanticScoutTool({
			jev: createFakeJevRuntime({ handler: autoHandler() }),
		});

		const { text, result } = await tool.execute({
			repoRoot: repo,
			targets: [],
			question: "Which should I open?",
		});

		expect(result.status).toBe("empty");
		expect(text.toLowerCase()).toContain("no eligible files");
	});

	test("creates the runtime lazily and reuses it across executes", async () => {
		const repo = makeRepo();
		write(repo, "a.ts", "x\n");
		let factoryCalls = 0;
		const tool = createSemanticScoutTool({
			jevFactory: () => {
				factoryCalls++;
				return createFakeJevRuntime({ handler: autoHandler() });
			},
		});

		expect(factoryCalls).toBe(0);
		await tool.execute({ repoRoot: repo, targets: ["."], question: "q", select: false });
		expect(factoryCalls).toBe(1);
		await tool.execute({ repoRoot: repo, targets: ["."], question: "q", select: false });
		expect(factoryCalls).toBe(1);
	});
});
