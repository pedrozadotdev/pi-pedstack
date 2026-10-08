// Wiring for docs-verification: the save-side evaluation hook, the injected
// open-obligation block, and the tool registration. There is deliberately only
// ONE `before_agent_start` handler (in `index.ts`); this module exposes helpers.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createJevRuntime } from "../jev/runtime";
import type { JevRuntime } from "../jev/types";
import { extractStageKey } from "../commands/prompt-inject";
import {
	createDocsVerificationGuard,
	type DocsVerificationGuard,
	type DocsVerificationGuardDeps,
} from "../docs-verification/guard";
import { resolveActivePlan } from "../docs-verification/store";
import {
	createDocsVerificationTool,
	docsVerificationParams,
} from "../tools/docs-verification";
import type {
	DocsObligation,
	DocsPhase,
	DocsVerificationMode,
	DocsVerificationResult,
} from "../docs-verification/types";

/** Stages that run the runtime docs-verification trigger. */
const DOCS_STAGES: ReadonlySet<string> = new Set(["02-plan", "03-work"]);

export interface DocsVerificationWiringOptions {
	mode: DocsVerificationMode;
	failClosed: boolean;
	runtime?: JevRuntime;
	/** Test seam forwarded to the guard. */
	deps?: Partial<
		Omit<DocsVerificationGuardDeps, "mode" | "failClosed" | "createJev">
	>;
	/** Test seam: use a prebuilt guard. */
	guard?: DocsVerificationGuard;
}

export interface DocsVerificationSaveInput {
	repoRoot: string;
	currentStage: string;
	nextStage?: string;
}

export interface DocsVerificationSaveRun {
	blocked: boolean;
	blocker?: string;
	warning?: string;
	result?: DocsVerificationResult;
}

export interface DocsVerificationWiring {
	guard: DocsVerificationGuard;
	run(input: DocsVerificationSaveInput): Promise<DocsVerificationSaveRun>;
	buildAppend(input: {
		repoRoot: string;
		skillPath: string | null;
	}): Promise<string | undefined>;
	register(pi: ExtensionAPI): void;
}

function docsPhaseForStage(stage: string | null): DocsPhase | null {
	if (stage === "02-plan") return "planned";
	if (stage === "03-work") return "observed";
	return null;
}

const VERIFICATION_STEPS = [
	"1. Identify the package and version from the unit's dependency facts.",
	"2. Check official documentation for that package/version using available tools.",
	"3. Verify the API or pattern and retain its authoritative URL or stable documentation path.",
	"4. Add a line to the unit: `docs-verified: <package>@<version> <documentation-url-or-path>`.",
	"5. If authoritative documentation is unavailable, use `docs_verification` to waive with an explicit reason; do not invent evidence.",
];

/** Bounded block naming open obligations and tool-agnostic verification steps. */
function formatDocsVerificationBlock(
	obligations: DocsObligation[],
): string {
	const lines = obligations.map(
		(entry) =>
			`- ${entry.slug} (${entry.decision}): ${
				entry.packages.join(", ") || "packages not yet provable"
			}`,
	);
	return [
		"## Docs-verification obligations (runtime)",
		"",
		"The runtime detected open source-verification obligation(s):",
		...lines,
		"",
		"Close each with evidence from official documentation:",
		...VERIFICATION_STEPS,
		"",
	].join("\n");
}

export function createDocsVerificationWiring(
	options: DocsVerificationWiringOptions,
): DocsVerificationWiring {
	const guard =
		options.guard ??
		createDocsVerificationGuard({
			mode: options.mode,
			failClosed: options.failClosed,
			createJev: () => options.runtime ?? createJevRuntime(),
			...(options.deps ?? {}),
		});

	async function evaluateStage(
		repoRoot: string,
		stage: string | null,
	): Promise<DocsVerificationResult | null> {
		const phase = docsPhaseForStage(stage);
		if (!phase) return null;
		const plan = await resolveActivePlan(repoRoot);
		if (!plan) return null;
		return guard.evaluate({
			repoRoot,
			planPath: plan.path,
			phase,
			planText: plan.text,
		});
	}

	async function run(
		input: DocsVerificationSaveInput,
	): Promise<DocsVerificationSaveRun> {
		if (options.mode === "off") return { blocked: false };
		if (!DOCS_STAGES.has(input.currentStage)) return { blocked: false };
		try {
			const result = await evaluateStage(input.repoRoot, input.currentStage);
			if (!result) return { blocked: false };
			if (result.gated && !result.allowed) {
				return {
					blocked: true,
					blocker: result.blocker,
					warning: result.warning,
					result,
				};
			}
			return { blocked: false, warning: result.warning, result };
		} catch (error) {
			return {
				blocked: false,
				warning: `docs verification failed open: ${
					error instanceof Error ? error.message : String(error)
				}`,
			};
		}
	}

	async function buildAppend(input: {
		repoRoot: string;
		skillPath: string | null;
	}): Promise<string | undefined> {
		try {
			if (options.mode === "off") return undefined;
			const stage = input.skillPath ? extractStageKey(input.skillPath) : null;
			if (!stage || !DOCS_STAGES.has(stage)) return undefined;
			const result = await evaluateStage(input.repoRoot, stage);
			if (!result) return undefined;
			const open = result.obligations.filter((entry) => entry.status === "open");
			if (open.length === 0) return undefined;
			return formatDocsVerificationBlock(open);
		} catch {
			return undefined;
		}
	}

	function register(pi: ExtensionAPI): void {
		const tool = createDocsVerificationTool({
			mode: options.mode,
			failClosed: options.failClosed,
			runtime: options.runtime,
			...(options.deps ?? {}),
		});
		pi.registerTool({
			name: tool.name,
			label: "Docs Verification",
			description:
				"Evaluate, inspect, record, or waive source-driven documentation verification obligations.",
			parameters: docsVerificationParams,
			async execute(_toolCallId, params) {
				try {
					const result = await tool.execute(params);
					return {
						content: [{ type: "text", text: JSON.stringify(result) }],
						details: result,
					};
				} catch (error) {
					const failure = {
						operation: String(params.operation),
						allowed: true,
						warning: `docs_verification error: ${
							error instanceof Error ? error.message : String(error)
						}`,
					};
					return {
						content: [{ type: "text", text: failure.warning }],
						details: failure,
						isError: true,
					};
				}
			},
		});
	}

	return { guard, run, buildAppend, register };
}
