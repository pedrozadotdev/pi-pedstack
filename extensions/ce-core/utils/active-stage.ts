/**
 * Durable active-stage store for the stage capability guard.
 *
 * Tracks the currently active Pedstack stage in memory for the live session
 * and in a small dedicated `active-stage.json` side file for restart/resume.
 * The persisted value is intentionally gated on an existing
 * `context-state.json`: a stage written before any workflow handoff exists
 * (for example during `01-brainstorm`) must not enable enforcement later.
 *
 * This module never touches `context-state.json`; it is read-only there.
 *
 * @module active-stage
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/** Repo-relative location of the persisted active-stage side file. */
export const ACTIVE_STAGE_FILE =
	".context/compound-engineering/active-stage.json";

/** Repo-relative location of the workflow-in-progress gate file. */
const CONTEXT_STATE_FILE = ".context/compound-engineering/context-state.json";

// ponytail: Module-level stage for the live session. Per-session only; the
// persisted side file covers process restarts.
let activeStage: string | null = null;

/** Set the in-memory active stage (`null` clears it). */
export function setActiveStage(stage: string | null): void {
	activeStage = stage;
}

/** Read the in-memory active stage, or `null` when none is active. */
export function getActiveStage(): string | null {
	return activeStage;
}

/** Clear the in-memory active stage (persisted file is left untouched). */
export function clearActiveStage(): void {
	activeStage = null;
}

/**
 * Persist the active stage to `active-stage.json`, creating directories.
 *
 * Throws on I/O failure; callers are expected to catch and continue, since
 * persistence is best-effort and the in-memory value still guards the session.
 * Never creates `context-state.json`.
 */
export async function persistActiveStage(
	repoRoot: string,
	stage: string,
): Promise<void> {
	const filePath = path.join(repoRoot, ACTIVE_STAGE_FILE);
	await mkdir(path.dirname(filePath), { recursive: true });
	const payload = { activeStage: stage, updatedAt: new Date().toISOString() };
	await writeFile(filePath, JSON.stringify(payload, null, 2), "utf8");
}

/**
 * Read the persisted active stage.
 *
 * Returns a value only when `context-state.json` exists and carries a string
 * `currentStage` (workflow in progress). Missing/corrupt files return `null`
 * and never throw.
 */
export async function readPersistedActiveStage(
	repoRoot: string,
): Promise<string | null> {
	const state = await readJsonObject(path.join(repoRoot, CONTEXT_STATE_FILE));
	if (!state || typeof state.currentStage !== "string") return null;

	const active = await readJsonObject(path.join(repoRoot, ACTIVE_STAGE_FILE));
	if (!active || typeof active.activeStage !== "string") return null;

	return active.activeStage;
}

/** Read and parse a JSON object, returning `null` for any failure. */
async function readJsonObject(
	filePath: string,
): Promise<Record<string, unknown> | null> {
	try {
		const content = await readFile(filePath, "utf8");
		const parsed: unknown = JSON.parse(content);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return null;
		}
		return parsed as Record<string, unknown>;
	} catch {
		return null;
	}
}
