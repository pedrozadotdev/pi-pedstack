// Unit 8 — dry-run-first role migration helper and CLI.
import { afterEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildRoleMigration } from "../extensions/ce-core/utils/role-migration";
import type { PiPedstackConfig } from "../extensions/ce-core/utils/config-types";

const repoRoot = path.resolve(import.meta.dir, "..");
const tempRoots: string[] = [];

function makeTempRoot(): string {
	const root = mkdtempSync(path.join(tmpdir(), "pi-role-migration-"));
	tempRoots.push(root);
	return root;
}

afterEach(() => {
	for (const root of tempRoots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe("buildRoleMigration (Unit 8)", () => {
	test("folds two distinct per-stage models into default and review", () => {
		const config = {
			brainstorm: { model: "m/one" },
			plan: { model: "m/one", thinkingLevel: "high" },
			work: { model: "m/two" },
		} as PiPedstackConfig;

		const plan = buildRoleMigration(config);

		expect(plan.status).toBe("migratable");
		expect(plan.roles.default?.model).toBe("m/one");
		expect(plan.roles.review?.model).toBe("m/two");
		expect(plan.roles.sota).toBeUndefined();
		expect(plan.foldedStages).toEqual(["brainstorm", "plan", "work"]);
		expect(plan.nextConfig.brainstorm).toBeUndefined();
		expect(plan.nextConfig.work).toBeUndefined();
		expect(plan.nextConfig.models).toEqual(plan.roles);
	});

	test("preserves an explicit reviewers[] stage unchanged", () => {
		const config = {
			plan: { model: "m/one" },
			review: { model: "m/two", reviewers: [{ model: "m/rev" }] },
		} as PiPedstackConfig;

		const plan = buildRoleMigration(config);

		expect(plan.status).toBe("migratable");
		expect(plan.foldedStages).toEqual(["plan"]);
		expect(plan.nextConfig.review).toEqual({
			model: "m/two",
			reviewers: [{ model: "m/rev" }],
		});
		expect(plan.nextConfig.plan).toBeUndefined();
	});

	test("refuses four distinct models and leaves the config unchanged", () => {
		const config = {
			brainstorm: { model: "a" },
			plan: { model: "b" },
			work: { model: "c" },
			learn: { model: "d" },
		} as PiPedstackConfig;

		const plan = buildRoleMigration(config);

		expect(plan.status).toBe("not_migratable");
		expect(plan.distinctModels).toEqual(["a", "b", "c", "d"]);
		expect(plan.nextConfig).toEqual(config);
		expect(plan.foldedStages).toEqual([]);
	});

	test("is a noop for an already role-only config", () => {
		const config = {
			models: { default: { model: "m/one" } },
		} as PiPedstackConfig;

		const plan = buildRoleMigration(config);

		expect(plan.status).toBe("noop");
		expect(plan.roles).toEqual({ default: { model: "m/one" } });
		expect(plan.nextConfig).toEqual(config);
	});

	test("preserves thinkingLevel per role from the supplying stage", () => {
		const config = {
			plan: { model: "m/one", thinkingLevel: "low" },
			work: { model: "m/two", thinkingLevel: "high" },
		} as PiPedstackConfig;

		const plan = buildRoleMigration(config);

		expect(plan.status).toBe("migratable");
		expect(plan.roles.default).toEqual({ model: "m/one", thinkingLevel: "low" });
		expect(plan.roles.review).toEqual({ model: "m/two", thinkingLevel: "high" });
	});
});

function runCli(args: string[]): {
	status: number;
	stdout: string;
	stderr: string;
} {
	const proc = Bun.spawnSync(["bun", "scripts/migrate-roles.ts", ...args], {
		cwd: repoRoot,
	});
	return {
		status: proc.exitCode ?? 1,
		stdout: proc.stdout.toString(),
		stderr: proc.stderr.toString(),
	};
}

describe("migrate:roles CLI (Unit 8)", () => {
	test("dry run prints a diff and writes nothing", () => {
		const root = makeTempRoot();
		const configPath = path.join(root, "config.json");
		const original = `${JSON.stringify(
			{ plan: { model: "m/one" }, work: { model: "m/two" } },
			null,
			2,
		)}\n`;
		writeFileSync(configPath, original, "utf8");

		const result = runCli(["--config", configPath]);

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("--- before");
		expect(readFileSync(configPath, "utf8")).toBe(original);
	});

	test("--write on a non-migratable plan exits non-zero and writes nothing", () => {
		const root = makeTempRoot();
		const configPath = path.join(root, "config.json");
		const original = `${JSON.stringify(
			{
				brainstorm: { model: "a" },
				plan: { model: "b" },
				work: { model: "c" },
				learn: { model: "d" },
			},
			null,
			2,
		)}\n`;
		writeFileSync(configPath, original, "utf8");

		const result = runCli(["--write", "--config", configPath]);

		expect(result.status).not.toBe(0);
		expect(readFileSync(configPath, "utf8")).toBe(original);
	});

	test("an absent config path exits non-zero without writing", () => {
		const root = makeTempRoot();
		const missing = path.join(root, "nope.json");

		const result = runCli(["--config", missing]);

		expect(result.status).not.toBe(0);
		expect(result.stderr.toLowerCase()).toContain("nothing to migrate");
		expect(existsSync(missing)).toBe(false);
	});

	test("--write applies the migration", () => {
		const root = makeTempRoot();
		const configPath = path.join(root, "config.json");
		writeFileSync(
			configPath,
			`${JSON.stringify(
				{ plan: { model: "m/one" }, work: { model: "m/two" } },
				null,
				2,
			)}\n`,
			"utf8",
		);

		const result = runCli(["--write", "--config", configPath]);

		expect(result.status).toBe(0);
		const written = JSON.parse(readFileSync(configPath, "utf8")) as {
			models?: { default?: { model: string }; review?: { model: string } };
			plan?: unknown;
		};
		expect(written.models?.default?.model).toBe("m/one");
		expect(written.models?.review?.model).toBe("m/two");
		expect(written.plan).toBeUndefined();
	});
});
