import { readdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

/**
 * Pure deterministic recall for `docs/solutions/**`.
 *
 * Unit 1: tolerant frontmatter parser + keyword extraction (no I/O).
 * Unit 2: candidate enumeration + `prior` scoring.
 */

export interface ParsedFrontmatter {
	title: string;
	category: string;
	severity: string | null;
	tags: string[];
	applies_when: string[];
	malformed: boolean;
}

export interface SolutionCandidate {
	path: string;
	relPath: string;
	prior: number;
	malformed: boolean;
	frontmatter: ParsedFrontmatter;
}

const MAX_KEYWORDS = 24;
const DEFAULT_CANDIDATE_LIMIT = 15;
const BODY_FALLBACK_BYTES = 4096;
const MIN_FRONTMATTER_HITS = 3;

const SEVERITY_WEIGHTS: Record<string, number> = {
	critical: 1.0,
	high: 0.75,
	medium: 0.5,
	low: 0.25,
};

const PRIOR_SEVERITY_WEIGHT = 0.6;
const PRIOR_TAG_WEIGHT = 0.3;
const PRIOR_CATEGORY_WEIGHT = 0.1;

// ponytail: a small English stopword set is enough; the token cap (24) does the
// heavy lifting and the corpus is English-only.
const STOPWORDS = new Set([
	"the", "and", "for", "with", "that", "this", "from", "are", "was", "were",
	"has", "have", "had", "not", "but", "you", "your", "all", "any", "can",
	"will", "would", "should", "could", "into", "out", "use", "using", "over",
	"when", "where", "which", "what", "who", "how", "its", "via", "about",
	"above", "after", "again", "also", "because", "been", "before", "being",
	"below", "between", "both", "does", "doing", "down", "during", "each",
	"few", "further", "here", "more", "most", "only", "other", "same", "some",
	"such", "than", "then", "there", "these", "they", "those", "through",
	"under", "until", "very", "while", "been", "our", "their", "them", "itself",
]);

function emptyFrontmatter(malformed: boolean): ParsedFrontmatter {
	return {
		title: "",
		category: "",
		severity: null,
		tags: [],
		applies_when: [],
		malformed,
	};
}

function stripQuotes(value: string): string {
	const trimmed = value.trim();
	if (trimmed.length >= 2) {
		const first = trimmed[0];
		const last = trimmed[trimmed.length - 1];
		if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
			return trimmed.slice(1, -1).trim();
		}
	}
	return trimmed;
}

function parseInlineList(value: string): string[] {
	const inner = value.slice(1, -1);
	return inner
		.split(",")
		.map((item) => stripQuotes(item))
		.filter((item) => item.length > 0);
}

type ListKey = "tags" | "applies_when";

function parseListValue(value: string): string[] {
	if (value.startsWith("[") && value.endsWith("]")) return parseInlineList(value);
	return [stripQuotes(value)];
}

function findFrontmatterClose(lines: string[]): number {
	for (let i = 1; i < lines.length; i++) {
		if (lines[i].trim() === "---") return i;
	}
	return -1;
}

function applyListKey(
	result: ParsedFrontmatter,
	key: ListKey,
	value: string,
): ListKey | null {
	if (value === "") return key;
	result[key] = parseListValue(value);
	return null;
}

function applyScalarKey(
	result: ParsedFrontmatter,
	key: string,
	value: string,
): void {
	if (key === "title") result.title = stripQuotes(value);
	else if (key === "category") result.category = stripQuotes(value);
	else if (key === "severity") {
		result.severity = value === "" ? null : stripQuotes(value);
	}
}

/** Apply one frontmatter line; returns the active block-list key (if any). */
function applyFrontmatterLine(
	result: ParsedFrontmatter,
	currentListKey: ListKey | null,
	raw: string,
): ListKey | null {
	const trimmed = raw.trim();
	if (trimmed === "" || trimmed.startsWith("#")) return currentListKey;

	const listMatch = raw.match(/^\s+-\s*(.*)$/);
	if (listMatch && currentListKey) {
		const item = stripQuotes(listMatch[1]);
		if (item.length > 0) result[currentListKey].push(item);
		return currentListKey;
	}

	const kv = raw.match(/^([^:]+):(.*)$/);
	if (!kv) return null;
	const key = kv[1].trim().toLowerCase();
	const value = kv[2].trim();
	if (key === "tags" || key === "applies_when") {
		return applyListKey(result, key, value);
	}
	applyScalarKey(result, key, value);
	return null;
}

/**
 * Tolerant parser for the `docs/solutions` frontmatter subset. Never throws:
 * a missing or unterminated frontmatter block yields `malformed: true` with
 * empty fields.
 */
export function parseSolutionFrontmatter(content: string): ParsedFrontmatter {
	if (typeof content !== "string" || content.length === 0) {
		return emptyFrontmatter(true);
	}
	const normalized = content
		.replace(/^\uFEFF/, "")
		.replace(/\r\n/g, "\n");
	const lines = normalized.split("\n");
	if (lines[0]?.trim() !== "---") return emptyFrontmatter(true);

	const closeIndex = findFrontmatterClose(lines);
	if (closeIndex === -1) return emptyFrontmatter(true);

	const result = emptyFrontmatter(false);
	let currentListKey: ListKey | null = null;
	for (let i = 1; i < closeIndex; i++) {
		currentListKey = applyFrontmatterLine(result, currentListKey, lines[i]);
	}
	return result;
}

/** Lowercase, punctuation to spaces, whitespace-split. Keeps duplicates. */
function tokenStream(text: string): string[] {
	if (typeof text !== "string" || text.length === 0) return [];
	return text
		.toLowerCase()
		.replace(/[^a-z0-9\s]+/g, " ")
		.split(/\s+/);
}

function isMeaningfulToken(token: string): boolean {
	return token.length >= 3 && !STOPWORDS.has(token);
}

/** All meaningful tokens as a set (no cap) — used for tag/body matching. */
function tokenizeToSet(text: string): Set<string> {
	const set = new Set<string>();
	for (const token of tokenStream(text)) {
		if (isMeaningfulToken(token)) set.add(token);
	}
	return set;
}

/**
 * Deterministic query/tag tokenizer: lowercase, punctuation stripped, tokens
 * shorter than 3 chars and stopwords dropped, deduped, capped at 24.
 */
export function extractKeywords(text: string): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const token of tokenStream(text)) {
		if (!isMeaningfulToken(token) || seen.has(token)) continue;
		seen.add(token);
		result.push(token);
		if (result.length >= MAX_KEYWORDS) break;
	}
	return result;
}

function clamp01(value: number): number {
	return Math.max(0, Math.min(1, value));
}

function severityWeight(severity: string | null): number {
	if (!severity) return 0;
	return SEVERITY_WEIGHTS[severity.trim().toLowerCase()] ?? 0;
}

/** Tags tokenized with the same rules as query tokens so hyphenated tags match. */
function tagTokens(tags: string[]): Set<string> {
	const set = new Set<string>();
	for (const tag of tags) {
		for (const token of tokenizeToSet(tag)) set.add(token);
	}
	return set;
}

function frontmatterHitCount(
	frontmatter: ParsedFrontmatter,
	queryTokens: string[],
): number {
	const fields = [
		frontmatter.tags.join(" "),
		frontmatter.title,
		frontmatter.category,
		frontmatter.applies_when.join(" "),
	].join(" ");
	const tokens = tokenizeToSet(fields);
	let hits = 0;
	for (const token of queryTokens) {
		if (tokens.has(token)) hits++;
	}
	return hits;
}

/**
 * Deterministic `prior`:
 * `clamp01(0.60*severityWeight + 0.30*tagOverlapRatio + 0.10*categoryMatch)`.
 *
 * `bodyText` is the fallback body excerpt; it contributes overlapping query
 * tokens only when the frontmatter yields fewer than 3 hits. Passing it always
 * is harmless — the guard lives here.
 */
export function computePrior(
	frontmatter: ParsedFrontmatter,
	queryTokens: string[],
	bodyText?: string,
): number {
	if (frontmatter.malformed) return 0;

	const matchTokens = tagTokens(frontmatter.tags);
	if (
		bodyText !== undefined &&
		frontmatterHitCount(frontmatter, queryTokens) < MIN_FRONTMATTER_HITS
	) {
		const bodyTokens = tokenizeToSet(bodyText);
		for (const token of queryTokens) {
			if (bodyTokens.has(token)) matchTokens.add(token);
		}
	}

	const overlap = queryTokens.reduce(
		(count, token) => (matchTokens.has(token) ? count + 1 : count),
		0,
	);
	const tagOverlapRatio =
		overlap / Math.max(1, Math.min(queryTokens.length, matchTokens.size));

	const querySet = new Set(queryTokens);
	const categoryMatch = tokenizeToSet(frontmatter.category).size > 0 &&
		[...tokenizeToSet(frontmatter.category)].some((token) => querySet.has(token))
		? 1
		: 0;

	return clamp01(
		PRIOR_SEVERITY_WEIGHT * severityWeight(frontmatter.severity) +
			PRIOR_TAG_WEIGHT * tagOverlapRatio +
			PRIOR_CATEGORY_WEIGHT * categoryMatch,
	);
}

function comparePaths(a: string, b: string): number {
	if (a < b) return -1;
	if (a > b) return 1;
	return 0;
}

function collectMarkdownFiles(dir: string): string[] {
	const files: string[] = [];
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return files;
	}
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			files.push(...collectMarkdownFiles(full));
		} else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
			files.push(full);
		}
	}
	return files;
}

function isSafeSolutionsFile(
	repoRoot: string,
	realSolutionsRoot: string,
	filePath: string,
): boolean {
	const rel = path.relative(repoRoot, filePath);
	if (rel.length === 0 || path.isAbsolute(rel)) return false;
	if (rel.split(path.sep)[0] === "..") return false;

	try {
		const real = realpathSync(filePath);
		const relFromSolutions = path.relative(realSolutionsRoot, real);
		if (relFromSolutions.length === 0 || path.isAbsolute(relFromSolutions)) {
			return false;
		}
		if (relFromSolutions.split(path.sep)[0] === "..") return false;
	} catch {
		return false;
	}
	return true;
}

/** Body after the closing frontmatter delimiter (unbounded). */
export function extractSolutionBody(content: string): string {
	const normalized = content.replace(/\r\n/g, "\n");
	const lines = normalized.split("\n");
	let bodyStart = 0;
	if (lines[0]?.trim() === "---") {
		for (let i = 1; i < lines.length; i++) {
			if (lines[i].trim() === "---") {
				bodyStart = i + 1;
				break;
			}
		}
	}
	return lines.slice(bodyStart).join("\n");
}

/** UTF-8 byte truncation that never splits a multi-byte sequence and marks the cut. */
export function truncateUtf8ToBytes(
	text: string,
	maxBytes: number,
	marker = "…[truncated]",
): string {
	const buffer = Buffer.from(text, "utf8");
	if (buffer.byteLength <= maxBytes) return text;
	const markerBytes = Buffer.byteLength(marker, "utf8");
	let end = Math.max(0, maxBytes - markerBytes);
	while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--;
	return buffer.subarray(0, end).toString("utf8") + marker;
}

/** Body after the closing frontmatter delimiter, byte-bounded for the fallback. */
function extractBodyExcerpt(content: string): string {
	return truncateUtf8ToBytes(extractSolutionBody(content), BODY_FALLBACK_BYTES);
}

/**
 * Enumerate `docs/solutions/**`, score each card's `prior`, and return the top
 * `limit` (default 15) sorted by `prior` desc then `relPath` asc.
 *
 * Path safety runs during enumeration so an unsafe entry can never displace a
 * safe one. Unreadable files are dropped with a warning.
 */
export function recallSolutionCandidates(input: {
	repoRoot: string;
	query: string;
	limit?: number;
}): SolutionCandidate[] {
	const limit = input.limit ?? DEFAULT_CANDIDATE_LIMIT;
	if (!Number.isFinite(limit) || limit < 1) return [];

	const solutionsRoot = path.resolve(input.repoRoot, "docs", "solutions");
	let realSolutionsRoot: string;
	try {
		realSolutionsRoot = realpathSync(solutionsRoot);
	} catch {
		return [];
	}

	const queryTokens = extractKeywords(input.query);
	const candidates: SolutionCandidate[] = [];

	for (const filePath of collectMarkdownFiles(solutionsRoot)) {
		if (!isSafeSolutionsFile(input.repoRoot, realSolutionsRoot, filePath)) {
			continue;
		}
		let content: string;
		try {
			content = readFileSync(filePath, "utf8");
		} catch {
			console.warn(`[pi-pedstack] Could not read solution card: ${filePath}`);
			continue;
		}
		const frontmatter = parseSolutionFrontmatter(content);
		const prior = computePrior(
			frontmatter,
			queryTokens,
			extractBodyExcerpt(content),
		);
		candidates.push({
			path: filePath,
			relPath: path.relative(input.repoRoot, filePath),
			prior,
			malformed: frontmatter.malformed,
			frontmatter,
		});
	}

	candidates.sort(
		(a, b) => b.prior - a.prior || comparePaths(a.relPath, b.relPath),
	);
	return candidates.slice(0, limit);
}
