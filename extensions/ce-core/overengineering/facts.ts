// Deterministic complexity facts extraction (plan Unit 3). Pure parsing over a
// bounded `git diff` plus guarded untracked-file reads. The git runner is
// injected so tests never spawn a process; production uses `createGitRunner`.
// Never throws: a git failure degrades to empty facts plus a skip reason.
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { builtinModules } from "node:module";
import path from "node:path";
import { promisify } from "node:util";
import { canonicalRel, isEscapingSymlink, isInside } from "../utils/repo-paths";
import { truncateUtf8ToBytes } from "../utils/solution-recall";
import type {
	OverengineeringFacts,
	OverengineeringSkip,
	ProtectedComplexityTag,
} from "./types";
import { OVERENGINEERING_DIMENSION_IDS } from "./types";

const execFileAsync = promisify(execFile);

const MAX_LIST = 50;
const DIFF_HEAD_BYTES = 1536;
const DIFF_TAIL_BYTES = 512;
const DIFF_GLOBAL_CAP = 6144;
const MAX_UNTRACKED_FILES = 32;
const MAX_UNTRACKED_BYTES = 256 * 1024;
const BINARY_SNIFF_BYTES = 8000;
const MAX_MANIFESTS = 8;

const DEP_FIELDS = [
	"dependencies",
	"devDependencies",
	"peerDependencies",
	"optionalDependencies",
];

/** Keys that appear in `package.json` but are not dependency declarations. */
const NON_DEP_KEYS = new Set([
	"name",
	"version",
	"private",
	"type",
	"main",
	"module",
	"types",
	"typings",
	"exports",
	"imports",
	"scripts",
	"description",
	"license",
	"author",
	"contributors",
	"repository",
	"homepage",
	"bugs",
	"keywords",
	"engines",
	"files",
	"workspaces",
	"publishConfig",
	"pi",
	"peerDependenciesMeta",
	"packageManager",
]);

const DENY_EXTENSIONS = new Set([
	".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bmp", ".svg",
	".zip", ".gz", ".tgz", ".tar", ".rar", ".7z", ".woff", ".woff2",
	".ttf", ".eot", ".otf", ".lock", ".pdf", ".mp4", ".mp3", ".wasm",
]);

const SECRET_SOURCE =
	"PRIVATE KEY|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{20,}";

const PROTECTED_RULES: ReadonlyArray<{
	tag: ProtectedComplexityTag;
	pattern: RegExp;
}> = [
	{ tag: "tests", pattern: /(?:^|\/)(?:tests?)\/|\.(?:test|spec)\.[jt]sx?$/i },
	{
		tag: "security",
		pattern: /auth|security|credential|token|secret|permission|crypto/i,
	},
	{ tag: "validation", pattern: /validat|schema|sanitiz|parse|zod/i },
	{ tag: "observability", pattern: /logg|metric|trace|telemetry|audit/i },
	{ tag: "migration", pattern: /migrat|schema\.sql|version/i },
	{
		tag: "error_handling",
		pattern: /errors?\.[jt]s$|(?:^|[^\w])throw\b|(?:^|[^\w])catch\b|\bError\b/,
	},
];

/** Injected git runner: returns stdout for the argv, rejects on failure. */
export type GitRunner = (args: string[]) => Promise<string>;

export interface PackageJsonFile {
	path: string;
	text: string;
}

export interface ExtractFactsInput {
	repoRoot: string;
	runGit: GitRunner;
	/** Test/override seam; when absent, `runGit` supplies it. */
	diffText?: string;
	untrackedFiles?: string[];
	/** Test/override seam for the manifest reads. */
	packageJsons?: PackageJsonFile[];
}

/** Production git runner: bounded argv, cwd, and timeout (plan Unit 3). */
export function createGitRunner(repoRoot: string): GitRunner {
	return async (args) => {
		const { stdout } = await execFileAsync("git", args, {
			cwd: repoRoot,
			timeout: 2000,
			maxBuffer: 8 * 1024 * 1024,
		});
		return stdout;
	};
}

/** Node/Bun built-in module names in bare and `node:` forms (runtime-derived). */
export function stdlibCapabilities(): Set<string> {
	const caps = new Set<string>();
	const add = (name: string): void => {
		const bare = name.replace(/^node:/, "");
		caps.add(bare);
		caps.add(`node:${bare}`);
	};
	for (const name of builtinModules) add(name);
	// ponytail: Bun injects `bun`/`bun:*` builtins that `node:module` may not
	// always list; treat them as stdlib so they are never flagged as dependencies.
	add("bun");
	add("bun:test");
	return caps;
}

/** True when a line looks like a private key or provider token. */
export function isSecretShaped(line: string): boolean {
	return new RegExp(SECRET_SOURCE).test(line);
}

/** Replace secret-shaped spans with `[REDACTED]` before excerpting. */
export function redactSecrets(text: string): string {
	return text.replace(new RegExp(SECRET_SOURCE, "g"), "[REDACTED]");
}

/** Context-only protected-category tags (never an automatic pass). */
export function tagProtectedComplexity(
	paths: string[],
	addedLines: string[],
): ProtectedComplexityTag[] {
	// ponytail: one joined haystack — the six categories are independent and the
	// per-token locations do not matter for the "context only" judgment.
	const haystack = [...paths, ...addedLines].join("\n");
	const tags: ProtectedComplexityTag[] = [];
	for (const rule of PROTECTED_RULES) {
		if (rule.pattern.test(haystack)) tags.push(rule.tag);
	}
	return tags;
}

interface ParsedDiff {
	files: string[];
	added: Map<string, string[]>;
}

function registerAddedFile(
	files: string[],
	added: Map<string, string[]>,
	target: string,
): string | null {
	if (target === "/dev/null") return null;
	if (!added.has(target)) {
		added.set(target, []);
		files.push(target);
	}
	return target;
}

function parseDiff(diffText: string): ParsedDiff {
	const files: string[] = [];
	const added = new Map<string, string[]>();
	let current: string | null = null;
	for (const line of diffText.split("\n")) {
		const plus = line.match(/^\+\+\+ b\/(.+)$/);
		if (plus) {
			current = registerAddedFile(files, added, plus[1]);
			continue;
		}
		if (line.startsWith("+++")) {
			current = null;
			continue;
		}
		if (line.startsWith("+") && current) added.get(current)?.push(line.slice(1));
	}
	return { files, added };
}

function isManifest(relPath: string): boolean {
	return /(?:^|\/)package\.json$/.test(relPath);
}

function isCodeFile(relPath: string): boolean {
	return /\.[cm]?[jt]sx?$/.test(relPath);
}

function specifierOf(line: string): string | null {
	const trimmed = line.trim();
	const from = trimmed.match(
		/^(?:import|export)\b.*?\bfrom\s+["']([^"']+)["']/,
	);
	if (from) return from[1];
	const bare = trimmed.match(/^import\s+["']([^"']+)["']/);
	if (bare) return bare[1];
	const required = trimmed.match(/require\(\s*["']([^"']+)["']\s*\)/);
	if (required) return required[1];
	const dynamic = trimmed.match(/import\(\s*["']([^"']+)["']\s*\)/);
	return dynamic ? dynamic[1] : null;
}

/** Package name of a bare specifier; null for relative paths and stdlib. */
function externalName(specifier: string, stdlib: Set<string>): string | null {
	if (specifier.startsWith(".") || specifier.startsWith("/")) return null;
	if (stdlib.has(specifier)) return null;
	const segments = specifier.split("/");
	return specifier.startsWith("@") && segments.length >= 2
		? `${segments[0]}/${segments[1]}`
		: segments[0];
}

function isDiffAddedExport(line: string): boolean {
	return /^(?:import|export)\b/.test(line.trim());
}

function capList(
	values: string[],
	cap = MAX_LIST,
): { values: string[]; omitted: number } {
	const unique = [...new Set(values)].sort();
	return { values: unique.slice(0, cap), omitted: Math.max(0, unique.length - cap) };
}

export function emptyOverengineeringFacts(
	skippedDimensions: OverengineeringSkip[],
): OverengineeringFacts {
	return {
		newDependencies: [],
		addedFiles: [],
		addedImportsExports: [],
		diffBytes: 0,
		diffExcerptBytes: 0,
		diffExcerpt: "",
		protectedComplexity: [],
		skippedDimensions,
		truncated: {
			addedFiles: 0,
			newDependencies: 0,
			addedImportsExports: 0,
			untrackedSkipped: 0,
		},
	};
}

function splitUtf8HeadTail(text: string, head: number, tail: number): string {
	const buffer = Buffer.from(text, "utf8");
	const total = buffer.byteLength;
	if (total <= head + tail) return text;
	let headEnd = Math.min(head, total);
	while (headEnd > 0 && (buffer[headEnd] & 0xc0) === 0x80) headEnd--;
	let tailStart = Math.max(0, total - tail);
	while (tailStart < total && (buffer[tailStart] & 0xc0) === 0x80) tailStart++;
	const omitted = tailStart - headEnd;
	return (
		buffer.subarray(0, headEnd).toString("utf8") +
		`…[truncated ${omitted} bytes]` +
		buffer.subarray(tailStart).toString("utf8")
	);
}

function splitDiffSections(diffText: string): Array<{ key: string; text: string }> {
	const sections: Array<{ key: string; text: string }> = [];
	let key = "";
	let lines: string[] | null = null;
	const flush = (): void => {
		if (lines) sections.push({ key, text: lines.join("\n") });
	};
	for (const line of diffText.split("\n")) {
		const git = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
		if (git) {
			flush();
			key = git[2];
			lines = [line];
			continue;
		}
		if (!lines) continue;
		lines.push(line);
		const plus = line.match(/^\+\+\+ b\/(.+)$/);
		if (plus) key = plus[1];
	}
	flush();
	return sections;
}

/**
 * Head+tail excerpt per changed file, sorted by path, secret-redacted, then
 * bounded by the global 6 KiB cap. Deterministic and pure.
 */
export function excerptDiff(diffText: string, capBytes = DIFF_GLOBAL_CAP): string {
	if (diffText.length === 0) return "";
	const sections = splitDiffSections(diffText).sort((a, b) =>
		a.key.localeCompare(b.key),
	);
	const joined = sections
		.map((section) =>
			splitUtf8HeadTail(section.text, DIFF_HEAD_BYTES, DIFF_TAIL_BYTES),
		)
		.join("\n");
	return redactSecrets(truncateUtf8ToBytes(joined, capBytes));
}

async function tryRead(abs: string): Promise<string | null> {
	try {
		return await fs.readFile(abs, "utf8");
	} catch {
		return null;
	}
}

function skipUnreadableManifest(skipped: OverengineeringSkip[]): void {
	skipped.push({
		dimension: "dependency_justification",
		reason: "package_json_unreadable",
	});
}

async function readWorkspaceManifests(
	repoRoot: string,
	manifests: PackageJsonFile[],
	skipped: OverengineeringSkip[],
): Promise<void> {
	for (const parent of ["packages", "extensions"]) {
		let entries;
		try {
			entries = await fs.readdir(path.join(repoRoot, parent), {
				withFileTypes: true,
			});
		} catch {
			continue;
		}
		for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
			if (manifests.length >= MAX_MANIFESTS) return;
			if (!entry.isDirectory()) continue;
			const rel = `${parent}/${entry.name}/package.json`;
			const text = await tryRead(path.join(repoRoot, rel));
			if (text === null) {
				skipUnreadableManifest(skipped);
				continue;
			}
			manifests.push({ path: rel, text });
		}
	}
}

async function readManifests(
	repoRoot: string,
	skipped: OverengineeringSkip[],
): Promise<PackageJsonFile[]> {
	const manifests: PackageJsonFile[] = [];
	const rootText = await tryRead(path.join(repoRoot, "package.json"));
	if (rootText === null) skipUnreadableManifest(skipped);
	else manifests.push({ path: "package.json", text: rootText });
	await readWorkspaceManifests(repoRoot, manifests, skipped);
	return manifests;
}

function declaredDependencies(manifests: PackageJsonFile[]): Set<string> {
	const names = new Set<string>();
	for (const manifest of manifests) {
		let parsed: Record<string, unknown>;
		try {
			parsed = JSON.parse(manifest.text) as Record<string, unknown>;
		} catch {
			continue;
		}
		for (const field of DEP_FIELDS) {
			const value = parsed?.[field];
			if (value && typeof value === "object" && !Array.isArray(value)) {
				for (const name of Object.keys(value)) names.add(name);
			}
		}
	}
	return names;
}

function manifestDependencies(addedLines: string[]): string[] {
	const names: string[] = [];
	for (const line of addedLines) {
		const match = line.match(/^\s*"([^"]+)"\s*:\s*"/);
		if (match && !NON_DEP_KEYS.has(match[1])) names.push(match[1]);
	}
	return names;
}

function isDeniedUntracked(rel: string): boolean {
	if (rel.split("/").includes("node_modules")) return true;
	if (/\.min\.(?:js|css)$/.test(rel)) return true;
	return DENY_EXTENSIONS.has(path.extname(rel).toLowerCase());
}

interface UntrackedRead {
	path: string;
	text: string;
}

async function readUntracked(
	repoRoot: string,
	untracked: string[],
): Promise<{ files: UntrackedRead[]; skipped: number }> {
	const files: UntrackedRead[] = [];
	let skipped = 0;
	for (const rel of [...untracked].sort().slice(0, MAX_UNTRACKED_FILES)) {
		if (isDeniedUntracked(rel)) {
			skipped++;
			continue;
		}
		const abs = path.resolve(repoRoot, rel);
		const canonical = canonicalRel(repoRoot, abs);
		if (!isInside(canonical) || (await isEscapingSymlink(repoRoot, abs))) {
			skipped++;
			continue;
		}
		let buffer: Buffer;
		try {
			buffer = await fs.readFile(abs);
		} catch {
			skipped++;
			continue;
		}
		if (
			buffer.byteLength > MAX_UNTRACKED_BYTES ||
			buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0)
		) {
			skipped++;
			continue;
		}
		files.push({ path: rel, text: buffer.toString("utf8") });
	}
	return { files, skipped };
}

// ponytail: no diff means no dimension is judgeable — skip all four so the
// composer's all-skipped rule returns `unavailable`.
function gitFailureFacts(): OverengineeringFacts {
	return emptyOverengineeringFacts(
		OVERENGINEERING_DIMENSION_IDS.map((dimension) => ({
			dimension,
			reason: "git_unavailable" as const,
		})),
	);
}

async function readUntrackedList(runGit: GitRunner): Promise<string[]> {
	try {
		return (await runGit(["ls-files", "--others", "--exclude-standard"]))
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.length > 0);
	} catch {
		return [];
	}
}

function manifestAddedDependencies(parsed: ParsedDiff): string[] {
	const lines = [...parsed.added.entries()]
		.filter(([rel]) => isManifest(rel))
		.flatMap(([, added]) => added);
	return manifestDependencies(lines);
}

interface CodeContext {
	stdlib: Set<string>;
	declared: Set<string>;
}

/** Collect import/export evidence plus undeclared external specifiers. */
function collectCodeFacts(
	rel: string,
	lines: string[],
	context: CodeContext,
	dependencies: string[],
	importsExports: string[],
): void {
	if (!isCodeFile(rel)) return;
	for (const line of lines) {
		if (isDiffAddedExport(line)) {
			importsExports.push(`${rel}:${redactSecrets(line.trim())}`);
		}
		const specifier = specifierOf(line);
		if (!specifier) continue;
		const name = externalName(specifier, context.stdlib);
		if (name && !context.declared.has(name)) dependencies.push(name);
	}
}

/**
 * Extract deterministic complexity facts. Never throws; a git failure or an
 * unreadable manifest degrades to empty context plus a recorded skip reason.
 */
export async function extractComplexityFacts(
	input: ExtractFactsInput,
): Promise<OverengineeringFacts> {
	const skipped: OverengineeringSkip[] = [];
	let diffText = input.diffText;
	if (diffText === undefined) {
		try {
			diffText = await input.runGit(["diff", "--no-color", "--unified=0", "HEAD"]);
		} catch {
			return gitFailureFacts();
		}
	}
	const untracked = input.untrackedFiles ?? (await readUntrackedList(input.runGit));

	const parsed = parseDiff(diffText);
	const stdlib = stdlibCapabilities();
	const manifests =
		input.packageJsons ?? (await readManifests(input.repoRoot, skipped));
	const declared = declaredDependencies(manifests);
	const dependencies = manifestAddedDependencies(parsed);
	const importsExports: string[] = [];
	const files = [...parsed.files];
	const context = { stdlib, declared };
	for (const [rel, lines] of parsed.added) {
		collectCodeFacts(rel, lines, context, dependencies, importsExports);
	}

	const { files: untrackedFiles, skipped: untrackedSkipped } = await readUntracked(
		input.repoRoot,
		untracked,
	);
	for (const file of untrackedFiles) {
		files.push(file.path);
		collectCodeFacts(
			file.path,
			file.text.split("\n"),
			context,
			dependencies,
			importsExports,
		);
	}

	const addedFiles = capList(files);
	const newDependencies = capList(dependencies);
	const addedImportsExports = capList(importsExports);
	const excerpt = excerptDiff(diffText);
	return {
		newDependencies: newDependencies.values,
		addedFiles: addedFiles.values,
		addedImportsExports: addedImportsExports.values,
		diffBytes: Buffer.byteLength(diffText, "utf8"),
		diffExcerptBytes: Buffer.byteLength(excerpt, "utf8"),
		diffExcerpt: excerpt,
		protectedComplexity: tagProtectedComplexity(addedFiles.values, [
			...parsed.added.values(),
		].flat()),
		skippedDimensions: skipped,
		truncated: {
			addedFiles: addedFiles.omitted,
			newDependencies: newDependencies.omitted,
			addedImportsExports: addedImportsExports.omitted,
			untrackedSkipped,
		},
	};
}
