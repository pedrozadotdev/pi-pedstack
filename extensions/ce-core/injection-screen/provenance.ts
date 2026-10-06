/**
 * Pure provenance classifier + bounded sample builder + screen-mode resolver.
 *
 * Decides whether a `bash`/`read` result came from a source the agent does not
 * control, produces a byte-bounded raw sample for the Jev screen, and resolves
 * `PEDSTACK_INJECTION_SCREEN`. No I/O, no Pi imports, no Jev imports.
 *
 * @module injection-screen/provenance
 */

import path from "node:path";
import { truncateToBytes } from "../jev/errors";

export type ProvenanceKind =
	| "http"
	| "gh-issue"
	| "gh-pr"
	| "gh-api"
	| "external-path";

export interface Provenance {
	kind: ProvenanceKind;
	ref: string;
}

export type ScreenMode = "off" | "shadow" | "enforce";

export interface ScreenModeReading {
	mode: ScreenMode;
	invalid: boolean;
}

export interface ClassifyProvenanceInput {
	toolName: string;
	input: Record<string, unknown>;
	repoRoot: string;
	realPath?: string;
	platform?: NodeJS.Platform;
}

export const MAX_SAMPLE_BYTES = 16384;

const HAS_HTTP = /https?:\/\//;
const FIRST_HTTP_URL = /https?:\/\/[^\s'"`<>]+/;
const GH_SUBCOMMAND = /\bgh\s+(issue|pr|api|release|search|run)\b/;
const GH_KIND_BY_SUBCOMMAND: Record<string, ProvenanceKind> = {
	issue: "gh-issue",
	pr: "gh-pr",
};

function isOutsideRepo(
	repoRoot: string,
	target: string,
	platform: NodeJS.Platform | undefined,
): boolean {
	try {
		let root = path.resolve(repoRoot);
		let resolved = path.resolve(target);
		if (platform === "darwin" || platform === "win32") {
			root = root.toLowerCase();
			resolved = resolved.toLowerCase();
		}
		if (resolved === root) return false;
		const prefix = root.endsWith(path.sep) ? root : root + path.sep;
		return !resolved.startsWith(prefix);
	} catch {
		return false;
	}
}

function matchGh(command: string): Provenance | null {
	const gh = GH_SUBCOMMAND.exec(command);
	if (!gh) return null;
	return { kind: GH_KIND_BY_SUBCOMMAND[gh[1]] ?? "gh-api", ref: command };
}

function matchHttp(command: string): Provenance | null {
	if (!HAS_HTTP.test(command)) return null;
	return { kind: "http", ref: FIRST_HTTP_URL.exec(command)?.[0] ?? command };
}

function classifyBash(rawInput: unknown): Provenance | null {
	if (typeof rawInput !== "object" || rawInput === null) return null;
	const command = (rawInput as { command?: unknown }).command;
	if (typeof command !== "string" || command.length === 0) return null;
	return matchGh(command) ?? matchHttp(command);
}

function classifyRead(input: ClassifyProvenanceInput): Provenance | null {
	const rawInput = input.input;
	if (typeof rawInput !== "object" || rawInput === null) return null;
	const rawPath = (rawInput as { path?: unknown }).path;
	if (typeof rawPath !== "string" || rawPath.length === 0) return null;

	const resolved = input.realPath ?? path.resolve(input.repoRoot, rawPath);
	if (!isOutsideRepo(input.repoRoot, resolved, input.platform)) return null;
	return { kind: "external-path", ref: rawPath };
}

/**
 * Classify a tool result. Malformed input never throws — it returns `null`
 * (not untrusted). Immutable rule order: `read` external-path first, then
 * `bash` gh subcommands, then any URL.
 */
export function classifyProvenance(
	input: ClassifyProvenanceInput,
): Provenance | null {
	try {
		const toolName = input?.toolName;
		if (toolName === "read") return classifyRead(input);
		if (toolName === "bash") return classifyBash(input?.input);
		return null;
	} catch {
		return null;
	}
}

export interface Sample {
	text: string;
	truncated: boolean;
}

/**
 * Head+tail byte-bounded sample. Bytes, not characters, and UTF-8 safe at both
 * cuts so a multi-byte code point is never split.
 */
export function buildSample(raw: string, maxBytes = MAX_SAMPLE_BYTES): Sample {
	const text = typeof raw === "string" ? raw : "";
	const buffer = Buffer.from(text, "utf8");
	if (buffer.byteLength <= maxBytes) return { text, truncated: false };

	const half = Math.floor(maxBytes / 2);
	const head = truncateToBytes(text, half);
	// ponytail: head reuses the shared boundary walker; tail is a 3-line
	// forward walk (skip leading continuation bytes) rather than a new utility.
	let start = buffer.byteLength - half;
	while (start < buffer.byteLength && (buffer[start] & 0xc0) === 0x80) start++;
	const tail = buffer.subarray(start).toString("utf8");
	const omitted =
		buffer.byteLength -
		Buffer.byteLength(head, "utf8") -
		Buffer.byteLength(tail, "utf8");

	return {
		text: `${head}\n[... ${omitted} bytes omitted ...]\n${tail}`,
		truncated: true,
	};
}

/**
 * Resolve `PEDSTACK_INJECTION_SCREEN`. Missing/empty values and any
 * unrecognized value resolve to `shadow`; the latter is flagged `invalid` so
 * the operator gets one warning. Never resolves to `off` by accident.
 */
export function resolveScreenMode(
	env: Record<string, string | undefined>,
): ScreenModeReading {
	const value = env.PEDSTACK_INJECTION_SCREEN;
	if (value === "off") return { mode: "off", invalid: false };
	if (value === "enforce") return { mode: "enforce", invalid: false };
	if (value === "shadow" || value === undefined || value === "") {
		return { mode: "shadow", invalid: false };
	}
	return { mode: "shadow", invalid: true };
}
