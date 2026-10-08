import { expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dir, "../plugins/agy-reviewer");

test("packages the native plugin, flat lifecycle hooks, and restricted reviewer agent", () => {
	const plugin = JSON.parse(readFileSync(path.join(root, "plugin.json"), "utf8")) as Record<string, unknown>;
	const hooks = JSON.parse(readFileSync(path.join(root, "hooks.json"), "utf8")) as Record<string, unknown>;
	const hookConfig = hooks["pi-pedstack-reviewer-guard"] as Record<string, unknown>;
	const agent = readFileSync(path.join(root, "agents/pi-pedstack-reviewer.md"), "utf8");
	const guardPath = path.join(root, "guard.js");
	const guard = readFileSync(guardPath, "utf8");
	expect(plugin.name).toBe("pi-pedstack-reviewer");
	expect(Object.keys(plugin).sort()).toEqual(["$schema", "description", "name"]);
	expect(hookConfig.PreInvocation).toBeArray();
	expect(hookConfig.PreToolUse).toBeArray();
	expect(agent).toContain("mainAgent: true");
	expect(agent).toContain("subagent: false");
	expect(agent).toContain("model: inherit");
	expect(agent).not.toContain("invoke_subagent");
	expect(existsSync(guardPath)).toBe(true);
	expect(statSync(guardPath).size).toBeLessThan(1024 * 1024);
	expect(guard).not.toMatch(/from ["']\.\.?\//);
	expect((hookConfig.PreInvocation as Array<{ command: string }>)[0]?.command).toContain("PreInvocation");
	expect((hookConfig.Stop as Array<{ command: string }>)[0]?.command).toContain("Stop");
});
