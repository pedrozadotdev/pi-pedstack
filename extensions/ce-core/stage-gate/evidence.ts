// Artifact resolution, best-effort evidence gathering, and content hashing
// (plan Unit 2). All reads are resilient: a bad file is recorded, never thrown.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { getStageRubric } from "./rubrics";
import type {
	CheckpointRecord,
	Evidence,
	EvidenceFile,
	ReviewFinding,
	ReviewFindingsFile,
	StageKey,
	StageRubric,
} from "./types";

const MAX_FILE_BYTES = 64 * 1024;
const MAX_TOTAL_BYTES = 48 * 1024;

const CONTEXT_DIR = ".context/compound-engineering";
const CHECKPOINTS_DIR = `${CONTEXT_DIR}/checkpoints`;
const REVIEW_FINDINGS_DIR = `${CONTEXT_DIR}/review-findings`;

export interface ArtifactResolution {
	paths: string[];
	warnings: string[];
}

export interface GatherEvidenceOptions {
	repoRoot: string;
	stage: StageKey;
	hint?: string[];
	gitDiff?: string | null;
}

/** Canonical repo-relative POSIX path (backslashes normalized, `.`/`..` collapsed). */
function canonicalRel(repoRoot: string, raw: string): string {
	const normalized = raw.replace(/\\/g, "/");
	return path.relative(repoRoot, path.resolve(repoRoot, normalized)).replace(/\\/g, "/");
}

function toPosix(value: string): string {
	return value.split(path.sep).join("/");
}

function isInside(rel: string): boolean {
	return rel !== "" && !rel.startsWith("../") && !path.isAbsolute(rel);
}

/** Converts a glob with `*` (single segment) and `**` (recursive) to a RegExp. */
function globToRegExp(glob: string): RegExp {
	let source = "";
	for (let index = 0; index < glob.length; index++) {
		const char = glob[index];
		if (char === "*") {
			if (glob[index + 1] === "*") {
				index++;
				if (glob[index + 1] === "/") {
					index++;
					source += "(?:.*/)?";
				} else {
					source += ".*";
				}
			} else {
				source += "[^/]*";
			}
			continue;
		}
		source += /[\\^$+.()|{}[\]]/.test(char) ? `\\${char}` : char;
	}
	return new RegExp(`^${source}$`);
}

/** Static directory prefix of a glob, used to bound the filesystem walk. */
function globBase(glob: string): string {
	const wildcard = glob.indexOf("*");
	const staticPart = wildcard === -1 ? glob : glob.slice(0, wildcard);
	const slash = staticPart.lastIndexOf("/");
	return slash === -1 ? "" : staticPart.slice(0, slash);
}

async function listFilesRecursive(dir: string): Promise<string[]> {
	let entries;
	try {
		entries = await fs.readdir(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	const files: string[] = [];
	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		const abs = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			files.push(...(await listFilesRecursive(abs)));
		} else if (entry.isFile() || entry.isSymbolicLink()) {
			try {
				const stat = await fs.stat(abs);
				if (stat.isFile()) files.push(abs);
			} catch {
				// unreadable entry: skip
			}
		}
	}
	return files;
}

function allowedPrefixes(rubric: StageRubric): string[] {
	const bases = new Set<string>();
	for (const glob of rubric.artifactGlobs) bases.add(globBase(glob));
	bases.add(rubric.artifactDir);
	return [...bases].filter((base) => base.length > 0).map((base) => `${base}/`);
}

async function isEscapingSymlink(repoRoot: string, abs: string): Promise<boolean> {
	try {
		const real = await fs.realpath(abs);
		return !isInside(canonicalRel(repoRoot, real));
	} catch {
		return true;
	}
}

async function resolveViaGlobs(repoRoot: string, rubric: StageRubric): Promise<string[]> {
	const matchers = rubric.artifactGlobs.map(globToRegExp);
	const bases = new Set(rubric.artifactGlobs.map(globBase));
	const found = new Set<string>();
	for (const base of bases) {
		const files = await listFilesRecursive(path.join(repoRoot, base));
		for (const abs of files) {
			const rel = canonicalRel(repoRoot, toPosix(abs));
			if (!isInside(rel)) continue;
			if (!matchers.some((matcher) => matcher.test(rel))) continue;
			if (await isEscapingSymlink(repoRoot, abs)) continue;
			found.add(rel);
		}
	}
	return [...found].sort();
}

async function resolveFallback(repoRoot: string, rubric: StageRubric): Promise<string[]> {
	const files = await listFilesRecursive(path.join(repoRoot, rubric.artifactDir));
	const candidates: Array<{ rel: string; mtimeMs: number }> = [];
	for (const abs of files) {
		const rel = canonicalRel(repoRoot, toPosix(abs));
		if (!isInside(rel)) continue;
		try {
			const stat = await fs.stat(abs);
			candidates.push({ rel, mtimeMs: stat.mtimeMs });
		} catch {
			// unreadable: skip
		}
	}
	if (candidates.length === 0) return [];
	candidates.sort((a, b) =>
		b.mtimeMs - a.mtimeMs !== 0 ? b.mtimeMs - a.mtimeMs : b.rel.localeCompare(a.rel),
	);
	return [candidates[0].rel];
}

async function validateHint(
	repoRoot: string,
	hint: string[],
	prefixes: string[],
): Promise<string[] | null> {
	const resolved: string[] = [];
	for (const raw of hint) {
		if (typeof raw !== "string" || raw.trim().length === 0) return null;
		let real: string;
		try {
			real = await fs.realpath(path.resolve(repoRoot, raw.replace(/\\/g, "/")));
		} catch {
			return null;
		}
		const rel = canonicalRel(repoRoot, toPosix(real));
		if (!isInside(rel)) return null;
		if (!prefixes.some((prefix) => rel.startsWith(prefix))) return null;
		try {
			const stat = await fs.stat(real);
			if (!stat.isFile()) return null;
		} catch {
			return null;
		}
		resolved.push(rel);
	}
	return resolved;
}

/**
 * Resolves the scored artifact set. A valid `hint` replaces the declared globs;
 * an invalid hint is rejected and the globs (then the stage-dir fallback) run.
 */
export async function resolveArtifactPaths(
	repoRoot: string,
	stage: StageKey,
	hint?: string[],
): Promise<ArtifactResolution> {
	const rubric = getStageRubric(stage);
	const warnings: string[] = [];
	if (Array.isArray(hint) && hint.length > 0) {
		const validated = await validateHint(repoRoot, hint, allowedPrefixes(rubric));
		if (validated) return { paths: [...new Set(validated)].sort(), warnings };
		warnings.push(
			"artifactPaths hint rejected (outside the repo or the stage's declared dir); using declared globs",
		);
	}
	const globbed = await resolveViaGlobs(repoRoot, rubric);
	if (globbed.length > 0) return { paths: globbed, warnings };
	return { paths: await resolveFallback(repoRoot, rubric), warnings };
}

/**
 * SHA-256 over a canonical manifest of full file bytes. Missing declared files
 * are excluded; an empty set hashes `sha256("")`.
 */
export async function computeArtifactsHash(
	repoRoot: string,
	paths: string[],
): Promise<string> {
	const canonical = new Map<string, string>();
	for (const raw of paths) {
		const rel = canonicalRel(repoRoot, raw);
		if (!isInside(rel)) continue;
		canonical.set(rel, path.resolve(repoRoot, rel));
	}
	const manifest: string[] = [];
	for (const rel of [...canonical.keys()].sort()) {
		let bytes: Buffer;
		try {
			bytes = await fs.readFile(canonical.get(rel) as string);
		} catch {
			continue;
		}
		const fileHash = createHash("sha256").update(bytes).digest("hex");
		manifest.push(`${rel}\0${bytes.byteLength}\0${fileHash}\n`);
	}
	return createHash("sha256").update(manifest.join("")).digest("hex");
}

async function readJson(abs: string): Promise<unknown | null> {
	try {
		return JSON.parse(await fs.readFile(abs, "utf8"));
	} catch {
		return null;
	}
}

async function readArtifactFiles(
	repoRoot: string,
	paths: string[],
	errors: string[],
): Promise<{ files: EvidenceFile[]; txt: string; truncated: boolean }> {
	const files: EvidenceFile[] = [];
	const parts: string[] = [];
	let remaining = MAX_TOTAL_BYTES;
	let truncated = false;
	for (const rel of paths) {
		let buffer: Buffer;
		try {
			buffer = await fs.readFile(path.join(repoRoot, rel));
		} catch {
			errors.push(`could not read artifact: ${rel}`);
			continue;
		}
		const separator = parts.length > 0 ? 1 : 0;
		const cap = Math.min(MAX_FILE_BYTES, Math.max(0, remaining - separator));
		if (buffer.byteLength > cap) truncated = true;
		const text = buffer.subarray(0, cap).toString("utf8");
		const textBytes = Buffer.byteLength(text, "utf8");
		remaining = Math.max(0, remaining - separator - textBytes);
		parts.push(text);
		files.push({ path: rel, text, bytes: buffer.byteLength });
	}
	return { files, txt: parts.join("\n"), truncated };
}

async function readContextState(
	repoRoot: string,
	warnings: string[],
): Promise<Record<string, unknown> | null> {
	const abs = path.join(repoRoot, CONTEXT_DIR, "context-state.json");
	try {
		await fs.stat(abs);
	} catch {
		return null;
	}
	const parsed = await readJson(abs);
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		warnings.push("context-state.json is missing or corrupt");
		return null;
	}
	return parsed as Record<string, unknown>;
}

async function readCheckpoints(repoRoot: string): Promise<CheckpointRecord[]> {
	const dir = path.join(repoRoot, CHECKPOINTS_DIR);
	const records: CheckpointRecord[] = [];
	for (const abs of await listFilesRecursive(dir)) {
		if (!abs.endsWith(".json")) continue;
		const parsed = await readJson(abs);
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue;
		const rel = canonicalRel(repoRoot, toPosix(abs));
		records.push({ ...(parsed as Record<string, unknown>), path: rel });
	}
	return records;
}

async function readReviewFindings(
	repoRoot: string,
	rubric: StageRubric,
): Promise<ReviewFindingsFile[]> {
	if (!rubric.findingsGlob) return [];
	const matcher = globToRegExp(rubric.findingsGlob);
	const files: ReviewFindingsFile[] = [];
	for (const abs of await listFilesRecursive(path.join(repoRoot, REVIEW_FINDINGS_DIR))) {
		const rel = canonicalRel(repoRoot, toPosix(abs));
		if (!matcher.test(path.posix.basename(rel))) continue;
		const parsed = await readJson(abs);
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue;
		const value = parsed as { findings?: unknown; count?: unknown };
		if (!Array.isArray(value.findings)) continue;
		files.push({
			path: rel,
			findings: value.findings as ReviewFinding[],
			count: typeof value.count === "number" ? value.count : undefined,
		});
	}
	return files;
}

async function newestTextIn(repoRoot: string, dir: string): Promise<string | null> {
	const files = await listFilesRecursive(path.join(repoRoot, dir));
	const md = files.filter((abs) => abs.endsWith(".md"));
	if (md.length === 0) return null;
	const stats = await Promise.all(
		md.map(async (abs) => ({ abs, mtimeMs: (await fs.stat(abs)).mtimeMs })),
	);
	stats.sort((a, b) =>
		b.mtimeMs - a.mtimeMs !== 0 ? b.mtimeMs - a.mtimeMs : b.abs.localeCompare(a.abs),
	);
	try {
		const buffer = await fs.readFile(stats[0].abs);
		return buffer.subarray(0, MAX_FILE_BYTES).toString("utf8");
	} catch {
		return null;
	}
}

/** Gathers every read the deterministic predicates and the Jev state need. */
export async function gatherEvidence(
	options: GatherEvidenceOptions,
): Promise<Evidence> {
	const { repoRoot, stage } = options;
	const rubric = getStageRubric(stage);
	const errors: string[] = [];
	const warnings: string[] = [];
	const resolved = await resolveArtifactPaths(repoRoot, stage, options.hint);
	warnings.push(...resolved.warnings);
	const { files, txt, truncated } = await readArtifactFiles(
		repoRoot,
		resolved.paths,
		errors,
	);
	return {
		stage,
		repoRoot,
		artifacts: resolved.paths,
		files,
		txt,
		errors,
		warnings,
		reviewFindings: await readReviewFindings(repoRoot, rubric),
		checkpoints: await readCheckpoints(repoRoot),
		contextState: await readContextState(repoRoot, warnings),
		planText: await newestTextIn(repoRoot, "docs/plans"),
		gitDiff: options.gitDiff ?? null,
		truncated,
	};
}
