import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { preflightAgy } from "../extensions/ce-core/review/agy-runner";

const enabled = process.env.PEDSTACK_AGY_INTEGRATION === "1";
const model = process.env.PEDSTACK_AGY_INTEGRATION_MODEL;
let workspace = "";
afterEach(() => { if (workspace) rmSync(workspace, { recursive: true, force: true }); workspace = ""; });

test.skipIf(!enabled)("native agy activation challenge proves read denial before review launch", async () => {
	expect(model, "set PEDSTACK_AGY_INTEGRATION_MODEL to an explicitly approved model identifier").toBeTruthy();
	workspace = mkdtempSync(path.join(tmpdir(), "pedstack-agy-integration-"));
	await expect(preflightAgy({
		model: model!,
		workspace,
		shippedPluginDirectory: path.resolve(import.meta.dir, "../plugins/agy-reviewer"),
	})).resolves.toMatch(/^[a-f0-9]{64}$/);
});
