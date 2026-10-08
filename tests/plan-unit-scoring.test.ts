import { describe, expect, test } from "bun:test";
import { aggregateUnitScores, MAX_PLAN_UNIT_REQUESTS, planUnitChunks } from "../extensions/ce-core/stage-gate/plan-unit-scoring";
import type { SemanticScoreInput } from "../extensions/ce-core/stage-gate/types";

function score(id: string, value: number): SemanticScoreInput {
  return { id, score: value, levels: 5, confidence: 0.9, weight: 1 };
}

describe("plan unit semantic chunking", () => {
  test("reads every unit through the end of the plan, including internal headings", () => {
    const plan = `# Plan
## Problem summary
Context.
## Implementation units
### Unit 1 — Alpha
**Files.** \`src/a.ts\`
### Cases
A nested section.
### Unit 2 — Beta
**Files.** \`src/b.ts\`
## Strict Review
Checklist.
`;
    const parts = planUnitChunks(plan);
    expect(parts).toHaveLength(2);
    expect(parts[0].artifact).toContain("A nested section");
    expect(parts[0].artifact.split("Closing verification context")[0]).not.toContain("src/b.ts");
    expect(parts[1].artifact).toContain("src/b.ts");
    expect(parts[1].artifact).toContain("Closing verification context");
    expect(MAX_PLAN_UNIT_REQUESTS).toBeGreaterThan(2);
  });

  test("a huge UTF-8 unit is partitioned without losing any bytes", () => {
    const unitBody = "á🧪\n".repeat(12000);
    const plan = `## Implementation units\n### Unit 1 — Test\n${unitBody}\n## Strict Review\nDone.`;
    const parts = planUnitChunks(plan);
    expect(parts.length).toBeGreaterThan(2);
    const actual = parts.map(p => p.artifact.split("Unit 1 (")[1]!.split("\n").slice(1).join("\n").split("\n\nClosing verification context")[0]).join("");
    expect(actual).toContain("🧪");
    for (const part of parts) expect(Buffer.byteLength(part.artifact, "utf8")).toBeLessThan(25 * 1024);
  });

  test("conservatively aggregates every dimension and rejects incomplete groups", () => {
    const dims = ["unit_atomicity", "test_plan_coherent"];
    const a = [score(dims[0], 4), score(dims[1], 3)];
    const b = [score(dims[0], 1), score(dims[1], 4)];
    expect(aggregateUnitScores([a, b], dims)?.map(s => s.score)).toEqual([1, 3]);
    expect(aggregateUnitScores([a, [score(dims[0], 4)]], dims)).toBeNull();
    expect(aggregateUnitScores([], dims)).toBeNull();
  });
});
