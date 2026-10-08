// Chunk long 02-plan artifacts for bounded, complete semantic evaluation.
import type { SemanticScoreInput } from "./types";

export const MAX_PLAN_UNIT_REQUESTS = 32;
const UNIT_TEXT_BYTES = 16 * 1024;
const COMMON_CONTEXT_BYTES = 4 * 1024;

export interface PlanUnitChunk {
  label: string;
  artifact: string;
}

function utf8Chunks(text: string, maxBytes: number): string[] {
  const parts: string[] = [];
  let current = "";
  let size = 0;
  for (const character of text) {
    const bytes = Buffer.byteLength(character, "utf8");
    if (size + bytes > maxBytes && current) {
      parts.push(current);
      current = "";
      size = 0;
    }
    current += character;
    size += bytes;
  }
  if (current) parts.push(current);
  return parts;
}

/**
 * Parse ### Unit headings from the FULL plan, stopping a unit at the next
 * same/higher-level heading (including ## Strict Review).
 * The shared preamble is capped, but no unit's own text is silently omitted.
 */
export function planUnitChunks(plan: string): PlanUnitChunk[] {
  const heading = /^#{1,3}\s+[^\r\n]+/gm;
  const matches = [...plan.matchAll(heading)];
  const unitHeadings = matches.filter((match) => /^###\s+Unit\b/i.test(match[0]));
  if (unitHeadings.length === 0) return [];

  const context = utf8Chunks(plan.slice(0, unitHeadings[0].index), COMMON_CONTEXT_BYTES)[0] ?? "";
  const closing = utf8Chunks(plan.slice(unitHeadings[unitHeadings.length - 1].index), COMMON_CONTEXT_BYTES).at(-1) ?? "";
  const chunks: PlanUnitChunk[] = [];
  for (let i = 0; i < unitHeadings.length; i++) {
    const current = unitHeadings[i];
    const next = matches.find((m) => m.index > current.index &&
      (m[0].startsWith("## ") || /^###\s+Unit\b/i.test(m[0])));
    const end = next?.index ?? plan.length;
    const body = plan.slice(current.index, end);
    const slices = utf8Chunks(body, UNIT_TEXT_BYTES);
    const unitOverview = utf8Chunks(body, 1024)[0] ?? "";
    for (let part = 0; part < slices.length; part++) {
      const label = `Unit ${i + 1} (${part + 1}/${slices.length})`;
      chunks.push({
        label,
        artifact: `Shared plan context (bounded):\n${context}\n\n${label}: ${current[0]}\nUnit overview (bounded):\n${unitOverview}\n\nUnit segment:\n${slices[part]}\n\nClosing verification context (bounded):\n${closing}`,
      });
    }
  }
  return chunks;
}

/** Conservative aggregation: a weak or unscored unit cannot be masked. */
export function aggregateUnitScores(
  groups: SemanticScoreInput[][],
  expectedIds: string[],
): SemanticScoreInput[] | null {
  if (groups.length === 0) return null;
  const combined = new Map<string, SemanticScoreInput>();
  for (const group of groups) {
    for (const id of expectedIds) {
      const score = group.find((entry) => entry.id === id);
      if (!score || !Number.isFinite(score.score)) return null;
      const previous = combined.get(id);
      if (!previous || score.score < previous.score) combined.set(id, score);
    }
  }
  return expectedIds.map((id) => combined.get(id)!);
}
