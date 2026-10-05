import type { JevErrorCode } from "./errors";

/** Content accepted by the System One `state` field and by `instructions`. */
export type JevContent = string | Record<string, unknown> | unknown[];

export type JevQuestionType = "noul" | "choice" | "score";

export interface JevNoulQuestion {
	type: "noul";
	instructions: JevContent;
	criteria?: { true?: string; false?: string };
}

export interface JevChoiceQuestion {
	type: "choice";
	instructions: JevContent;
	criteria: Record<string, string>;
}

export interface JevScoreQuestion {
	type: "score";
	instructions: JevContent;
	criteria: string[];
}

export type JevQuestion =
	| JevNoulQuestion
	| JevChoiceQuestion
	| JevScoreQuestion;

export interface JevRequest {
	state: JevContent;
	questions: Record<string, JevQuestion>;
}

export interface JevNoulAnswer {
	type: "noul";
	noul: number;
	confidence?: number;
}

export interface JevChoiceAnswer {
	type: "choice";
	choice: string;
	probabilities: Record<string, number>;
	confidence: number;
}

export interface JevScoreAnswer {
	type: "score";
	score: number;
	legend: Record<string, string>;
	probabilities: Record<string, number>;
	confidence: number;
}

export type JevAnswer = JevNoulAnswer | JevChoiceAnswer | JevScoreAnswer;

export interface JevUsage {
	input_tokens: number;
	output_tokens: number;
}

export interface JevResult {
	answers: Record<string, JevAnswer>;
	model: string;
	usage?: JevUsage;
	warnings: string[];
}

export interface JevProcessInput {
	command: string;
	args: string[];
	stdin: string;
	cwd?: string;
	timeoutMs: number;
	signal?: AbortSignal;
}

export interface JevProcessOutput {
	exitCode: number;
	stdout: string;
	stderr: string;
	truncated?: boolean;
}

export interface JevProcessRunner {
	run(input: JevProcessInput): Promise<JevProcessOutput>;
}

export interface JevCreateProcessOptions {
	graceMs?: number;
}

export interface JevDecisionRecord {
	noul?: number;
	choice?: string;
	score?: number;
	confidence?: number;
}

export interface JevTelemetryEvent {
	outcome: "success" | "failure";
	durationMs: number;
	model: string;
	questionIds: string[];
	questionTypes: JevQuestionType[];
	decisions?: Record<string, JevDecisionRecord>;
	usage?: JevUsage;
	exitCode?: number;
	errorCode?: JevErrorCode;
	stateBytes: number;
	requestBytes: number;
	stdoutBytes: number;
	stderrBytes: number;
	warnings: string[];
}

export type JevTelemetrySink = (event: JevTelemetryEvent) => void;

export interface JevRuntimeOptions {
	process?: JevProcessRunner;
	command?: string;
	timeoutMs?: number;
	cwd?: string;
	repoRoot?: string;
	telemetry?: JevTelemetrySink;
	now?: () => number;
	redactIds?: boolean;
	platform?: NodeJS.Platform;
}

export interface JevDecideOptions {
	timeoutMs?: number;
	cwd?: string;
	signal?: AbortSignal;
}

export interface JevRuntime {
	decide(request: JevRequest, options?: JevDecideOptions): Promise<JevResult>;
}

export interface JevFakeRuntime extends JevRuntime {
	calls: JevProcessInput[];
	requests: JevRequest[];
	reset(): void;
}

export interface JevFakeOptions extends JevRuntimeOptions {
	handler?: (request: JevRequest) => JevProcessOutput | Error;
	queue?: Array<JevProcessOutput | Error>;
}
