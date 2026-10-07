// Unit 8 — dry-run-first role migration helper and CLI.
import { afterEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
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
			brainstorm: { model: "m/one", thinkingLevel: "high" },
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

	test("folds repeated model with the same thinking level", () => {
		const config = {
			brainstorm: { model: "m/one", thinkingLevel: "high" },
			plan: { model: "m/one", thinkingLevel: "high" },
		} as PiPedstackConfig;

		const plan = buildRoleMigration(config);

		expect(plan.status).toBe("migratable");
		expect(plan.roles.default).toEqual({ model: "m/one", thinkingLevel: "high" });
		expect(plan.distinctModels).toEqual(["m/one"]);
	});

	test("refuses conflicting explicit thinkingLevels on one model", () => {
		const config = {
			work: { model: "m/one", thinkingLevel: "low" },
			learn: { model: "m/one", thinkingLevel: "high" },
		} as PiPedstackConfig;

		const plan = buildRoleMigration(config);

		expect(plan.status).toBe("not_migratable");
		expect(plan.reason).toContain("m/one");
		expect(plan.reason).toContain("work");
		expect(plan.reason).toContain("learn");
		expect(plan.reason).toContain("low");
		expect(plan.reason).toContain("high");
		expect(plan.nextConfig).toEqual(config);
	});

	test("refuses an unset level mixed with an explicit level on one model", () => {
		// Deliberate conservative semantics: dropping the unset stage or forcing
		// it to `high` both change observable thinking behavior, so refuse.
		const config = {
			brainstorm: { model: "m/one" },
			plan: { model: "m/one", thinkingLevel: "high" },
		} as PiPedstackConfig;

		const plan = buildRoleMigration(config);

		expect(plan.status).toBe("not_migratable");
		expect(plan.reason).toContain("m/one");
		expect(plan.reason).toContain("(unset)");
		expect(plan.reason).toContain("high");
	});

	test("retains an exactly compatible authored role", () => {
		const config = {
			models: { default: { model: "m/one", thinkingLevel: "high" } },
			plan: { model: "m/one", thinkingLevel: "high" },
			work: { model: "m/one", thinkingLevel: "high" },
		} as PiPedstackConfig;

		const plan = buildRoleMigration(config);

		expect(plan.status).toBe("migratable");
		expect(plan.nextConfig.models?.default).toEqual({
			model: "m/one",
			thinkingLevel: "high",
		});
	});

	test("preserves an authored role the fold does not generate", () => {
		const config = {
			models: { review: { model: "provider/independent-reviewer" } },
			plan: { model: "provider/default" },
			work: { model: "provider/default" },
		} as PiPedstackConfig;

		const plan = buildRoleMigration(config);

		expect(plan.status).toBe("migratable");
		expect(plan.roles).toEqual({ default: { model: "provider/default" } });
		expect(plan.nextConfig.models).toEqual({
			review: { model: "provider/independent-reviewer" },
			default: { model: "provider/default" },
		});
	});

	test("refuses a generated role that conflicts with an authored role", () => {
		const config = {
			models: { review: { model: "provider/independent-reviewer" } },
			plan: { model: "provider/independent-reviewer" },
			work: { model: "provider/other" },
		} as PiPedstackConfig;

		const plan = buildRoleMigration(config);

		expect(plan.status).toBe("not_migratable");
		expect(plan.reason).toContain("models.review");
		expect(plan.nextConfig).toEqual(config);
	});

	test("refuses an authored role with a different thinkingLevel", () => {
		const config = {
			models: { default: { model: "m/one", thinkingLevel: "low" } },
			plan: { model: "m/one", thinkingLevel: "high" },
		} as PiPedstackConfig;

		const plan = buildRoleMigration(config);

		expect(plan.status).toBe("not_migratable");
		expect(plan.reason).toContain("models.default");
	});

	test("assigns three distinct models to default, review, and sota", () => {
		const config = {
			brainstorm: { model: "a" },
			plan: { model: "b" },
			work: { model: "c" },
		} as PiPedstackConfig;

		const plan = buildRoleMigration(config);

		expect(plan.status).toBe("migratable");
		expect(plan.distinctModels).toEqual(["a", "b", "c"]);
		expect(plan.roles.default?.model).toBe("a");
		expect(plan.roles.review?.model).toBe("b");
		expect(plan.roles.sota?.model).toBe("c");
	});

	test("retains a fully compatible authored role block", () => {
		const config = {
			models: {
				default: { model: "a" },
				review: { model: "b" },
				sota: { model: "c" },
			},
			plan: { model: "a" },
			work: { model: "b" },
			learn: { model: "c" },
		} as PiPedstackConfig;

		const plan = buildRoleMigration(config);

		expect(plan.status).toBe("migratable");
		expect(plan.nextConfig.models).toEqual(config.models);
	});
});

function runCli(
	args: string[],
	env?: Record<string, string>,
): {
	status: number;
	stdout: string;
	stderr: string;
} {
	const proc = Bun.spawnSync(["bun", "scripts/migrate-roles.ts", ...args], {
		cwd: repoRoot,
		env: env ? { ...process.env, ...env } : undefined,
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

	test("--config without a path fails without touching a fallback", () => {
		const fakeHome = makeTempRoot();
		const globalPath = path.join(
			fakeHome,
			".pi",
			"pi-pedstack",
			"config.json",
		);
		mkdirSync(path.dirname(globalPath), { recursive: true });
		const original = `${JSON.stringify(
			{ plan: { model: "m/one" } },
			null,
			2,
		)}\n`;
		writeFileSync(globalPath, original, "utf8");

		const result = runCli(["--write", "--config"], { HOME: fakeHome });

		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("--config requires a path");
		expect(readFileSync(globalPath, "utf8")).toBe(original);
	});

	test("--config followed by another option fails", () => {
		const result = runCli(["--config", "--write"]);

		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("--config requires a path");
	});

	test("--config with an empty value fails", () => {
		const result = runCli(["--config", ""]);

		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("--config requires a path");
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
