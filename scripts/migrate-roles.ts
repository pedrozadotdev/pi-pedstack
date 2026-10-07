// Thin CLI for the role migration helper (plan Unit 8). Reads the project then
// global config, prints a unified diff, and writes only with `--write` and only
// when a lossless migration exists. No model-strength guessing.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import {
	validatePiPedstackConfig,
	type PiPedstackConfig,
} from "../extensions/ce-core/utils/config-types";
import { buildRoleMigration } from "../extensions/ce-core/utils/role-migration";

const PROJECT_REL = path.join(".pi", "pi-pedstack", "config.json");

/** Project config wins; the global path is the fallback. */
function resolveConfigPath(explicit?: string): string {
	if (explicit) return explicit;
	const project = path.join(process.cwd(), PROJECT_REL);
	if (fs.existsSync(project)) return project;
	return path.join(os.homedir(), PROJECT_REL);
}

/** LCS length table for the two line arrays. */
function lcsTable(a: string[], b: string[]): number[][] {
	const m = a.length;
	const n = b.length;
	const dp: number[][] = Array.from({ length: m + 1 }, () =>
		new Array<number>(n + 1).fill(0),
	);
	for (let i = m - 1; i >= 0; i--) {
		for (let j = n - 1; j >= 0; j--) {
			dp[i][j] =
				a[i] === b[j]
					? dp[i + 1][j + 1] + 1
					: Math.max(dp[i + 1][j], dp[i][j + 1]);
		}
	}
	return dp;
}

function walkDiff(a: string[], b: string[], dp: number[][]): string[] {
	const lines: string[] = [];
	let i = 0;
	let j = 0;
	while (i < a.length && j < b.length) {
		if (a[i] === b[j]) {
			lines.push(` ${a[i]}`);
			i++;
			j++;
		} else if (dp[i + 1][j] >= dp[i][j + 1]) {
			lines.push(`-${a[i]}`);
			i++;
		} else {
			lines.push(`+${b[j]}`);
			j++;
		}
	}
	while (i < a.length) lines.push(`-${a[i++]}`);
	while (j < b.length) lines.push(`+${b[j++]}`);
	return lines;
}

/** A minimal LCS unified diff; config files are small. */
function formatUnifiedDiff(before: string, after: string): string {
	const a = before.split("\n");
	const b = after.split("\n");
	const lines = ["--- before", "+++ after", ...walkDiff(a, b, lcsTable(a, b))];
	return lines.join("\n");
}

/**
 * Resolve an explicit `--config <path>`. An explicitly supplied but malformed
 * flag must never silently fall back to a default target: a destructive
 * `--write` could otherwise mutate a file the operator never named.
 */
type ExplicitConfigResult =
	| { ok: true; path?: string }
	| { ok: false };

function readExplicitConfigPath(argv: string[]): ExplicitConfigResult {
	const configIndex = argv.indexOf("--config");
	if (configIndex < 0) return { ok: true };
	const value = argv[configIndex + 1];
	if (!value || value.startsWith("--")) {
		console.error("[migrate:roles] --config requires a path");
		return { ok: false };
	}
	return { ok: true, path: value };
}

/** Read and validate one config file, or report why it could not be loaded. */
interface LoadedConfig {
	raw: string;
	config: PiPedstackConfig;
}

async function loadConfig(configPath: string): Promise<LoadedConfig | null> {
	let raw: string;
	try {
		raw = await readFile(configPath, "utf8");
	} catch {
		console.error(
			`[migrate:roles] no config found at ${configPath}; nothing to migrate.`,
		);
		return null;
	}
	try {
		return { raw, config: validatePiPedstackConfig(JSON.parse(raw)) };
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		console.error(`[migrate:roles] ${configPath} is invalid: ${reason}`);
		return null;
	}
}

/** Runs the CLI; returns a process exit code. */
export async function runMigrateRoles(argv: string[]): Promise<number> {
	const write = argv.includes("--write");
	const explicit = readExplicitConfigPath(argv);
	if (!explicit.ok) return 2;
	const configPath = resolveConfigPath(explicit.path);
	const loaded = await loadConfig(configPath);
	if (!loaded) return 1;

	const plan = buildRoleMigration(loaded.config);
	if (plan.status === "not_migratable") {
		console.error(`[migrate:roles] not migratable: ${plan.reason}`);
		console.error(
			`[migrate:roles] distinct models: ${plan.distinctModels.join(", ")}`,
		);
		return 1;
	}
	if (plan.status === "noop") {
		console.log("[migrate:roles] nothing to migrate; config is already role-only.");
		return 0;
	}

	const after = `${JSON.stringify(plan.nextConfig, null, 2)}\n`;
	console.log(formatUnifiedDiff(loaded.raw, after));
	if (!write) {
		console.log("\n[migrate:roles] dry run; re-run with --write to apply.");
		return 0;
	}
	await writeFile(configPath, after, "utf8");
	console.log(`\n[migrate:roles] wrote ${configPath}`);
	return 0;
}

if (import.meta.main) {
	process.exit(await runMigrateRoles(process.argv.slice(2)));
}
