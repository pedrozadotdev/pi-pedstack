import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type {
	JevQuestion,
	JevRequest,
	JevResult,
	JevRuntime,
} from "../jev/types";
import {
	extractSolutionBody,
	recallSolutionCandidates,
	truncateUtf8ToBytes,
	type SolutionCandidate,
} from "./solution-recall";

/**
 * `rankSolutions` — the single shared entry point for semantic solution
 * ranking. Policy (thresholds, ordering, status) stays in TypeScript; Jev only
 * answers atomic `noul` questions.
 */

export type SolutionRankingMode = "recall" | "overlap";
export type SolutionStatus = "ok" | "none" | "degraded";

export interface RankingThresholds {
	minRank: number;
	minConfidence: number;
	concurrency: number;
	candidates: number;
	limit: number;
}

export interface SolutionRankingConfig extends Partial<RankingThresholds> {
	shadow?: boolean;
}

export const DEFAULT_SOLUTION_RANKING: RankingThresholds & {
	shadow: boolean;
} = {
	minRank: 0.6,
	minConfidence: 0.5,
	concurrency: 4,
	candidates: 15,
	limit: 3,
	shadow: true,
};

export interface RankedSolution {
	path: string;
	title: string;
	category: string;
	severity: string | null;
	tags: string[];
	rank: number;
	confidence: number;
	source: "jev" | "prior";
	content: string;
}

export interface SolutionRankingResult {
	status: SolutionStatus;
	degraded: boolean;
	enforced: boolean;
	results: RankedSolution[];
	/** Overlap mode only: relPaths whose `conflict` answer crossed the warning bar. */
	conflicts: string[];
}

/** Shared metadata bullet lines for a ranked solution (path/category/severity/tags). */
export function formatSolutionMetaLines(solution: RankedSolution): string[] {
	return [
		`- path: ${solution.path}`,
		`- category: ${solution.category}`,
		`- severity: ${solution.severity ?? "unknown"}`,
		`- tags: ${solution.tags.join(", ")}`,
	];
}

export interface SolutionShadowRecord {
	mode: SolutionRankingMode;
	queryHash: string;
	priorOrder: string[];
	rankOrder: string[];
	thresholds: RankingThresholds;
	limit: number;
	enforced: boolean;
	status: SolutionStatus;
	dropped: string[];
	conflicts: string[];
}

export interface RankSolutionsInput {
	query: string;
	repoRoot: string;
	jev: JevRuntime;
	thresholds?: Partial<RankingThresholds>;
	limit?: number;
	mode?: SolutionRankingMode;
	shadow?: boolean;
	telemetry?: (record: SolutionShadowRecord) => void;
}

const QUERY_EXCERPT_BYTES = 2048;
const BODY_EXCERPT_BYTES = 4096;
const CONTENT_CAP_BYTES = 8192;
const MAX_REQUEST_BODY_BYTES = 65_536;
const CONFLICT_WARNING_THRESHOLD = 0.5;

const TRUNCATION_MARKER = "…[truncated]";

function clamp01(value: number): number {
	return Math.max(0, Math.min(1, value));
}

function comparePaths(a: string, b: string): number {
	if (a < b) return -1;
	if (a > b) return 1;
	return 0;
}

const QUESTION_INSTRUCTIONS: Record<string, string> = {
	relevance: "Is this candidate solution about the current task and domain?",
	applicability: "Does the candidate's guidance apply to the current situation?",
	reuse: "Is this candidate worth acting on directly?",
	duplicate: "Does this candidate capture the same lesson as the new solution?",
	overlap: "Is this candidate related guidance that overlaps the new solution?",
	conflict: "Does this candidate contradict the new solution's guidance?",
};

function buildQuestions(mode: SolutionRankingMode): Record<string, JevQuestion> {
	const ids =
		mode === "overlap"
			? (["duplicate", "overlap", "conflict"] as const)
			: (["relevance", "applicability", "reuse"] as const);
	const questions: Record<string, JevQuestion> = {};
	for (const id of ids) {
		questions[id] = { type: "noul", instructions: QUESTION_INSTRUCTIONS[id] };
	}
	return questions;
}

function buildRequest(
	query: string,
	candidate: SolutionCandidate,
	bodyExcerpt: string,
	mode: SolutionRankingMode,
): JevRequest {
	return {
		state: {
			task: truncateUtf8ToBytes(query, QUERY_EXCERPT_BYTES, TRUNCATION_MARKER),
			candidate: {
				path: candidate.relPath,
				title: candidate.frontmatter.title,
				category: candidate.frontmatter.category,
				severity: candidate.frontmatter.severity,
				tags: candidate.frontmatter.tags,
				applies_when: candidate.frontmatter.applies_when,
				excerpt: truncateUtf8ToBytes(
					bodyExcerpt,
					BODY_EXCERPT_BYTES,
					TRUNCATION_MARKER,
				),
			},
		},
		questions: buildQuestions(mode),
	};
}

function requestBodyBytes(request: JevRequest): number {
	return Buffer.byteLength(JSON.stringify(request), "utf8");
}

/**
 * ponytail: excerpts are already capped, so this is a belt-and-braces guard
 * against a pathological frontmatter field breaching the 64 KiB request cap.
 * It never throws — it only shrinks the excerpts.
 */
function enforceRequestBodyLimit(request: JevRequest): void {
	if (requestBodyBytes(request) < MAX_REQUEST_BODY_BYTES) return;
	const state = request.state as {
		task?: unknown;
		candidate?: { excerpt?: unknown };
	};
	const candidate = state.candidate;
	const shrink = (holder: Record<string, unknown>, key: string, max: number) => {
		if (typeof holder[key] === "string") {
			holder[key] = truncateUtf8ToBytes(holder[key] as string, max);
		}
	};
	if (!candidate) return;
	shrink(candidate as Record<string, unknown>, "excerpt", 1024);
	if (requestBodyBytes(request) < MAX_REQUEST_BODY_BYTES) return;
	shrink(candidate as Record<string, unknown>, "excerpt", 0);
	if (requestBodyBytes(request) < MAX_REQUEST_BODY_BYTES) return;
	shrink(state as Record<string, unknown>, "task", 1024);
	if (requestBodyBytes(request) < MAX_REQUEST_BODY_BYTES) return;
	shrink(state as Record<string, unknown>, "task", 0);
}

import { isUnitNumber, readConfidence } from "./noul-read";

interface NoulReading {
	value: number;
	confidence: number;
}

/** A noul answer is valid only when finite and in [0,1]; omitted confidence = 1. */
function readNoul(result: JevResult, id: string): NoulReading | null {
	const answer = result.answers?.[id];
	if (!answer || answer.type !== "noul") return null;
	if (!isUnitNumber(answer.noul)) return null;
	const confidence = readConfidence(answer as { confidence?: unknown });
	if (confidence === null) return null;
	return { value: answer.noul, confidence };
}

interface CandidateScore {
	candidate: SolutionCandidate;
	rank: number;
	confidence: number;
	secondary: number;
	conflict: boolean;
}

function combine(
	candidate: SolutionCandidate,
	result: JevResult,
	mode: SolutionRankingMode,
): CandidateScore | null {
	if (mode === "overlap") {
		const duplicate = readNoul(result, "duplicate");
		const overlap = readNoul(result, "overlap");
		const conflict = readNoul(result, "conflict");
		if (!duplicate || !overlap || !conflict) return null;
		return {
			candidate,
			rank: clamp01(duplicate.value * overlap.value),
			confidence: Math.min(duplicate.confidence, overlap.confidence),
			secondary: overlap.value,
			conflict: conflict.value >= CONFLICT_WARNING_THRESHOLD,
		};
	}
	const relevance = readNoul(result, "relevance");
	const applicability = readNoul(result, "applicability");
	const reuse = readNoul(result, "reuse");
	if (!relevance || !applicability || !reuse) return null;
	return {
		candidate,
		rank: clamp01(relevance.value * applicability.value),
		confidence: Math.min(relevance.confidence, applicability.confidence),
		secondary: reuse.value,
		conflict: false,
	};
}

/** Bounded worker pool: a slot is only refilled when its `decide()` settles. */
export async function runWithConcurrency<T, R>(
	items: T[],
	concurrency: number,
	worker: (item: T) => Promise<R>,
): Promise<R[]> {
	const results: R[] = new Array(items.length);
	const workerCount = Math.max(1, Math.min(concurrency, items.length));
	let nextIndex = 0;
	const runners: Promise<void>[] = [];
	for (let i = 0; i < workerCount; i++) {
		runners.push(
			(async () => {
				while (true) {
					const index = nextIndex++;
					if (index >= items.length) break;
					results[index] = await worker(items[index]);
				}
			})(),
		);
	}
	await Promise.all(runners);
	return results;
}

function readContent(filePath: string): string {
	try {
		const content = readFileSync(filePath, "utf8");
		return truncateUtf8ToBytes(
			extractSolutionBody(content),
			CONTENT_CAP_BYTES,
			TRUNCATION_MARKER,
		);
	} catch {
		return "";
	}
}

function toResult(
	candidate: SolutionCandidate,
	rank: number,
	confidence: number,
	source: "jev" | "prior",
): RankedSolution {
	return {
		path: candidate.relPath,
		title: candidate.frontmatter.title,
		category: candidate.frontmatter.category,
		severity: candidate.frontmatter.severity,
		tags: candidate.frontmatter.tags,
		rank,
		confidence,
		source,
		content: readContent(candidate.path),
	};
}

function hashQuery(query: string): string {
	return createHash("sha256").update(query).digest("hex").slice(0, 16);
}

export async function rankSolutions(
	input: RankSolutionsInput,
): Promise<SolutionRankingResult> {
	const mode: SolutionRankingMode = input.mode ?? "recall";
	const { shadow: defaultShadow, ...defaultThresholds } =
		DEFAULT_SOLUTION_RANKING;
	const thresholds: RankingThresholds = {
		...defaultThresholds,
		...input.thresholds,
	};
	const limit = input.limit ?? thresholds.limit;
	const shadow = input.shadow ?? defaultShadow;
	const enforced = !shadow;

	const candidates = recallSolutionCandidates({
		repoRoot: input.repoRoot,
		query: input.query,
		limit: thresholds.candidates,
	});
	const priorOrder = candidates.map((candidate) => candidate.relPath);

	const emit = (
		status: SolutionStatus,
		scored: CandidateScore[],
		dropped: string[],
		conflicts: string[],
	): void => {
		if (!input.telemetry) return;
		try {
			input.telemetry({
				mode,
				queryHash: hashQuery(input.query),
				priorOrder,
				rankOrder: [...scored]
					.sort((a, b) => b.rank - a.rank)
					.map((score) => score.candidate.relPath),
				thresholds,
				limit,
				enforced,
				status,
				dropped,
				conflicts,
			});
		} catch {
			// ponytail: telemetry must never break a ranking run.
		}
	};

	if (candidates.length === 0) {
		emit("none", [], [], []);
		return { status: "none", degraded: false, enforced, results: [], conflicts: [] };
	}

	const scored = (
		await runWithConcurrency(
			candidates,
			thresholds.concurrency,
			async (candidate): Promise<CandidateScore | null> => {
				let bodyExcerpt = "";
				try {
					bodyExcerpt = extractSolutionBody(
						readFileSync(candidate.path, "utf8"),
					);
				} catch {
					bodyExcerpt = "";
				}
				const request = buildRequest(input.query, candidate, bodyExcerpt, mode);
				enforceRequestBodyLimit(request);
				try {
					return combine(candidate, await input.jev.decide(request), mode);
				} catch (error) {
					console.warn(
						`[pi-pedstack] Jev dropped candidate ${candidate.relPath}: ${
							error instanceof Error ? error.message : String(error)
						}`,
					);
					return null;
				}
			},
		)
	).filter((score): score is CandidateScore => score !== null);

	const scoredPaths = new Set(scored.map((score) => score.candidate.relPath));
	const dropped = priorOrder.filter((relPath) => !scoredPaths.has(relPath));
	const conflicts =
		mode === "overlap"
			? scored.filter((score) => score.conflict).map((s) => s.candidate.relPath)
			: [];

	if (scored.length === 0) {
		const results = candidates
			.slice(0, limit)
			.map((candidate) => toResult(candidate, candidate.prior, 1, "prior"));
		emit("degraded", scored, dropped, conflicts);
		return { status: "degraded", degraded: true, enforced, results, conflicts };
	}

	const qualifying = scored.filter(
		(score) =>
			score.rank >= thresholds.minRank &&
			score.confidence >= thresholds.minConfidence,
	);
	qualifying.sort(
		(a, b) =>
			b.rank - a.rank ||
			b.secondary - a.secondary ||
			b.candidate.prior - a.candidate.prior ||
			comparePaths(a.candidate.relPath, b.candidate.relPath),
	);

	if (qualifying.length === 0) {
		emit("none", scored, dropped, conflicts);
		return { status: "none", degraded: false, enforced, results: [], conflicts };
	}

	const results = qualifying
		.slice(0, limit)
		.map((score) =>
			toResult(
				score.candidate,
				score.rank,
				score.confidence,
				"jev",
			),
		);
	emit("ok", scored, dropped, conflicts);
	return { status: "ok", degraded: false, enforced, results, conflicts };
}
