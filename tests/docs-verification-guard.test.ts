// Docs verification — guard precedence, obligation lifecycle, outage, fallback,
// waiver (plan Unit 5).
import { describe, expect, test } from "bun:test";
import { createFakeJevRuntime } from "../extensions/ce-core/jev/runtime.js";
import type { JevProcessOutput, JevRequest } from "../extensions/ce-core/jev/types.js";
import {
	createDocsVerificationGuard,
	type DocsVerificationGuardDeps,
	type DocsVerificationGuardInput,
} from "../extensions/ce-core/docs-verification/guard.js";
import { planSlugFromPath } from "../extensions/ce-core/docs-verification/store.js";
import type {
	DocsVerificationRecord,
	EvidenceFact,
	FactsInput,
	PackageFact,
	UnitFacts,
} from "../extensions/ce-core/docs-verification/types.js";

const PLAN_PATH = "docs/plans/2026-10-06-x.md";

function pkg(name: string): PackageFact {
	return { name, version: "1.0.0", versionUnknown: false, kind: "peer" };
}

function evidenceFor(fact: PackageFact): EvidenceFact {
	return {
		package: fact.name,
		version: fact.version ?? "unknown",
		docRef: "docs/typebox.md",
		valid: true,
	};
}

function factsFor(input: FactsInput): Promise<UnitFacts> {
	const text = input.unitText.toLowerCase();
	const packages: PackageFact[] = [];
	if (text.includes("alpha")) packages.push(pkg("typebox"));
	if (text.includes("gamma")) packages.push(pkg("left-pad"));
	const evidence =
		text.includes("docs-verified") && packages[0] ? [evidenceFor(packages[0])] : [];
	return Promise.resolve({
		phase: input.phase,
		declaredFiles: input.declaredFiles.map((path) => ({ path, exists: true })),
		packages,
		evidence,
		versionUnknown: false,
	});
}

function unitBlock(
	heading: string,
	file: string,
	options: { pkg?: string; evidence?: boolean } = {},
): string {
	const lines = [
		`### ${heading}`,
		"",
		"**Files.**",
		"",
		`- create \`${file}\``,
	];
	if (options.pkg) lines.push("", `Uses \`${options.pkg}\`.`);
	if (options.evidence) {
		lines.push("", "docs-verified: typebox@1.0.0 docs/typebox.md");
	}
	return lines.join("\n");
}

const PLAN = [
	unitBlock("Unit 1 — Alpha", "src/alpha.ts", { pkg: "typebox" }),
	"",
	unitBlock("Unit 2 — Beta", "src/beta.ts"),
	"",
	unitBlock("Unit 3 — Gamma", "src/gamma.ts", { pkg: "left-pad" }),
].join("\n");

function input(over: Partial<DocsVerificationGuardInput> = {}): DocsVerificationGuardInput {
	return {
		repoRoot: "/repo",
		planPath: PLAN_PATH,
		phase: "observed",
		planText: PLAN,
		...over,
	};
}

function successOutput(request: JevRequest, values: Record<string, number>): JevProcessOutput {
	const answers: Record<string, unknown> = {};
	for (const key of Object.keys(request.questions)) {
		const slug = key.split("__")[0];
		answers[key] = { type: "noul", noul: values[slug] ?? 0.9, confidence: 0.9 };
	}
	return {
		exitCode: 0,
		stdout: JSON.stringify({ answers, model: "typesafe/jev" }),
		stderr: "",
	};
}

interface Harness {
	guard: ReturnType<typeof createDocsVerificationGuard>;
	jev: ReturnType<typeof createFakeJevRuntime>;
	records: Map<string, DocsVerificationRecord>;
	writes: DocsVerificationRecord[];
	degraded: { value: boolean };
	values: Record<string, number>;
}

function makeGuard(over: Partial<DocsVerificationGuardDeps> = {}): Harness {
	const degraded = { value: false };
	const values: Record<string, number> = {};
	const jev = createFakeJevRuntime({
		handler: (request) =>
			degraded.value ? new Error("jev down") : successOutput(request, values),
	});
	const records = new Map<string, DocsVerificationRecord>();
	const writes: DocsVerificationRecord[] = [];
	const guard = createDocsVerificationGuard({
		mode: "shadow",
		failClosed: false,
		createJev: () => jev,
		now: () => new Date("2026-10-06T00:00:00.000Z"),
		facts: factsFor,
		readRecord: async (_repoRoot, slug) => records.get(slug) ?? null,
		writeRecord: (_repoRoot, record) => {
			records.set(planSlugFromPath(record.planPath), record);
			writes.push(record);
			return "memory";
		},
		logRecord: () => undefined,
		...over,
	});
	return { guard, jev, records, writes, degraded, values };
}

describe("Unit 5 — mode and short circuit", () => {
	test("off mode is never gated and performs no Jev call", async () => {
		const harness = makeGuard({ mode: "off" });
		const result = await harness.guard.evaluate(input());
		expect(result.gated).toBe(false);
		expect(result.allowed).toBe(true);
		expect(harness.writes).toEqual([]);
		expect(harness.jev.calls).toEqual([]);
	});

	test("a unit with no external-package facts makes no Jev call", async () => {
		const harness = makeGuard();
		const result = await harness.guard.evaluate(input());
		expect(harness.jev.calls).toHaveLength(1);
		const beta = result.obligations.find((entry) => entry.slug === "beta");
		expect(beta).toBeUndefined();
		expect(result.decision).toBe("required");
	});
});

describe("Unit 5 — freshness and reuse", () => {
	test("an unchanged plan reuses every entry with zero new Jev calls", async () => {
		const harness = makeGuard();
		await harness.guard.evaluate(input());
		const callsAfterFirst = harness.jev.calls.length;
		const second = await harness.guard.evaluate(input());
		expect(harness.jev.calls.length).toBe(callsAfterFirst);
		expect(second.reused).toBe(true);
	});

	test("only a changed unit is re-scored", async () => {
		const harness = makeGuard();
		await harness.guard.evaluate(input());
		const callsAfterFirst = harness.jev.calls.length;
		const edited = PLAN.replace("src/gamma.ts", "src/gamma-renamed.ts");
		await harness.guard.evaluate(input({ planText: edited }));
		expect(harness.jev.calls.length).toBe(callsAfterFirst + 1);
	});
});

describe("Unit 5 — outage, fallback, recovery", () => {
	test("an outage yields uncertain/open/degraded and never satisfied", async () => {
		const harness = makeGuard();
		harness.degraded.value = true;
		const result = await harness.guard.evaluate(input());
		expect(result.source).toBe("degraded");
		const evaluated = result.obligations.filter((entry) =>
			["alpha", "gamma"].includes(entry.slug),
		);
		expect(evaluated).toHaveLength(2);
		for (const obligation of evaluated) {
			expect(obligation.status).toBe("open");
			expect(obligation.decision).toBe("uncertain");
		}
		expect(result.obligations.some((entry) => entry.status === "satisfied")).toBe(
			false,
		);
	});

	test("outage evidence closes an obligation as fallback", async () => {
		const plan = [
			unitBlock("Unit 1 — Alpha", "src/alpha.ts", {
				pkg: "typebox",
				evidence: true,
			}),
			"",
			unitBlock("Unit 3 — Gamma", "src/gamma.ts", { pkg: "left-pad" }),
		].join("\n");
		const harness = makeGuard();
		harness.degraded.value = true;
		const result = await harness.guard.evaluate(input({ planText: plan }));
		const alpha = result.obligations.find((entry) => entry.slug === "alpha");
		expect(alpha?.status).toBe("satisfied");
		expect(alpha?.source).toBe("fallback");
		expect(result.allowed).toBe(true);
	});

	test("a fallback obligation is re-scored on recovery", async () => {
		const plan = [
			unitBlock("Unit 1 — Alpha", "src/alpha.ts", {
				pkg: "typebox",
				evidence: true,
			}),
			"",
			unitBlock("Unit 3 — Gamma", "src/gamma.ts", { pkg: "left-pad" }),
		].join("\n");
		const harness = makeGuard();
		harness.degraded.value = true;
		await harness.guard.evaluate(input({ planText: plan }));
		harness.degraded.value = false;
		harness.values.alpha = 0.1;
		const recovered = await harness.guard.evaluate(input({ planText: plan }));
		const alpha = recovered.obligations.find((entry) => entry.slug === "alpha");
		expect(alpha?.status).toBe("satisfied");
		expect(alpha?.source).toBe("jev");
	});

	test("a disagreement re-opens the fallback obligation", async () => {
		const plan = [
			unitBlock("Unit 1 — Alpha", "src/alpha.ts", {
				pkg: "typebox",
				evidence: true,
			}),
			"",
			unitBlock("Unit 3 — Gamma", "src/gamma.ts", { pkg: "left-pad" }),
		].join("\n");
		const harness = makeGuard();
		harness.degraded.value = true;
		await harness.guard.evaluate(input({ planText: plan }));
		harness.degraded.value = false;
		harness.values.alpha = 0.9;
		const recovered = await harness.guard.evaluate(input({ planText: plan }));
		const alpha = recovered.obligations.find((entry) => entry.slug === "alpha");
		expect(alpha?.status).toBe("open");
		expect(alpha?.source).toBe("jev");
	});
});

describe("Unit 5 — waiver and modes", () => {
	test("a waive records a reason and does not block", async () => {
		const harness = makeGuard();
		await harness.guard.evaluate(input());
		const waived = await harness.guard.waive({
			repoRoot: "/repo",
			planPath: PLAN_PATH,
			slug: "alpha",
			reason: "known false positive",
		});
		expect(waived.allowed).toBe(true);
		const alpha = waived.obligations.find((entry) => entry.slug === "alpha");
		expect(alpha?.status).toBe("waived");
		expect(alpha?.reason).toBe("known false positive");
		const again = await harness.guard.evaluate(input());
		expect(
			again.obligations.find((entry) => entry.slug === "alpha")?.status,
		).toBe("waived");
	});

	test("a waived obligation re-opens when the unit hash changes", async () => {
		const harness = makeGuard();
		await harness.guard.evaluate(input());
		await harness.guard.waive({
			repoRoot: "/repo",
			planPath: PLAN_PATH,
			slug: "alpha",
			reason: "accepted",
		});
		const edited = PLAN.replace("src/alpha.ts", "src/alpha-renamed.ts");
		const result = await harness.guard.evaluate(input({ planText: edited }));
		expect(
			result.obligations.find((entry) => entry.slug === "alpha")?.status,
		).toBe("open");
	});

	test("enforce blocks an open obligation while shadow warns", async () => {
		const enforced = makeGuard({ mode: "enforce" });
		const blocked = await enforced.guard.evaluate(input());
		expect(blocked.allowed).toBe(false);
		expect(blocked.blocker).toBeDefined();

		const shadow = makeGuard({ mode: "shadow" });
		const warned = await shadow.guard.evaluate(input());
		expect(warned.allowed).toBe(true);
		expect(warned.warning).toBeDefined();
	});

	test("FAILCLOSED=1 blocks a degraded enforce and 0 fails open", async () => {
		const strict = makeGuard({ mode: "enforce", failClosed: true });
		strict.degraded.value = true;
		const blocked = await strict.guard.evaluate(input());
		expect(blocked.allowed).toBe(false);

		const lenient = makeGuard({ mode: "enforce", failClosed: false });
		lenient.degraded.value = true;
		const open = await lenient.guard.evaluate(input());
		expect(open.allowed).toBe(true);
		expect(open.warning).toBeDefined();
	});
});
