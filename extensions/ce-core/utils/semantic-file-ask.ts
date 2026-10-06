// Cheap semantic file reads and repo-scale scouting (plan #14, Unit 3).
//
// `askSemanticFile` is the single-file entry point shared with `semantic_scout`.
// Policy (paths, safety, budgets, excerpt window, status, guidance) is
// TypeScript; Jev answers exactly one bounded question per call. No file body
// is ever returned to the model — only the typed answer plus deterministic facts.
import { closeSync, lstatSync, openSync, readSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { JevRuntimeError } from "../jev/errors";
import type { JevErrorCode } from "../jev/errors";
import { createJevRuntime } from "../jev/runtime";
import type {
	JevAnswer,
	JevChoiceAnswer,
	JevNoulAnswer,
	JevQuestion,
	JevRequest,
	JevResult,
	JevRuntime,
	JevScoreAnswer,
} from "../jev/types";
import { classifyReadFile } from "../tools/read-output-filter";
import { DEFAULT_SEMANTIC_READ, type SemanticBudgets } from "./config-types";
import { canonicalRel, globBase, globToRegExp, isEscapingSymlink, isInside } from "./repo-paths";
import { runWithConcurrency } from "./solution-ranking";
import { truncateUtf8ToBytes } from "./solution-recall";

export type { SemanticBudgets } from "./config-types";

export type SemanticQuestionType = "noul" | "choice" | "score";

export type SemanticFailureReason =
	| "invalid_repo_root"
	| "invalid_question"
	| "invalid_criteria"
	| "invalid_target"
	| "not_found"
	| "outside_repo"
	| "unsafe_path"
	| "unreadable"
	| "binary"
	| "empty"
	| "timeout"
	| "jev_error";

export type SemanticDegradedReason =
	| "spawn_failed"
	| "unsupported_platform"
	| "nonzero_exit"
	| "invalid_response"
	| "timeout";

export type SemanticAnswer =
	| { kind: "noul"; value: number; confidence: number }
	| {
			kind: "choice";
			label: string;
			probabilities: Record<string, number>;
			confidence: number;
	  }
	| {
			kind: "score";
			value: number;
			legend: Record<string, string>;
			probabilities: Record<string, number>;
			confidence: number;
	  };

export interface AskSemanticFileInput {
	repoRoot: string;
	path: string;
	question: string;
	type?: SemanticQuestionType;
	criteria?: unknown;
	budgets?: Partial<SemanticBudgets>;
	/** Runtime injection (tests/tools). Defaults to a fresh `createJevRuntime()`. */
	jev?: JevRuntime;
	signal?: AbortSignal;
}

export interface AskSemanticFileResult {
	status: "ok" | "error" | "degraded";
	path: string;
	fileBytes?: number;
	excerptBytes?: number;
	truncated?: boolean;
	answer?: SemanticAnswer;
	reason: SemanticFailureReason | null;
	degradedReason?: SemanticDegradedReason;
	guidance?: string;
}

const MAX_QUESTION_CHARS = 2000;
const MIN_CHOICE_OPTIONS = 2;
const MAX_CHOICE_OPTIONS = 20;
const MIN_SCORE_LEVELS = 2;
const MAX_SCORE_LEVELS = 10;
const PER_DECISION_TIMEOUT_MS = 30_000;
const EXCERPT_READ_FLOOR_BYTES = 8192;
const MAX_REQUEST_BODY_BYTES = 65_536;
const SINGLE_QUESTION_ID = "q";
const TRUNCATION_MARKER = "…[truncated]";

/** The degraded fallback guidance (requirement R9: never weaker than raw read/grep). */
export const SEMANTIC_DEGRADED_GUIDANCE =
	"Jev unavailable — fall back to `read` for exact text and `grep`/search for deterministic patterns.";

const BINARY_EXTENSIONS = new Set([
	"png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "tif", "tiff", "avif",
	"pdf", "zip", "gz", "tgz", "bz2", "xz", "7z", "rar", "tar",
	"exe", "dll", "so", "dylib", "bin", "class", "jar", "war", "wasm",
	"woff", "woff2", "ttf", "otf", "eot",
	"mp3", "mp4", "mov", "avi", "webm", "ogg", "wav", "flac", "mkv",
	"sqlite", "db", "o", "a", "pyc", "node",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

/** Merge a partial budget override with the documented defaults. */
function resolveBudgets(
	partial?: Partial<SemanticBudgets>,
): SemanticBudgets {
	return { ...DEFAULT_SEMANTIC_READ, ...(partial ?? {}) };
}

function validateRepoRoot(repoRoot: unknown): string | null {
	if (typeof repoRoot !== "string" || repoRoot.trim().length === 0) return null;
	try {
		const resolved = path.resolve(repoRoot);
		return statSync(resolved).isDirectory() ? resolved : null;
	} catch {
		return null;
	}
}

type BuildQuestionResult =
	| { ok: true; question: JevQuestion }
	| { ok: false; reason: "invalid_question" | "invalid_criteria"; message: string };

function invalidCriteria(message: string): BuildQuestionResult {
	return { ok: false, reason: "invalid_criteria", message };
}

function invalidQuestion(message: string): BuildQuestionResult {
	return { ok: false, reason: "invalid_question", message };
}

function buildNoulQuestion(question: string, criteria: unknown): BuildQuestionResult {
	if (criteria === undefined) {
		return { ok: true, question: { type: "noul", instructions: question } };
	}
	if (!isPlainObject(criteria)) return invalidCriteria("noul criteria must be an object");
	const built: { true?: string; false?: string } = {};
	for (const [key, value] of Object.entries(criteria)) {
		if (key !== "true" && key !== "false") {
			return invalidCriteria('noul criteria keys must be "true" and/or "false"');
		}
		if (!isNonEmptyString(value)) {
			return invalidCriteria("noul criteria values must be non-empty strings");
		}
		built[key] = value;
	}
	return { ok: true, question: { type: "noul", instructions: question, criteria: built } };
}

function buildChoiceQuestion(question: string, criteria: unknown): BuildQuestionResult {
	if (!isPlainObject(criteria)) return invalidCriteria("choice criteria must be an object");
	const entries = Object.entries(criteria);
	if (entries.length < MIN_CHOICE_OPTIONS || entries.length > MAX_CHOICE_OPTIONS) {
		return invalidCriteria(
			`choice criteria must contain ${MIN_CHOICE_OPTIONS}..${MAX_CHOICE_OPTIONS} options`,
		);
	}
	const built: Record<string, string> = {};
	for (const [label, description] of entries) {
		if (!isNonEmptyString(label) || !isNonEmptyString(description)) {
			return invalidCriteria("choice criteria must be non-empty label → non-empty string");
		}
		built[label] = description;
	}
	return { ok: true, question: { type: "choice", instructions: question, criteria: built } };
}

function buildScoreQuestion(question: string, criteria: unknown): BuildQuestionResult {
	if (!Array.isArray(criteria)) {
		return invalidCriteria("score criteria must be an array of level descriptions");
	}
	if (criteria.length < MIN_SCORE_LEVELS || criteria.length > MAX_SCORE_LEVELS) {
		return invalidCriteria(
			`score criteria must contain ${MIN_SCORE_LEVELS}..${MAX_SCORE_LEVELS} levels`,
		);
	}
	if (!criteria.every(isNonEmptyString)) {
		return invalidCriteria("score criteria must be non-empty strings");
	}
	return { ok: true, question: { type: "score", instructions: question, criteria: criteria as string[] } };
}

/** Validate the one bounded question + criteria before any spawn (R7). */
function buildQuestion(input: {
	question: unknown;
	type: unknown;
	criteria: unknown;
}): BuildQuestionResult {
	if (typeof input.question !== "string" || input.question.trim().length === 0) {
		return invalidQuestion("question must be a non-empty string");
	}
	if (input.question.length > MAX_QUESTION_CHARS) {
		return invalidQuestion(`question must be at most ${MAX_QUESTION_CHARS} characters`);
	}
	const type = input.type ?? "noul";
	if (type === "noul") return buildNoulQuestion(input.question, input.criteria);
	if (type === "choice") return buildChoiceQuestion(input.question, input.criteria);
	if (type === "score") return buildScoreQuestion(input.question, input.criteria);
	return invalidQuestion("type must be one of noul, choice, score");
}

type PathResolution =
	| { ok: true; rel: string; abs: string }
	| { ok: false; reason: SemanticFailureReason; message: string };

/** Reject absolute / escaping paths, require an in-repo regular file (R3). */
async function resolveSinglePath(
	repoRoot: string,
	raw: unknown,
): Promise<PathResolution> {
	if (typeof raw !== "string" || raw.trim().length === 0) {
		return { ok: false, reason: "invalid_target", message: "path must be a non-empty string" };
	}
	if (path.isAbsolute(raw)) {
		return { ok: false, reason: "outside_repo", message: "path must be repo-relative" };
	}
	const rel = canonicalRel(repoRoot, raw);
	if (!isInside(rel)) {
		return { ok: false, reason: "outside_repo", message: "path escapes the repository root" };
	}
	const abs = path.resolve(repoRoot, rel);
	try {
		if (!statSync(abs).isFile()) {
			return { ok: false, reason: "not_found", message: "path is not a regular file" };
		}
	} catch {
		return { ok: false, reason: "not_found", message: "path does not exist" };
	}
	if (await isEscapingSymlink(repoRoot, abs)) {
		return {
			ok: false,
			reason: "unsafe_path",
			message: "path escapes the repository via a symlink",
		};
	}
	return { ok: true, rel, abs };
}

type ExcerptResult =
	| {
			ok: true;
			excerpt: string;
			fileBytes: number;
			excerptBytes: number;
			truncated: boolean;
	  }
	| {
			ok: false;
			reason: "unreadable" | "binary" | "empty";
			message: string;
			fileBytes?: number;
	  };

function hasBinaryExtension(rel: string): boolean {
	const extension = path.extname(rel).toLowerCase().replace(/^\./, "");
	return BINARY_EXTENSIONS.has(extension);
}

/** Read at most `readSize` bytes; null means the file could not be read. */
function readHead(abs: string, readSize: number, size: number): Buffer | null {
	const buffer = Buffer.allocUnsafe(Math.min(readSize, size));
	try {
		const fd = openSync(abs, "r");
		try {
			return buffer.subarray(0, readSync(fd, buffer, 0, buffer.length, 0));
		} finally {
			closeSync(fd);
		}
	} catch {
		return null;
	}
}

/** A NUL byte in the first 8 KiB, or a UTF-16 BOM, marks the head binary (R3). */
function binaryHeadFailure(head: Uint8Array, size: number): ExcerptResult | null {
	if (head.indexOf(0) !== -1) {
		return { ok: false, reason: "binary", message: "file contains a NUL byte", fileBytes: size };
	}
	const bom =
		head.length >= 2 &&
		((head[0] === 0xff && head[1] === 0xfe) || (head[0] === 0xfe && head[1] === 0xff));
	if (bom) {
		return { ok: false, reason: "binary", message: "file starts with a UTF-16 BOM", fileBytes: size };
	}
	return null;
}

/** Head window cut on the last newline inside it, never splitting a UTF-8 sequence. */
function cutExcerpt(head: Buffer, excerptBytes: number, truncated: boolean): Buffer {
	let end = Math.min(head.length, excerptBytes);
	if (truncated) {
		const newline = head.subarray(0, end).lastIndexOf(0x0a);
		if (newline >= 0) end = newline + 1;
	}
	while (end > 0 && (head[end] & 0xc0) === 0x80) end--;
	return head.subarray(0, end);
}

/** One buffered head-read; never reads or returns the whole body (R5). */
function readExcerpt(
	abs: string,
	rel: string,
	excerptBytes: number,
): ExcerptResult {
	if (hasBinaryExtension(rel)) {
		return { ok: false, reason: "binary", message: "binary file extension", fileBytes: 0 };
	}

	let size: number;
	try {
		size = statSync(abs).size;
	} catch {
		return { ok: false, reason: "unreadable", message: "file could not be read" };
	}
	if (size === 0) {
		return { ok: false, reason: "empty", message: "file is empty", fileBytes: 0 };
	}

	const head = readHead(abs, Math.max(excerptBytes, EXCERPT_READ_FLOOR_BYTES), size);
	if (!head) {
		return { ok: false, reason: "unreadable", message: "file could not be read", fileBytes: size };
	}
	const binaryFailure = binaryHeadFailure(head, size);
	if (binaryFailure) return binaryFailure;

	const truncated = size > excerptBytes;
	const excerptBuffer = cutExcerpt(head, excerptBytes, truncated);
	return {
		ok: true,
		excerpt: excerptBuffer.toString("utf8"),
		fileBytes: size,
		excerptBytes: excerptBuffer.byteLength,
		truncated,
	};
}

class SemanticTimeoutError extends Error {
	constructor() {
		super("semantic decision timed out");
		this.name = "SemanticTimeoutError";
	}
}

/**
 * Race `decide()` against a timer. Fake runtimes ignore signal/timeoutMs, so the
 * timer is what actually bounds a non-cooperating runtime. The losing promise's
 * rejection is swallowed to avoid an unhandled rejection.
 */
async function decideWithTimeout(
	jev: JevRuntime,
	request: JevRequest,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<JevResult> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new SemanticTimeoutError()), timeoutMs);
	});
	const decision = jev.decide(request, { timeoutMs, signal });
	decision.catch(() => {});
	try {
		return await Promise.race([decision, timeout]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

interface DecisionFailure {
	reason: SemanticFailureReason;
	degradedReason: SemanticDegradedReason;
	/** True only for spawn-class Jev errors that must degrade the whole call. */
	degraded: boolean;
	message: string;
}

function toDegradedReason(code: JevErrorCode): SemanticDegradedReason {
	switch (code) {
		case "spawn_failed":
		case "missing_executable":
			return "spawn_failed";
		case "unsupported_platform":
			return "unsupported_platform";
		case "nonzero_exit":
			return "nonzero_exit";
		case "timeout":
		case "aborted":
			return "timeout";
		default:
			return "invalid_response";
	}
}

function classifyDecisionError(error: unknown): DecisionFailure {
	if (error instanceof SemanticTimeoutError) {
		return {
			reason: "timeout",
			degradedReason: "timeout",
			degraded: false,
			message: error.message,
		};
	}
	if (error instanceof JevRuntimeError) {
		const degraded =
			error.code === "spawn_failed" ||
			error.code === "missing_executable" ||
			error.code === "unsupported_platform";
		const reason: SemanticFailureReason =
			error.code === "timeout" || error.code === "aborted" ? "timeout" : "jev_error";
		return { reason, degradedReason: toDegradedReason(error.code), degraded, message: error.message };
	}
	return {
		reason: "jev_error",
		degradedReason: "spawn_failed",
		degraded: false,
		message: error instanceof Error ? error.message : "unknown Jev failure",
	};
}

function requestBodyBytes(request: JevRequest): number {
	return Buffer.byteLength(JSON.stringify(request), "utf8");
}

/** Belt-and-braces guard against the 64 KiB request cap; only shrinks state. */
function enforceRequestLimit(request: JevRequest): void {
	if (requestBodyBytes(request) < MAX_REQUEST_BODY_BYTES) return;
	const state = request.state;
	if (!isPlainObject(state) || typeof state.excerpt !== "string") return;
	state.excerpt = truncateUtf8ToBytes(state.excerpt, 1024, TRUNCATION_MARKER);
	if (requestBodyBytes(request) < MAX_REQUEST_BODY_BYTES) return;
	state.excerpt = "";
}

function toNoulAnswer(answer: JevNoulAnswer): SemanticAnswer | null {
	if (!Number.isFinite(answer.noul)) return null;
	const confidence = answer.confidence ?? 1;
	if (!Number.isFinite(confidence)) return null;
	return { kind: "noul", value: answer.noul, confidence };
}

function toChoiceAnswer(answer: JevChoiceAnswer): SemanticAnswer | null {
	if (typeof answer.choice !== "string" || !Number.isFinite(answer.confidence)) return null;
	return {
		kind: "choice",
		label: answer.choice,
		probabilities: answer.probabilities,
		confidence: answer.confidence,
	};
}

function toScoreAnswer(answer: JevScoreAnswer): SemanticAnswer | null {
	if (!Number.isFinite(answer.score) || !Number.isFinite(answer.confidence)) return null;
	return {
		kind: "score",
		value: answer.score,
		legend: answer.legend,
		probabilities: answer.probabilities,
		confidence: answer.confidence,
	};
}

/** Re-validate the Jev answer shape defensively; a mismatch becomes jev_error. */
function toSemanticAnswer(
	type: SemanticQuestionType,
	answer: JevAnswer | undefined,
): SemanticAnswer | null {
	if (!answer || answer.type !== type) return null;
	if (answer.type === "noul") return toNoulAnswer(answer);
	if (answer.type === "choice") return toChoiceAnswer(answer);
	return toScoreAnswer(answer);
}

function failure(
	rel: string,
	reason: SemanticFailureReason,
	message: string,
): AskSemanticFileResult {
	void message;
	return { status: "error", path: rel, reason };
}

function buildFileRequest(
	rel: string,
	facts: { fileBytes: number; excerptBytes: number; truncated: boolean },
	question: JevQuestion,
	excerpt: string,
): JevRequest {
	return {
		state: {
			path: rel,
			fileBytes: facts.fileBytes,
			truncated: facts.truncated,
			excerpt,
		},
		questions: { [SINGLE_QUESTION_ID]: question },
	};
}

/**
 * Ask one bounded semantic question about one file. Never throws; never returns
 * a body. A full Jev outage degrades to explicit `read`/`grep` guidance.
 */
export async function askSemanticFile(
	input: AskSemanticFileInput,
): Promise<AskSemanticFileResult> {
	const reportedPath = typeof input.path === "string" ? input.path : "";
	try {
		const repoRoot = validateRepoRoot(input.repoRoot);
		if (!repoRoot) return failure(reportedPath, "invalid_repo_root", "invalid repo root");

		const built = buildQuestion({
			question: input.question,
			type: input.type,
			criteria: input.criteria,
		});
		if (!built.ok) return failure(reportedPath, built.reason, built.message);

		const resolved = await resolveSinglePath(repoRoot, input.path);
		if (!resolved.ok) return failure(reportedPath, resolved.reason, resolved.message);

		const budgets = resolveBudgets(input.budgets);
		const excerpt = readExcerpt(resolved.abs, resolved.rel, budgets.excerptBytes);
		if (!excerpt.ok) {
			return {
				status: "error",
				path: resolved.rel,
				reason: excerpt.reason,
				fileBytes: excerpt.fileBytes ?? 0,
				excerptBytes: 0,
				truncated: false,
			};
		}

		const request = buildFileRequest(
			resolved.rel,
			excerpt,
			built.question,
			excerpt.excerpt,
		);
		enforceRequestLimit(request);

		const jev = input.jev ?? createJevRuntime();
		let result: JevResult;
		try {
			result = await decideWithTimeout(
				jev,
				request,
				PER_DECISION_TIMEOUT_MS,
				input.signal,
			);
		} catch (decisionError) {
			const failureInfo = classifyDecisionError(decisionError);
			if (failureInfo.degraded) {
				return {
					status: "degraded",
					path: resolved.rel,
					fileBytes: excerpt.fileBytes,
					excerptBytes: excerpt.excerptBytes,
					truncated: excerpt.truncated,
					reason: failureInfo.reason,
					degradedReason: failureInfo.degradedReason,
					guidance: SEMANTIC_DEGRADED_GUIDANCE,
				};
			}
			return {
				status: "error",
				path: resolved.rel,
				fileBytes: excerpt.fileBytes,
				excerptBytes: excerpt.excerptBytes,
				truncated: excerpt.truncated,
				reason: failureInfo.reason,
			};
		}

		const answer = toSemanticAnswer(built.question.type, result.answers?.[SINGLE_QUESTION_ID]);
		if (!answer) {
			return {
				status: "error",
				path: resolved.rel,
				fileBytes: excerpt.fileBytes,
				excerptBytes: excerpt.excerptBytes,
				truncated: excerpt.truncated,
				reason: "jev_error",
			};
		}

		return {
			status: "ok",
			path: resolved.rel,
			fileBytes: excerpt.fileBytes,
			excerptBytes: excerpt.excerptBytes,
			truncated: excerpt.truncated,
			answer,
			reason: null,
		};
	} catch {
		// The engine never throws — a surprise is reported as a decision error.
		return failure(reportedPath, "jev_error", "unexpected semantic read failure");
	}
}

// ---------------------------------------------------------------------------
// Repo-scale scouting (plan Unit 4)
// ---------------------------------------------------------------------------

export interface ScoutSemanticFilesInput {
	repoRoot: string;
	targets: string[];
	question: string;
	type?: SemanticQuestionType;
	criteria?: unknown;
	select?: boolean;
	limit?: number;
	budgets?: Partial<SemanticBudgets>;
	/** Runtime injection (tests/tools). Defaults to a fresh `createJevRuntime()`. */
	jev?: JevRuntime;
	signal?: AbortSignal;
}

export type ScoutResultEntry =
	| {
			path: string;
			fileBytes: number;
			excerptBytes: number;
			truncated: boolean;
			reason: null;
			answer: SemanticAnswer;
	  }
	| {
			path: string;
			reason: SemanticFailureReason;
			fileBytes?: number;
			excerptBytes?: number;
			truncated?: boolean;
	  };

export interface ScoutRecommendation {
	path: string;
	probabilities: Record<string, number>;
	confidence: number;
	source: "jev" | "ordered";
}

export interface ScoutSemanticFilesResult {
	status: "ok" | "partial" | "empty" | "degraded" | "error";
	results: ScoutResultEntry[];
	counts: {
		totalFound: number;
		eligible: number;
		returned: number;
		omitted: number;
		answered: number;
		failed: number;
	};
	recommendation?: ScoutRecommendation;
	timedOut: boolean;
	savings: {
		totalFileBytes: number;
		totalExcerptBytes: number;
		savedBytes: number;
	};
	reason?: SemanticFailureReason;
	degradedReason?: SemanticDegradedReason;
	guidance?: string;
	message?: string;
}

const MAX_SCOUT_PATHS = 32;
const MAX_SELECT_OPTIONS = 20;
const SELECT_QUESTION_ID = "select";

/** Directories never walked by the scout. */
const PRUNED_DIRS = new Set([
	".git",
	"node_modules",
	"dist",
	"build",
	"coverage",
	".next",
	".turbo",
	".cache",
	"vendor",
	".context",
]);

/** Glob syntax other than `*`/`**` is unsupported (requirement R3). */
const UNSUPPORTED_GLOB_CHARS = /[?{}[\]!]/;

function comparePaths(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

function zeroCounts(): ScoutSemanticFilesResult["counts"] {
	return { totalFound: 0, eligible: 0, returned: 0, omitted: 0, answered: 0, failed: 0 };
}

function zeroSavings(): ScoutSemanticFilesResult["savings"] {
	return { totalFileBytes: 0, totalExcerptBytes: 0, savedBytes: 0 };
}

function scoutError(
	reason: SemanticFailureReason,
	message?: string,
): ScoutSemanticFilesResult {
	return {
		status: "error",
		results: [],
		counts: zeroCounts(),
		timedOut: false,
		savings: zeroSavings(),
		reason,
		message,
	};
}

/** Recursive walk with directory pruning; directory symlinks are not followed. */
/** A symlink whose target is a regular file (directory symlinks are not followed). */
function isFileSymlink(abs: string): boolean {
	try {
		return statSync(abs).isFile();
	} catch {
		return false;
	}
}

async function walkFiles(absDir: string, relDir: string, out: string[]): Promise<void> {
	let entries;
	try {
		entries = await readdir(absDir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		const childAbs = path.join(absDir, entry.name);
		const childRel = relDir ? `${relDir}/${entry.name}` : entry.name;
		if (entry.isDirectory()) {
			if (PRUNED_DIRS.has(entry.name)) continue;
			await walkFiles(childAbs, childRel, out);
		} else if (entry.isFile()) {
			out.push(childRel);
		} else if (entry.isSymbolicLink() && isFileSymlink(childAbs)) {
			out.push(childRel);
		}
	}
}

type TargetExpansion =
	| { ok: true; files: string[] }
	| { ok: false; reason: "invalid_target"; message: string };

async function addWalked(absDir: string, relDir: string, found: Set<string>): Promise<void> {
	const collected: string[] = [];
	await walkFiles(absDir, relDir, collected);
	for (const candidate of collected) found.add(candidate);
}

async function addGlobMatches(repoRoot: string, rel: string, found: Set<string>): Promise<void> {
	const matcher = globToRegExp(rel);
	const base = globBase(rel);
	const collected: string[] = [];
	await walkFiles(path.join(repoRoot, base), base, collected);
	for (const candidate of collected) {
		if (matcher.test(candidate)) found.add(candidate);
	}
}

async function addLiteralTarget(
	repoRoot: string,
	rel: string,
	raw: string,
	found: Set<string>,
): Promise<string | null> {
	const abs = path.resolve(repoRoot, rel);
	let stat;
	try {
		stat = lstatSync(abs);
	} catch {
		return `target not found: ${raw}`;
	}
	if (stat.isDirectory()) {
		await addWalked(abs, rel, found);
		return null;
	}
	if (stat.isFile()) {
		found.add(rel);
		return null;
	}
	if (stat.isSymbolicLink()) {
		try {
			// File symlinks are candidates; directory symlinks are not followed.
			if (statSync(abs).isFile()) found.add(rel);
		} catch {
			return `target not found: ${raw}`;
		}
	}
	return null;
}

/** Validates one target and adds its files; returns an error message on failure. */
async function expandOneTarget(
	repoRoot: string,
	raw: unknown,
	found: Set<string>,
): Promise<string | null> {
	if (typeof raw !== "string" || raw.trim().length === 0) {
		return "each target must be a non-empty string";
	}
	if (path.isAbsolute(raw) || UNSUPPORTED_GLOB_CHARS.test(raw)) {
		return `unsupported target: ${raw}`;
	}
	const rel = canonicalRel(repoRoot, raw);
	if (rel === "") {
		await addWalked(repoRoot, "", found);
		return null;
	}
	if (!isInside(rel) || rel.split("/").includes("..")) {
		return `target escapes the repository: ${raw}`;
	}
	if (rel.includes("*")) {
		await addGlobMatches(repoRoot, rel, found);
		return null;
	}
	return addLiteralTarget(repoRoot, rel, raw, found);
}

/** Expand files/dirs/globs into a deduped repo-relative candidate set (R3). */
async function expandTargets(repoRoot: string, targets: unknown): Promise<TargetExpansion> {
	if (!Array.isArray(targets)) {
		return { ok: false, reason: "invalid_target", message: "targets must be an array" };
	}
	const found = new Set<string>();
	for (const raw of targets) {
		const message = await expandOneTarget(repoRoot, raw, found);
		if (message !== null) return { ok: false, reason: "invalid_target", message };
	}
	return { ok: true, files: [...found] };
}

/** Lock/minified/generated files and `*.map` are pruned out of `eligible`. */
function isPrunedFile(rel: string): boolean {
	if (rel.toLowerCase().endsWith(".map")) return true;
	const category = classifyReadFile(rel);
	return category === "lock-file" || category === "minified-file" || category === "generated-file";
}

interface ScoutAttempt {
	entry: ScoutResultEntry;
	/** Set only for a decision that actually spawned and failed. */
	degradedReason?: SemanticDegradedReason;
	attempted: boolean;
}

function excerptFailureEntry(
	rel: string,
	excerpt: Extract<ExcerptResult, { ok: false }>,
): ScoutAttempt {
	return {
		entry: {
			path: rel,
			reason: excerpt.reason,
			fileBytes: excerpt.fileBytes ?? 0,
			excerptBytes: 0,
			truncated: false,
		},
		attempted: false,
	};
}

async function answerScoutPath(
	repoRoot: string,
	rel: string,
	question: JevQuestion,
	budgets: SemanticBudgets,
	jev: JevRuntime,
	deadlineAt: number,
	controller: AbortController,
): Promise<ScoutAttempt> {
	if (controller.signal.aborted) {
		return { entry: { path: rel, reason: "timeout" }, attempted: false };
	}
	const abs = path.resolve(repoRoot, rel);
	if (await isEscapingSymlink(repoRoot, abs)) {
		return { entry: { path: rel, reason: "unsafe_path" }, attempted: false };
	}
	const excerpt = readExcerpt(abs, rel, budgets.excerptBytes);
	if (!excerpt.ok) return excerptFailureEntry(rel, excerpt);

	const request = buildFileRequest(rel, excerpt, question, excerpt.excerpt);
	enforceRequestLimit(request);
	const remaining = Math.max(1, Math.min(PER_DECISION_TIMEOUT_MS, deadlineAt - Date.now()));
	try {
		const result = await decideWithTimeout(jev, request, remaining, controller.signal);
		const answer = toSemanticAnswer(question.type, result.answers?.[SINGLE_QUESTION_ID]);
		if (!answer) {
			return {
				entry: { path: rel, reason: "jev_error" },
				attempted: true,
				degradedReason: "invalid_response",
			};
		}
		return {
			entry: {
				path: rel,
				fileBytes: excerpt.fileBytes,
				excerptBytes: excerpt.excerptBytes,
				truncated: excerpt.truncated,
				reason: null,
				answer,
			},
			attempted: true,
		};
	} catch (error) {
		const info = classifyDecisionError(error);
		const timedOut = controller.signal.aborted || info.reason === "timeout";
		return {
			entry: { path: rel, reason: timedOut ? "timeout" : info.reason },
			attempted: true,
			degradedReason: info.degradedReason,
		};
	}
}

function answerSortKey(entry: ScoutResultEntry): number {
	if (entry.reason !== null) return Number.NEGATIVE_INFINITY;
	if (entry.answer.kind === "noul") return entry.answer.value;
	if (entry.answer.kind === "score") {
		const levels = Object.keys(entry.answer.legend).length;
		return levels > 1 ? entry.answer.value / (levels - 1) : 0;
	}
	return 0;
}

function describeAnswer(answer: SemanticAnswer): string {
	if (answer.kind === "noul") return `value=${answer.value.toFixed(3)}`;
	if (answer.kind === "score") return `score=${answer.value}`;
	return `label=${answer.label}`;
}

function rankAnswered(
	answeredEntries: Array<Extract<ScoutResultEntry, { reason: null }>>,
): Array<Extract<ScoutResultEntry, { reason: null }>> {
	return [...answeredEntries].sort((a, b) => {
		const diff = answerSortKey(b) - answerSortKey(a);
		return diff !== 0 ? diff : comparePaths(a.path, b.path);
	});
}

interface ChoiceRequest {
	request: JevRequest;
	criteria: Record<string, string>;
}

/** One choice question whose state is the question + each candidate's value/label. */
function buildChoiceRequest(
	questionText: string,
	candidates: Array<Extract<ScoutResultEntry, { reason: null }>>,
): ChoiceRequest {
	const criteria: Record<string, string> = {};
	const stateCandidates: Array<{ path: string; value?: number; label?: string }> = [];
	for (const candidate of candidates) {
		criteria[candidate.path] = describeAnswer(candidate.answer);
		if (candidate.answer.kind === "choice") {
			stateCandidates.push({ path: candidate.path, label: candidate.answer.label });
		} else {
			stateCandidates.push({ path: candidate.path, value: candidate.answer.value });
		}
	}
	return {
		criteria,
		request: {
			state: { question: questionText, candidates: stateCandidates },
			questions: {
				[SELECT_QUESTION_ID]: {
					type: "choice",
					instructions: `Which file should be opened first to answer: ${questionText}`,
					criteria,
				},
			},
		},
	};
}

/**
 * One second-pass Choice over the pre-ranked answers. Never downgrades the
 * scout: any error, oversize request, or non-selection falls back to a
 * deterministic `source:"ordered"` recommendation.
 */
async function chooseRecommendation(
	answeredEntries: Array<Extract<ScoutResultEntry, { reason: null }>>,
	questionText: string,
	budgets: SemanticBudgets,
	jev: JevRuntime,
	deadlineAt: number,
	controller: AbortController,
): Promise<ScoutRecommendation> {
	const ranked = rankAnswered(answeredEntries);
	const ordered = (): ScoutRecommendation => ({
		path: ranked[0].path,
		probabilities: {},
		confidence: 1,
		source: "ordered",
	});
	const optionLimit = Math.max(1, Math.min(budgets.selectLimit, MAX_SELECT_OPTIONS));
	const candidates = ranked.slice(0, optionLimit);
	if (candidates.length < 2) return ordered();

	const { request, criteria } = buildChoiceRequest(questionText, candidates);
	if (requestBodyBytes(request) >= MAX_REQUEST_BODY_BYTES) return ordered();

	const remaining = Math.max(1, Math.min(PER_DECISION_TIMEOUT_MS, deadlineAt - Date.now()));
	try {
		const result = await decideWithTimeout(jev, request, remaining, controller.signal);
		const answer = result.answers?.[SELECT_QUESTION_ID];
		if (!answer || answer.type !== "choice" || !criteria[answer.choice]) return ordered();
		return {
			path: answer.choice,
			probabilities: answer.probabilities,
			confidence: answer.confidence,
			source: "jev",
		};
	} catch {
		return ordered();
	}
}

interface ScoutCandidates {
	totalFound: number;
	eligible: string[];
	returned: string[];
	omitted: number;
}

/** Apply file pruning, deterministic ordering, and the hard path cap. */
function selectCandidates(
	files: string[],
	limit: number | undefined,
	maxPaths: number,
): ScoutCandidates {
	const eligible = files.filter((rel) => !isPrunedFile(rel)).sort(comparePaths);
	const cap = Math.max(1, Math.min(limit ?? maxPaths, MAX_SCOUT_PATHS));
	const returned = eligible.slice(0, cap);
	return {
		totalFound: files.length,
		eligible,
		returned,
		omitted: eligible.length - returned.length,
	};
}

interface ScoutSummary {
	entries: ScoutResultEntry[];
	answeredEntries: Array<Extract<ScoutResultEntry, { reason: null }>>;
	status: ScoutSemanticFilesResult["status"];
	degradedReason?: SemanticDegradedReason;
	counts: ScoutSemanticFilesResult["counts"];
	timedOut: boolean;
	savings: ScoutSemanticFilesResult["savings"];
}

/** Collapse per-path attempts into the status ladder, counts, timedOut, and savings. */
function summarizeAttempts(
	attempts: ScoutAttempt[],
	counts: { totalFound: number; eligible: number; returned: number; omitted: number },
): ScoutSummary {
	const entries = attempts.map((attempt) => attempt.entry);
	const answeredEntries = entries.filter(
		(entry): entry is Extract<ScoutResultEntry, { reason: null }> => entry.reason === null,
	);
	const answered = answeredEntries.length;
	const failed = entries.length - answered;
	const outageReasons = attempts
		.filter((attempt) => attempt.attempted && attempt.degradedReason !== undefined)
		.map((attempt) => attempt.degradedReason as SemanticDegradedReason);

	let status: ScoutSemanticFilesResult["status"];
	if (answered === 0 && outageReasons.length > 0) status = "degraded";
	else if (answered === 0) status = "partial";
	else if (failed > 0) status = "partial";
	else status = "ok";

	let totalFileBytes = 0;
	let totalExcerptBytes = 0;
	for (const entry of entries) {
		if (typeof entry.fileBytes === "number" && typeof entry.excerptBytes === "number") {
			totalFileBytes += entry.fileBytes;
			totalExcerptBytes += entry.excerptBytes;
		}
	}

	return {
		entries,
		answeredEntries,
		status,
		degradedReason: status === "degraded" ? outageReasons[0] : undefined,
		counts: { ...counts, answered, failed },
		timedOut: entries.some((entry) => entry.reason === "timeout"),
		savings: {
			totalFileBytes,
			totalExcerptBytes,
			savedBytes: Math.max(0, totalFileBytes - totalExcerptBytes),
		},
	};
}

/**
 * Scout a set of files/dirs/globs for one bounded semantic question. Answers
 * every eligible path within one deadline, isolates per-path failure, and
 * optionally recommends the first file to open. Never throws; never returns
 * a body.
 */
export async function scoutSemanticFiles(
	input: ScoutSemanticFilesInput,
): Promise<ScoutSemanticFilesResult> {
	try {
		const budgets = resolveBudgets(input.budgets);
		const repoRoot = validateRepoRoot(input.repoRoot);
		if (!repoRoot) return scoutError("invalid_repo_root");

		const built = buildQuestion({
			question: input.question,
			type: input.type,
			criteria: input.criteria,
		});
		if (!built.ok) return scoutError(built.reason, built.message);

		const expanded = await expandTargets(repoRoot, input.targets);
		if (!expanded.ok) return scoutError(expanded.reason, expanded.message);

		const candidates = selectCandidates(expanded.files, input.limit, budgets.maxPaths);

		if (candidates.returned.length === 0) {
			return {
				status: "empty",
				results: [],
				counts: {
					totalFound: candidates.totalFound,
					eligible: candidates.eligible.length,
					returned: 0,
					omitted: 0,
					answered: 0,
					failed: 0,
				},
				timedOut: false,
				savings: zeroSavings(),
				message: "No eligible files matched the provided targets.",
			};
		}

		const controller = new AbortController();
		const deadlineAt = Date.now() + budgets.deadlineMs;
		const timer = setTimeout(() => controller.abort(), budgets.deadlineMs);
		if (input.signal) {
			if (input.signal.aborted) controller.abort();
			else input.signal.addEventListener("abort", () => controller.abort(), { once: true });
		}

		const jev = input.jev ?? createJevRuntime();
		let attempts: ScoutAttempt[];
		try {
			attempts = await runWithConcurrency(
				candidates.returned,
				Math.max(1, budgets.concurrency),
				(rel) =>
					answerScoutPath(repoRoot, rel, built.question, budgets, jev, deadlineAt, controller),
			);
		} finally {
			clearTimeout(timer);
		}

		const summary = summarizeAttempts(attempts, {
			totalFound: candidates.totalFound,
			eligible: candidates.eligible.length,
			returned: candidates.returned.length,
			omitted: candidates.omitted,
		});
		const select = input.select ?? budgets.select;
		let recommendation: ScoutRecommendation | undefined;
		if (
			(summary.status === "ok" || summary.status === "partial") &&
			select &&
			summary.answeredEntries.length >= 2
		) {
			recommendation = await chooseRecommendation(
				summary.answeredEntries,
				input.question,
				budgets,
				jev,
				deadlineAt,
				controller,
			);
		}

		return {
			status: summary.status,
			results: summary.entries,
			counts: summary.counts,
			recommendation,
			timedOut: summary.timedOut,
			savings: summary.savings,
			degradedReason: summary.degradedReason,
			guidance: summary.status === "degraded" ? SEMANTIC_DEGRADED_GUIDANCE : undefined,
		};
	} catch {
		return scoutError("jev_error", "unexpected semantic scout failure");
	}
}
