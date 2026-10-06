/**
 * Injection-screen engine (I/O): provenance → sample → one bounded Jev call →
 * TypeScript verdict → sanitized JSONL log, plus the bounded verdict map and
 * wrap-miss lifecycle used by the two-phase handlers.
 *
 * The engine never blocks, never rewrites content, and never throws. Failures
 * degrade toward screening (or fail open) rather than disabling the screen.
 *
 * @module injection-screen/engine
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { JevRuntime } from "../jev/types";
import {
	INJECTION_QUESTION_ID,
	buildInjectionRequest,
	decideVerdict,
	type ScreenVerdict,
	type Verdict,
} from "./decision";
import {
	buildSample,
	classifyProvenance,
	type ClassifyProvenanceInput,
	type Provenance,
	type ScreenMode,
} from "./provenance";

const MAX_VERDICTS = 128;
const JEV_TIMEOUT_MS = 10_000;
const MAX_REF_CHARS = 200;

const LOG_DIR = ".context/compound-engineering";
const LOG_FILE = "injection-screens.jsonl";

const CREDENTIAL_ASSIGNMENT =
	/([A-Za-z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD|PASSWD))=(\S+)/gi;
const FIRST_URL = /https?:\/\/[^\s]+/;

export interface ScreenInput {
	toolCallId: string;
	toolName: string;
	input: Record<string, unknown>;
	rawText: string;
	/** Realpath-normalized read path, computed by the handler (I/O). */
	realPath?: string;
}

export interface StoredVerdict {
	verdict: ScreenVerdict;
	provenance: Provenance;
	mode: ScreenMode;
	noul: number | null;
	confidence: number | null;
}

export interface ScreenStats {
	clean: number;
	flagged: number;
	degraded: number;
	wrapMiss: number;
}

export interface InjectionScreenEngineDeps {
	jev: JevRuntime;
	repoRoot: string;
	mode: ScreenMode;
	now?: () => Date;
	appendLog?: (line: string) => void | Promise<void>;
	/** Test seam; defaults to the pure classifier. */
	classify?: (input: ClassifyProvenanceInput) => Provenance | null;
}

export interface InjectionScreenEngine {
	screen(input: ScreenInput): Promise<ScreenVerdict | undefined>;
	consume(toolCallId: string): StoredVerdict | undefined;
	recordWrapMiss(toolCallId: string, stored: StoredVerdict): Promise<void>;
	sweepTurn(): Promise<{ wrapMiss: number; notify: boolean }>;
	clear(): void;
	stats(): ScreenStats;
}

interface LogRecord {
	ts: string;
	toolCallId: string;
	kind: string;
	ref: string;
	noul: number | null;
	confidence: number | null;
	verdict: ScreenVerdict;
	mode: ScreenMode;
	degraded: boolean;
	wrapMiss: boolean;
}

/** Strip credentials, URL query/fragment, newlines; cap the length. */
function sanitizeRef(raw: unknown): string {
	let ref = typeof raw === "string" ? raw : String(raw ?? "");
	ref = ref.replace(CREDENTIAL_ASSIGNMENT, "$1=[redacted]");

	const url = FIRST_URL.exec(ref)?.[0];
	if (url) {
		try {
			const parsed = new URL(url);
			parsed.search = "";
			parsed.hash = "";
			parsed.username = "";
			parsed.password = "";
			ref = ref.replace(url, parsed.toString());
		} catch {
			// Not a parseable URL; fall through to generic sanitization.
		}
	}

	ref = ref.replace(/\s+/g, " ").trim();
	return ref.slice(0, MAX_REF_CHARS);
}

function fallbackProvenance(input: ScreenInput): Provenance {
	if (input.toolName === "read") {
		const p = input.input?.path;
		return { kind: "external-path", ref: typeof p === "string" ? p : "" };
	}
	const c = input.input?.command;
	return { kind: "http", ref: typeof c === "string" ? c : "" };
}

function defaultAppendLog(repoRoot: string) {
	const filePath = path.join(repoRoot, LOG_DIR, LOG_FILE);
	return async (line: string): Promise<void> => {
		await fs.mkdir(path.dirname(filePath), { recursive: true });
		await fs.appendFile(filePath, `${line}\n`, "utf8");
	};
}

export function createInjectionScreenEngine(
	deps: InjectionScreenEngineDeps,
): InjectionScreenEngine {
	const {
		jev,
		repoRoot,
		mode,
		now = () => new Date(),
		appendLog = defaultAppendLog(repoRoot),
		classify = classifyProvenance,
	} = deps;

	const verdicts = new Map<string, StoredVerdict>();
	const counters: ScreenStats = {
		clean: 0,
		flagged: 0,
		degraded: 0,
		wrapMiss: 0,
	};

	const writeLog = async (record: LogRecord): Promise<void> => {
		try {
			await appendLog(JSON.stringify(record));
		} catch {
			// ponytail: best-effort telemetry must never break a screen.
		}
	};

	const logStored = (
		toolCallId: string,
		stored: StoredVerdict,
		wrapMiss: boolean,
	): Promise<void> =>
		writeLog({
			ts: now().toISOString(),
			toolCallId,
			kind: stored.provenance.kind,
			ref: sanitizeRef(stored.provenance.ref),
			noul: stored.noul,
			confidence: stored.confidence,
			verdict: stored.verdict,
			mode: stored.mode,
			degraded: stored.verdict === "degraded",
			wrapMiss,
		});

	const store = (toolCallId: string, stored: StoredVerdict): void => {
		verdicts.delete(toolCallId);
		verdicts.set(toolCallId, stored);
		while (verdicts.size > MAX_VERDICTS) {
			const oldestKey = verdicts.keys().next().value as string;
			const oldest = verdicts.get(oldestKey);
			verdicts.delete(oldestKey);
			if (
				oldest &&
				oldest.mode === "enforce" &&
				oldest.verdict === "flagged"
			) {
				counters.wrapMiss++;
			}
		}
	};

	return {
		async screen(input: ScreenInput): Promise<ScreenVerdict | undefined> {
			if (mode === "off") return undefined;

			let provenance: Provenance | null;
			try {
				provenance = classify({
					toolName: input.toolName,
					input: input.input,
					repoRoot,
					realPath: input.realPath,
				});
			} catch {
				provenance = fallbackProvenance(input);
			}
			if (!provenance) return undefined;

			let decided: Verdict;
			try {
				const sample = buildSample(input.rawText);
				const request = buildInjectionRequest(provenance, sample.text);
				const result = await jev.decide(request, {
					timeoutMs: JEV_TIMEOUT_MS,
					cwd: repoRoot,
				});
				decided = decideVerdict(result.answers?.[INJECTION_QUESTION_ID]);
			} catch {
				decided = { verdict: "degraded", noul: null, confidence: null };
			}

			const stored: StoredVerdict = {
				verdict: decided.verdict,
				provenance,
				mode,
				noul: decided.noul,
				confidence: decided.confidence,
			};
			store(input.toolCallId, stored);
			counters[decided.verdict] += 1;
			await logStored(input.toolCallId, stored, false);
			return decided.verdict;
		},

		consume(toolCallId: string): StoredVerdict | undefined {
			const stored = verdicts.get(toolCallId);
			if (stored) verdicts.delete(toolCallId);
			return stored;
		},

		async recordWrapMiss(
			toolCallId: string,
			stored: StoredVerdict,
		): Promise<void> {
			counters.wrapMiss += 1;
			await logStored(toolCallId, stored, true);
		},

		async sweepTurn(): Promise<{ wrapMiss: number; notify: boolean }> {
			let wrapMiss = 0;
			let notify = false;
			for (const [toolCallId, stored] of verdicts) {
				wrapMiss++;
				counters.wrapMiss++;
				if (stored.mode === "enforce" && stored.verdict === "flagged") {
					notify = true;
				}
				await logStored(toolCallId, stored, true);
			}
			verdicts.clear();
			return { wrapMiss, notify };
		},

		clear(): void {
			verdicts.clear();
			counters.clean = 0;
			counters.flagged = 0;
			counters.degraded = 0;
			counters.wrapMiss = 0;
		},

		stats(): ScreenStats {
			return { ...counters };
		},
	};
}
