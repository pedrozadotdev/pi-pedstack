// Docs verification — pure unit extraction, identity, and evidence grammar
// (plan Unit 1). No filesystem access; every input is text or an injected fact.
import { createHash } from "node:crypto";
import { normalizeSlug } from "../utils/name-utils";
import type {
	DocsPhase,
	DocsUnit,
	EvidenceFact,
	PackageFact,
	UnitFacts,
} from "./types";

const UNIT_HEADING = /^###\s+Unit\b[^\n]*$/gim;

/** Non-package tokens that appear backticked in plan prose (R2 noise guard). */
const NON_PACKAGES = new Set([
	"api",
	"bash",
	"bun",
	"contextqmd",
	"docs-verified",
	"git",
	"github",
	"green",
	"html",
	"jev",
	"json",
	"node",
	"npm",
	"pnpm",
	"red",
	"readme",
	"refactor",
	"tdd",
	"ts",
	"tsc",
	"tsx",
	"typescript",
	"yaml",
	"yarn",
]);

/** JSON with object keys sorted at every depth; array order preserved. */
function stableStringify(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) {
		return `[${value.map(stableStringify).join(",")}]`;
	}
	const entries = Object.entries(value as Record<string, unknown>)
		.filter(([, item]) => item !== undefined)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	return `{${entries
		.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
		.join(",")}}`;
}

function hashText(text: string): string {
	return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function slugFromHeading(heading: string): string {
	const withoutNumber = heading.replace(/^Unit\s+\d+\s*[—–:-]*\s*/i, "");
	return normalizeSlug(withoutNumber) || "unit";
}

function uniqueSlug(heading: string, used: Map<string, number>): string {
	const base = slugFromHeading(heading);
	const count = used.get(base) ?? 0;
	used.set(base, count + 1);
	return count === 0 ? base : `${base}-${count + 1}`;
}

/** True for a repo-relative path token (contains a slash or a file extension). */
function looksLikePath(value: string): boolean {
	if (value.includes(" ") || value.includes("`")) return false;
	return value.includes("/") || /\.[a-z0-9]+$/i.test(value);
}

/** Body of the unit's `Files` list, up to the next bold label or heading. */
function filesSection(unitText: string): string {
	const lines = unitText.split(/\r?\n/);
	const start = lines.findIndex((line) =>
		/^\s*\*{0,2}\s*Files\b/i.test(line) || /^\s*Files\s*:/i.test(line),
	);
	if (start === -1) return "";
	const out: string[] = [];
	for (let i = start + 1; i < lines.length; i++) {
		const line = lines[i];
		if (/^#{1,6}\s/.test(line)) break;
		if (/^\s*\*{0,2}\s*[A-Z][A-Za-z ]+\*{0,2}\s*[:.]?\s*$/.test(line)) break;
		out.push(line);
	}
	return out.join("\n");
}

export function extractUnits(planText: string, _phase: DocsPhase): DocsUnit[] {
	const matches = [...planText.matchAll(UNIT_HEADING)];
	const used = new Map<string, number>();
	const units: DocsUnit[] = [];
	for (let index = 0; index < matches.length; index++) {
		const match = matches[index];
		const start = match.index ?? 0;
		const next = matches[index + 1];
		const end = next?.index ?? planText.length;
		const block = planText.slice(start, end).replace(/\s+$/, "");
		const heading = match[0].replace(/^###\s*/, "").trim();
		units.push({
			slug: uniqueSlug(heading, used),
			heading,
			hash: hashText(block),
			files: parseDeclaredFiles(block),
			text: block,
		});
	}
	return units;
}

export function parseDeclaredFiles(unitText: string): string[] {
	const found = new Set<string>();
	for (const match of filesSection(unitText).matchAll(/`([^`\n]+)`/g)) {
		const value = match[1].trim();
		if (looksLikePath(value)) found.add(value);
	}
	return [...found].sort();
}

/** Candidate package names written literally in the unit text (deduped, sorted). */
export function parsePlannedPackages(unitText: string): string[] {
	const found = new Set<string>();
	for (const match of unitText.matchAll(/`([^`\n]+)`/g)) {
		const token = match[1].trim();
		if (isPackageName(token)) found.add(token);
	}
	for (const match of unitText.matchAll(/@[a-z0-9][\w.-]*\/[a-z0-9][\w.-]*/gi)) {
		if (isPackageName(match[0])) found.add(match[0]);
	}
	return [...found].sort();
}

function isPackageName(token: string): boolean {
	if (token.length === 0 || token.includes(" ") || token.includes("`")) return false;
	if (token.startsWith("@")) {
		return /^@[a-z0-9][\w.-]*\/[a-z0-9][\w.-]*$/i.test(token);
	}
	if (!/^[a-z][a-z0-9._-]*$/.test(token)) return false;
	if (NON_PACKAGES.has(token)) return false;
	// Stage keys and date-ish tokens are not packages.
	if (/^\d{2}-/.test(token)) return false;
	return true;
}

export function parseEvidenceLines(unitText: string): string[] {
	return unitText
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => /^docs-verified:/.test(line));
}

const EVIDENCE_LINE = /^docs-verified:\s+(\S+)\s+(\S+)$/;

/** A `contextqmd` `--doc-path` or `--page-uid`: no whitespace, path- or uid-like. */
function looksLikeDocRef(value: string): boolean {
	if (value.length < 3) return false;
	if (!/^[A-Za-z0-9][\w./@:-]*$/.test(value)) return false;
	return value.includes("/") || value.includes(".");
}

/**
 * Format + package/version match only (never content match). Returns the
 * accepted fact or null when the line is malformed or names a different
 * package/version than the unit's facts allow (R5).
 */
export function validateEvidenceLine(
	line: string,
	fact: PackageFact,
): EvidenceFact | null {
	const match = EVIDENCE_LINE.exec(line.trim());
	if (!match) return null;
	const [, specifier, docRef] = match;
	const at = specifier.lastIndexOf("@");
	if (at <= 0 || at === specifier.length - 1) return null;
	const name = specifier.slice(0, at);
	const version = specifier.slice(at + 1);
	if (name !== fact.name || !looksLikeDocRef(docRef)) return null;
	const versionOk = fact.versionUnknown
		? version === "unknown" || version === fact.version
		: version === fact.version;
	if (!versionOk) return null;
	return { package: name, version, docRef, valid: true };
}

/** Version facts are canonicalized to `name@version` for hashing. */
function packageKeys(facts: UnitFacts): string[] {
	return facts.packages
		.map((entry) => `${entry.name}@${entry.version ?? "unknown"}`)
		.sort();
}

function evidenceKeys(facts: UnitFacts): string[] {
	return facts.evidence
		.map((entry) => `${entry.package}@${entry.version} ${entry.docRef}`)
		.sort();
}

/**
 * Content hash covering the block text, the sorted Files list, the sorted
 * `package@version` facts, the evidence state, and (observed phase) the content
 * hashes of existing declared files (R2/R7).
 */
export function unitContentHash(
	unit: DocsUnit,
	facts: UnitFacts,
	observedFileHashes: Map<string, string> = new Map(),
): string {
	const canonical = stableStringify({
		text: unit.text,
		files: [...unit.files].sort(),
		packages: packageKeys(facts),
		evidence: evidenceKeys(facts),
		observed: [...observedFileHashes.entries()]
			.map(([file, hash]) => `${file}:${hash}`)
			.sort(),
	});
	return hashText(canonical);
}
