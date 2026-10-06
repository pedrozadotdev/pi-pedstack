// Docs verification — deterministic per-unit facts (plan Unit 2). All file I/O
// is injected so the module is testable from fixtures without touching the repo.
import { createHash } from "node:crypto";
import path from "node:path";
import type {
	DeclaredFile,
	DocsPhase,
	DocsUnit,
	FactsDeps,
	FactsInput,
	LockKind,
	PackageFact,
	UnitFacts,
} from "./types";
import {
	extractUnits,
	parseEvidenceLines,
	parsePlannedPackages,
	unitContentHash,
	validateEvidenceLine,
} from "./units";

const TOOLING_PATTERN =
	/\b(test|tests|build|lint|typecheck|tsc|compiler|tooling|devdependencies|ci|config)\b/i;

function isToolingUnit(unitText: string): boolean {
	return TOOLING_PATTERN.test(unitText);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function collect(
	value: unknown,
	kind: PackageFact["kind"],
	out: Map<string, PackageFact>,
): void {
	if (!isRecord(value)) return;
	for (const [name, rawVersion] of Object.entries(value)) {
		if (out.has(name)) continue;
		out.set(name, {
			name,
			version: typeof rawVersion === "string" ? rawVersion : null,
			versionUnknown: true,
			kind,
		});
	}
}

/**
 * Dependency entries from a `package.json`: `dependencies` + `peerDependencies`
 * always, `devDependencies` only for a build/test tooling unit (R2).
 */
export function parseManifestDeps(
	manifest: unknown,
	isToolingUnitValue: boolean,
): PackageFact[] {
	if (!isRecord(manifest)) return [];
	const out = new Map<string, PackageFact>();
	collect(manifest.dependencies, "dependency", out);
	collect(manifest.peerDependencies, "peer", out);
	if (isToolingUnitValue) collect(manifest.devDependencies, "dev", out);
	return [...out.values()];
}

const CALL = /^(import|require)\s*\(([\s\S]*)\)$/;

export interface SpecifierClass {
	external: boolean;
	name?: string;
	dynamic: boolean;
	ambiguous?: boolean;
}

/**
 * In-repo/external boundary for one specifier. Builtins, relative paths, the
 * `~`/`@/` aliases, and URL schemes are never external; a computed `import()` is
 * ambiguous; a string-literal `import()` is external and dynamic (R2).
 */
export function classifySpecifier(specifier: string): SpecifierClass {
	const text = specifier.trim();
	const call = CALL.exec(text);
	const dynamic = call?.[1] === "import";
	const inner = (call ? call[2] : text).trim();
	const literal = /^["'`]([\s\S]*)["'`]$/.exec(inner);
	if (!literal && call) return { external: false, dynamic, ambiguous: true };
	const value = (literal ? literal[1] : inner).trim();
	if (value.length === 0) {
		return call
			? { external: false, dynamic, ambiguous: true }
			: { external: false, dynamic };
	}
	if (value.startsWith("node:") || value.startsWith("bun:")) {
		return { external: false, dynamic };
	}
	if (/^[.~/]/.test(value) || value.startsWith("@/")) {
		return { external: false, dynamic };
	}
	if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return { external: false, dynamic };
	const name = value.startsWith("@")
		? value.split("/").slice(0, 2).join("/")
		: value.split("/")[0];
	return name.length > 0
		? { external: true, name, dynamic }
		: { external: false, dynamic };
}

const IMPORT_FROM = /\b(?:import|export)\s+([^;{}"']*?\{[\s\S]*?\}|[^;]*?)\bfrom\s*["']([^"']+)["']/g;
const IMPORT_BARE = /\bimport\s*["']([^"']+)["']/g;
const DYNAMIC_IMPORT = /\bimport\s*\(\s*([^)]*?)\s*\)/g;
const REQUIRE_CALL = /\brequire\s*\(\s*([^)]*?)\s*\)/g;

function unquote(value: string): string {
	const match = /^["'`]([\s\S]*)["'`]$/.exec(value.trim());
	return match ? match[1] : value.trim();
}

/**
 * Static `import` / `export ... from` / `require()` / dynamic `import()`
 * specifiers. Type-only imports are excluded; a dynamic string literal is kept
 * wrapped as `import("...")` so the classifier can mark it dynamic (R2).
 */
export function extractExternalSpecifiers(sourceText: string): string[] {
	const found: string[] = [];
	const add = (value: string): void => {
		const trimmed = value.trim();
		if (trimmed.length > 0) found.push(trimmed);
	};
	for (const match of sourceText.matchAll(IMPORT_FROM)) {
		if (/^\s*type\s/.test(match[1])) continue;
		add(match[2]);
	}
	for (const match of sourceText.matchAll(IMPORT_BARE)) add(match[1]);
	for (const match of sourceText.matchAll(DYNAMIC_IMPORT)) {
		add(`import(${match[1].trim()})`);
	}
	for (const match of sourceText.matchAll(REQUIRE_CALL)) add(unquote(match[1]));
	return found;
}

const LOCKFILES: ReadonlyArray<{ name: string; kind: LockKind }> = [
	{ name: "bun.lock", kind: "bun" },
	{ name: "package-lock.json", kind: "npm" },
	{ name: "pnpm-lock.yaml", kind: "pnpm" },
	{ name: "yarn.lock", kind: "yarn" },
];

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function npmVersion(text: string, name: string): string | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return null;
	}
	if (!isRecord(parsed)) return null;
	const packages = parsed.packages;
	if (isRecord(packages)) {
		const entry = packages[`node_modules/${name}`];
		if (isRecord(entry) && typeof entry.version === "string") return entry.version;
	}
	const dependencies = parsed.dependencies;
	if (isRecord(dependencies)) {
		const entry = dependencies[name];
		if (isRecord(entry) && typeof entry.version === "string") return entry.version;
	}
	return null;
}

function bunVersion(text: string, name: string): string | null {
	try {
		const parsed: unknown = JSON.parse(text);
		if (isRecord(parsed) && isRecord(parsed.dependencies)) {
			const entry = parsed.dependencies[name];
			if (typeof entry === "string") {
				const at = entry.lastIndexOf("@");
				return at > 0 ? entry.slice(at + 1) : entry;
			}
		}
	} catch {
		// non-JSON bun text falls through to the regex below
	}
	const pattern = new RegExp(
		`"${escapeRegExp(name)}"\\s*:\\s*\\[?"?${escapeRegExp(name)}@([^",\\]]+)`,
	);
	return pattern.exec(text)?.[1] ?? null;
}

function pnpmVersion(text: string, name: string): string | null {
	const escaped = escapeRegExp(name);
	const packages = new RegExp(`^\\s+/?${escaped}@([^:\\s]+):`, "m").exec(text);
	if (packages) return packages[1];
	const importer = new RegExp(
		`^\\s+${escaped}:\\s*\\n\\s+specifier:[^\\n]*\\n\\s+version:\\s*([^\\n]+)`,
		"m",
	).exec(text);
	return importer?.[1].trim() ?? null;
}

function yarnVersion(text: string, name: string): string | null {
	const pattern = new RegExp(
		`^"?${escapeRegExp(name)}@[^"\\n]*"?:(?:\\r?\\n)\\s+version "?([^"\\s]+)"?`,
		"m",
	);
	return pattern.exec(text)?.[1] ?? null;
}

/** Resolve one package version from a lockfile body (precedence is the caller's). */
export function resolveLockVersion(
	lockText: string,
	kind: LockKind,
	name: string,
): PackageFact {
	const version =
		kind === "bun"
			? bunVersion(lockText, name)
			: kind === "npm"
				? npmVersion(lockText, name)
				: kind === "pnpm"
					? pnpmVersion(lockText, name)
					: yarnVersion(lockText, name);
	return version
		? { name, version, versionUnknown: false, kind: "dependency" }
		: { name, version: null, versionUnknown: true, kind: "dependency" };
}

async function readManifest(
	input: FactsInput,
	deps: FactsDeps,
): Promise<unknown | null> {
	if (!input.nearestManifestPath) return null;
	try {
		const parsed: unknown = JSON.parse(
			await deps.readFile(input.nearestManifestPath),
		);
		return isRecord(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

function manifestDir(input: FactsInput): string | null {
	if (!input.nearestManifestPath) return null;
	return path.dirname(input.nearestManifestPath);
}

/** First lockfile in precedence order at the nearest manifest, then workspace root. */
function findLockfile(
	input: FactsInput,
	deps: FactsDeps,
): { abs: string; kind: LockKind } | null {
	const dirs = [manifestDir(input), input.workspaceRoot].filter(
		(dir): dir is string => typeof dir === "string" && dir.length > 0,
	);
	for (const dir of [...new Set(dirs)]) {
		for (const candidate of LOCKFILES) {
			const abs = path.join(dir, candidate.name);
			try {
				if (deps.exists(abs)) return { abs, kind: candidate.kind };
			} catch {
				// unreadable probe: skip
			}
		}
	}
	return null;
}

async function resolveVersions(
	facts: PackageFact[],
	input: FactsInput,
	deps: FactsDeps,
): Promise<PackageFact[]> {
	const lock = findLockfile(input, deps);
	if (!lock) return facts;
	let text: string;
	try {
		text = await deps.readFile(lock.abs);
	} catch {
		return facts;
	}
	return facts.map((fact) => {
		if (!fact.versionUnknown && fact.version !== null) return fact;
		const resolved = resolveLockVersion(text, lock.kind, fact.name);
		return resolved.version
			? { ...fact, version: resolved.version, versionUnknown: false }
			: fact;
	});
}

function toAbsolute(input: FactsInput, file: string): string {
	return path.resolve(input.workspaceRoot ?? "", file);
}

function declaredFileList(
	input: FactsInput,
	deps: FactsDeps,
): DeclaredFile[] {
	return input.declaredFiles.map((file) => {
		try {
			return { path: file, exists: deps.exists(toAbsolute(input, file)) };
		} catch {
			return { path: file, exists: false };
		}
	});
}

async function plannedFacts(
	input: FactsInput,
	manifestFacts: PackageFact[],
): Promise<PackageFact[]> {
	const byName = new Map(manifestFacts.map((fact) => [fact.name, fact]));
	return parsePlannedPackages(input.unitText).map(
		(name) =>
			byName.get(name) ?? {
				name,
				version: null,
				versionUnknown: true,
				kind: "dependency" as const,
			},
	);
}

async function observedFacts(
	input: FactsInput,
	deps: FactsDeps,
	declaredFiles: DeclaredFile[],
	manifestFacts: PackageFact[],
): Promise<PackageFact[]> {
	const readable = declaredFiles.filter((file) => file.exists);
	if (readable.length === 0) return plannedFacts(input, manifestFacts);
	const manifestNames = new Set(manifestFacts.map((fact) => fact.name));
	const byName = new Map(manifestFacts.map((fact) => [fact.name, fact]));
	const names = new Set<string>();
	const ambiguous = new Map<string, PackageFact>();
	for (const file of readable) {
		let text: string;
		try {
			text = await deps.readFile(toAbsolute(input, file.path));
		} catch {
			continue;
		}
		for (const specifier of extractExternalSpecifiers(text)) {
			const classified = classifySpecifier(specifier);
			if (classified.ambiguous) {
				ambiguous.set("(ambiguous)", {
					name: "(ambiguous)",
					version: null,
					versionUnknown: true,
					kind: "ambiguous",
				});
				continue;
			}
			if (!classified.external || !classified.name) continue;
			if (manifestNames.has(classified.name) || classified.name.startsWith("@")) {
				names.add(classified.name);
			}
		}
	}
	const facts = [...names].sort().map(
		(name) =>
			byName.get(name) ?? {
				name,
				version: null,
				versionUnknown: true,
				kind: "dynamic" as const,
			},
	);
	return [...facts, ...ambiguous.values()];
}

function collectEvidence(
	unitText: string,
	packages: PackageFact[],
): UnitFacts["evidence"] {
	const evidence: UnitFacts["evidence"] = [];
	for (const line of parseEvidenceLines(unitText)) {
		for (const fact of packages) {
			const validated = validateEvidenceLine(line, fact);
			if (validated) evidence.push(validated);
		}
	}
	return evidence;
}

/** Deterministic facts for one unit in the requested phase (R2). */
export async function buildFacts(
	input: FactsInput,
	deps: FactsDeps,
): Promise<UnitFacts> {
	const declaredFiles = declaredFileList(input, deps);
	const manifest = await readManifest(input, deps);
	const manifestFacts = manifest
		? parseManifestDeps(manifest, isToolingUnit(input.unitText))
		: [];
	const base =
		input.phase === "observed"
			? await observedFacts(input, deps, declaredFiles, manifestFacts)
			: await plannedFacts(input, manifestFacts);
	const packages = await resolveVersions(base, input, deps);
	return {
		phase: input.phase,
		declaredFiles,
		packages,
		evidence: collectEvidence(input.unitText, packages),
		versionUnknown: packages.some((fact) => fact.versionUnknown),
	};
}

/** Nearest `package.json` walking up from each declared file, then repo root. */
export function nearestManifest(
	repoRoot: string,
	declaredFiles: string[],
	probe: (absPath: string) => boolean,
): string | null {
	const candidates: string[] = [];
	for (const file of declaredFiles) {
		let dir = path.dirname(path.resolve(repoRoot, file));
		while (dir.startsWith(repoRoot) && dir !== repoRoot) {
			candidates.push(path.join(dir, "package.json"));
			const parent = path.dirname(dir);
			if (parent === dir) break;
			dir = parent;
		}
	}
	candidates.push(path.join(repoRoot, "package.json"));
	for (const candidate of [...new Set(candidates)]) {
		try {
			if (probe(candidate)) return candidate;
		} catch {
			// unreadable probe: skip
		}
	}
	return null;
}

/** Content hashes of existing declared files at the observed phase. */
export async function observedFileHashes(
	repoRoot: string,
	facts: UnitFacts,
	read: (absPath: string) => Promise<string>,
): Promise<Map<string, string>> {
	const hashes = new Map<string, string>();
	if (facts.phase !== "observed") return hashes;
	for (const file of facts.declaredFiles) {
		if (!file.exists) continue;
		try {
			const content = await read(path.resolve(repoRoot, file.path));
			hashes.set(
				file.path,
				createHash("sha256").update(content).digest("hex").slice(0, 16),
			);
		} catch {
			// unreadable declared file: skip its hash
		}
	}
	return hashes;
}

/**
 * Recompute the same per-unit content hashes the guard persists, so the
 * stage-gate obligation check can detect a stale record via `isRecordFresh`
 * without calling Jev (R7).
 */
export async function computePlanUnitHashes(
	scope: { repoRoot: string; phase: DocsPhase; planText: string },
	deps: FactsDeps,
): Promise<Map<string, string>> {
	const units = extractUnits(scope.planText, scope.phase);
	const hashes = new Map<string, string>();
	for (const unit of units) {
		const facts = await buildFacts(
			{
				phase: scope.phase,
				unitText: unit.text,
				declaredFiles: unit.files,
				nearestManifestPath: nearestManifest(
					scope.repoRoot,
					unit.files,
					deps.exists,
				),
				workspaceRoot: scope.repoRoot,
			},
			deps,
		);
		const observed = await observedFileHashes(scope.repoRoot, facts, deps.readFile);
		hashes.set(unit.slug, unitContentHash(unit, facts, observed));
	}
	return hashes;
}

/** Facts + content hash for one unit; shared by the guard and the hash sweep. */
export async function buildUnitPlanFacts(
	unit: DocsUnit,
	scope: { repoRoot: string; phase: DocsPhase },
	deps: FactsDeps,
): Promise<{ facts: UnitFacts; hash: string }> {
	const facts = await buildFacts(
		{
			phase: scope.phase,
			unitText: unit.text,
			declaredFiles: unit.files,
			nearestManifestPath: nearestManifest(scope.repoRoot, unit.files, deps.exists),
			workspaceRoot: scope.repoRoot,
		},
		deps,
	);
	const observed = await observedFileHashes(scope.repoRoot, facts, deps.readFile);
	return { facts, hash: unitContentHash(unit, facts, observed) };
}
