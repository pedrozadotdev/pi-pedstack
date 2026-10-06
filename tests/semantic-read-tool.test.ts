import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { JevRuntimeError } from "../extensions/ce-core/jev/errors";
import { createFakeJevRuntime } from "../extensions/ce-core/jev/runtime";
import type { JevProcessOutput } from "../extensions/ce-core/jev/types";
import { createSemanticReadTool } from "../extensions/ce-core/tools/semantic-read";

const tempRoots: string[] = [];

function makeRepo(): string {
	const root = mkdtempSync(path.join(tmpdir(), "pi-semantic-read-tool-"));
	tempRoots.push(root);
	return root;
}

function write(repo: string, rel: string, content: string): void {
	const full = path.join(repo, rel);
	mkdirSync(path.dirname(full), { recursive: true });
	writeFileSync(full, content);
}

function noulOutput(): JevProcessOutput {
	return {
		exitCode: 0,
		stdout: JSON.stringify({
			answers: { q: { type: "noul", noul: 0.8, confidence: 0.9 } },
			model: "fake-jev",
		}),
		stderr: "",
	};
}

afterEach(() => {
	for (const root of tempRoots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe("semantic_read tool", () => {
	test("exposes model-facing metadata with guidance and a no-body claim", () => {
		const tool = createSemanticReadTool();

		expect(tool.name).toBe("semantic_read");
		const description = tool.description.toLowerCase();
		expect(description).toContain("read");
		expect(description).toContain("grep");
		expect(description).toContain("never file bodies");
	});

	test("ok: includes the path, the typed answer, and never the file body", async () => {
		const repo = makeRepo();
		write(repo, "a.ts", "SECRET_BODY export const x = 1;\n");
		const tool = createSemanticReadTool({
			jev: createFakeJevRuntime({ handler: () => noulOutput() }),
		});

		const { text, result } = await tool.execute({
			repoRoot: repo,
			path: "a.ts",
			question: "Does this file export anything?",
		});

		expect(result.status).toBe("ok");
		expect(text).toContain("a.ts");
		expect(text).toContain("noul");
		expect(text).not.toContain("SECRET_BODY");
	});

	test("degraded: surfaces read/grep guidance without throwing", async () => {
		const repo = makeRepo();
		write(repo, "a.ts", "export const x = 1;\n");
		const tool = createSemanticReadTool({
			jev: createFakeJevRuntime({
				handler: () => {
					throw new JevRuntimeError({ code: "spawn_failed", message: "no cmd" });
				},
			}),
		});

		const { text, result } = await tool.execute({
			repoRoot: repo,
			path: "a.ts",
			question: "q",
		});

		expect(result.status).toBe("degraded");
		expect(text.toLowerCase()).toContain("read");
		expect(text.toLowerCase()).toContain("grep");
	});

	test("creates the runtime lazily and reuses it across executes", async () => {
		const repo = makeRepo();
		write(repo, "a.ts", "x\n");
		let factoryCalls = 0;
		const tool = createSemanticReadTool({
			jevFactory: () => {
				factoryCalls++;
				return createFakeJevRuntime({ handler: () => noulOutput() });
			},
		});

		expect(factoryCalls).toBe(0);
		await tool.execute({ repoRoot: repo, path: "a.ts", question: "q" });
		expect(factoryCalls).toBe(1);
		await tool.execute({ repoRoot: repo, path: "a.ts", question: "q" });
		expect(factoryCalls).toBe(1);
	});
});
