// `docs_verification` model-facing tool (plan Unit 7). Operations: evaluate,
// status, record, waive. Every outcome is enumerated; only an unknown operation
// throws (caught at the Pi registration boundary).
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Type } from "typebox";
import { createJevRuntime } from "../jev/runtime";
import type { JevRuntime } from "../jev/types";
import {
	createDocsVerificationGuard,
	type DocsVerificationGuard,
	type DocsVerificationGuardDeps,
} from "../docs-verification/guard";
import {
	newestPlanPath,
	planSlugFromPath,
	readDocsRecord,
	writeDocsRecord,
} from "../docs-verification/store";
import { validateEvidenceLine } from "../docs-verification/units";
import type {
	DocsEvidenceSource,
	DocsObligation,
	DocsPhase,
	DocsUnitRecord,
	DocsVerificationMode,
	DocsVerificationRecord,
	EvidenceFact,
} from "../docs-verification/types";

export const docsVerificationParams = Type.Object({
	operation: Type.Union(
		[
			Type.Literal("evaluate"),
			Type.Literal("status"),
			Type.Literal("record"),
			Type.Literal("waive"),
		],
		{ description: "Which docs-verification operation to run" },
	),
	repoRoot: Type.String({ description: "Repository root" }),
	planPath: Type.Optional(
		Type.String({
			description: "Repo-relative plan path; defaults to the newest docs/plans/*.md",
		}),
	),
	phase: Type.Optional(
		Type.Union([Type.Literal("planned"), Type.Literal("observed")], {
			description: "Facts phase; planned at 02-plan, observed at 03-work",
		}),
	),
	planText: Type.Optional(
		Type.String({ description: "Plan text; read from planPath when omitted" }),
	),
	slug: Type.Optional(Type.String({ description: "Unit slug" })),
	line: Type.Optional(
		Type.String({ description: "A `docs-verified: PACKAGE@VERSION DOC_REF` line" }),
	),
	reason: Type.Optional(
		Type.String({ description: "Waiver reason (required for waive)" }),
	),
});

export interface DocsVerificationToolDeps extends Partial<
	Omit<DocsVerificationGuardDeps, "mode" | "failClosed" | "createJev">
> {
	mode: DocsVerificationMode;
	failClosed: boolean;
	/** Injected runtime for tests; lazily created otherwise. */
	runtime?: JevRuntime;
}

export interface DocsVerificationToolInput {
	operation: "evaluate" | "status" | "record" | "waive";
	repoRoot: string;
	planPath?: string;
	phase?: DocsPhase;
	planText?: string;
	slug?: string;
	line?: string;
	reason?: string;
}

interface DocsVerificationToolResult {
	operation: string;
	found?: boolean;
	gated?: boolean;
	allowed?: boolean;
	blocker?: string;
	warning?: string;
	decision?: string;
	obligations?: DocsObligation[];
	source?: DocsEvidenceSource;
	reused?: boolean;
	record?: DocsVerificationRecord;
	recorded?: boolean;
	waived?: boolean;
	evidence?: EvidenceFact;
	reason?: string;
}

interface ToolContext {
	guard: DocsVerificationGuard;
	readRecord: (
		repoRoot: string,
		planSlug: string,
	) => Promise<DocsVerificationRecord | null>;
	writeRecord: (
		repoRoot: string,
		record: DocsVerificationRecord,
	) => Promise<string> | string;
	now: () => Date;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function resolvePath(input: DocsVerificationToolInput): Promise<string | null> {
	return input.planPath ?? (await newestPlanPath(input.repoRoot));
}

async function evaluateOp(
	ctx: ToolContext,
	input: DocsVerificationToolInput,
): Promise<DocsVerificationToolResult> {
	const planPath = await resolvePath(input);
	if (!planPath) {
		return {
			operation: "evaluate",
			found: false,
			gated: false,
			allowed: true,
			warning: "no plan resolved",
		};
	}
	let planText = input.planText;
	if (typeof planText !== "string") {
		try {
			planText = await readFile(path.join(input.repoRoot, planPath), "utf8");
		} catch {
			planText = undefined;
		}
	}
	if (typeof planText !== "string") {
		return {
			operation: "evaluate",
			found: false,
			gated: false,
			allowed: true,
			warning: "plan could not be read",
		};
	}
	const result = await ctx.guard.evaluate({
		repoRoot: input.repoRoot,
		planPath,
		phase: input.phase ?? "planned",
		planText,
	});
	return { operation: "evaluate", ...result };
}

async function statusOp(
	ctx: ToolContext,
	input: DocsVerificationToolInput,
): Promise<DocsVerificationToolResult> {
	const planPath = await resolvePath(input);
	if (!planPath) return { operation: "status", found: false };
	const record = await ctx.readRecord(
		input.repoRoot,
		planSlugFromPath(planPath),
	);
	if (!record) return { operation: "status", found: false };
	return { operation: "status", found: true, record };
}

function matchEvidenceLine(
	unit: DocsUnitRecord,
	line: string,
): EvidenceFact | undefined {
	for (const fact of unit.facts.packages) {
		const validated = validateEvidenceLine(line, fact);
		if (validated) return validated;
	}
	return undefined;
}

function satisfiedUnit(
	entry: DocsUnitRecord,
	evidence: EvidenceFact,
	updatedAt: string,
): DocsUnitRecord {
	return {
		...entry,
		source: "fallback",
		obligation: {
			slug: entry.slug,
			status: "satisfied",
			decision: "not_required",
			packages: entry.packages,
			source: "fallback",
			evidence,
			updatedAt,
		},
	};
}

async function recordOp(
	ctx: ToolContext,
	input: DocsVerificationToolInput,
): Promise<DocsVerificationToolResult> {
	const planPath = await resolvePath(input);
	if (!planPath || !input.slug || !input.line) {
		return {
			operation: "record",
			recorded: false,
			reason: "plan, slug, and line are required",
		};
	}
	const record = await ctx.readRecord(
		input.repoRoot,
		planSlugFromPath(planPath),
	);
	if (!record) {
		return {
			operation: "record",
			recorded: false,
			reason: "no docs-verification record; run evaluate first",
		};
	}
	const unit = record.units.find((entry) => entry.slug === input.slug);
	if (!unit) {
		return {
			operation: "record",
			recorded: false,
			reason: `unknown unit "${input.slug}"`,
		};
	}
	const matched = matchEvidenceLine(unit, input.line);
	if (!matched) {
		return {
			operation: "record",
			recorded: false,
			reason:
				"the docs-verified line is malformed or names a package/version the unit does not touch",
		};
	}
	const updatedAt = ctx.now().toISOString();
	await ctx.writeRecord(input.repoRoot, {
		...record,
		updatedAt,
		units: record.units.map((entry) =>
			entry.slug === input.slug
				? satisfiedUnit(entry, matched, updatedAt)
				: entry,
		),
	});
	return { operation: "record", recorded: true, evidence: matched };
}

async function waiveOp(
	ctx: ToolContext,
	input: DocsVerificationToolInput,
): Promise<DocsVerificationToolResult> {
	if (!input.reason || input.reason.trim().length === 0) {
		return {
			operation: "waive",
			waived: false,
			reason: "waive requires a non-empty reason",
		};
	}
	const planPath = await resolvePath(input);
	if (!planPath || !input.slug) {
		return {
			operation: "waive",
			waived: false,
			reason: "plan and slug are required",
		};
	}
	const result = await ctx.guard.waive({
		repoRoot: input.repoRoot,
		planPath,
		slug: input.slug,
		reason: input.reason,
	});
	return { operation: "waive", waived: true, ...result };
}

const OPERATIONS: Record<
	string,
	(ctx: ToolContext, input: DocsVerificationToolInput) => Promise<DocsVerificationToolResult>
> = {
	evaluate: evaluateOp,
	status: statusOp,
	record: recordOp,
	waive: waiveOp,
};

/** Creates the `docs_verification` tool with the mode resolved once at init. */
export function createDocsVerificationTool(deps: DocsVerificationToolDeps) {
	const ctx: ToolContext = {
		guard: createDocsVerificationGuard({
			mode: deps.mode,
			failClosed: deps.failClosed,
			createJev: () => deps.runtime ?? createJevRuntime(),
			now: deps.now,
			facts: deps.facts,
			readFile: deps.readFile,
			fileExists: deps.fileExists,
			readRecord: deps.readRecord,
			writeRecord: deps.writeRecord,
			logRecord: deps.logRecord,
		}),
		readRecord: deps.readRecord ?? readDocsRecord,
		writeRecord: deps.writeRecord ?? writeDocsRecord,
		now: deps.now ?? (() => new Date()),
	};

	return {
		name: "docs_verification",
		async execute(
			input: DocsVerificationToolInput,
		): Promise<DocsVerificationToolResult> {
			const operation = OPERATIONS[input.operation];
			if (!operation) {
				throw new Error(`unknown operation "${String(input.operation)}"`);
			}
			try {
				return await operation(ctx, input);
			} catch (error) {
				return {
					operation: String(input.operation),
					warning: `docs verification failed open: ${errorMessage(error)}`,
					allowed: true,
				};
			}
		},
	};
}
