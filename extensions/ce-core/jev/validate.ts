import { Type } from "typebox";
import { Value } from "typebox/value";
import { JevRuntimeError } from "./errors";
import type {
	JevAnswer,
	JevChoiceQuestion,
	JevContent,
	JevQuestion,
	JevRequest,
	JevUsage,
} from "./types";

export interface JevValidateRequestOptions {
	timeoutMs?: number;
}

export interface JevValidatedRequest {
	request: JevRequest;
	body: string;
	stateBytes: number;
	warnings: string[];
}

const MAX_QUESTIONS = 32;
const MAX_QUESTION_ID_LENGTH = 128;
const MAX_CHOICE_OPTIONS = 255;
const MIN_SCORE_LEVELS = 2;
const MAX_SCORE_LEVELS = 10;
const MAX_REQUEST_BODY_BYTES = 65_536;

const JevContentSchema = Type.Union([
	Type.String(),
	Type.Object({}, { additionalProperties: true }),
	Type.Array(Type.Unknown()),
]);

const JevQuestionSchema = Type.Union([
	Type.Object(
		{
			type: Type.Literal("noul"),
			instructions: JevContentSchema,
			criteria: Type.Optional(
				Type.Object(
					{
						true: Type.Optional(JevContentSchema),
						false: Type.Optional(JevContentSchema),
					},
					{ additionalProperties: false },
				),
			),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			type: Type.Literal("choice"),
			instructions: JevContentSchema,
			criteria: Type.Record(Type.String(), JevContentSchema),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			type: Type.Literal("score"),
			instructions: JevContentSchema,
			criteria: Type.Array(JevContentSchema),
		},
		{ additionalProperties: false },
	),
]);

const JevRequestSchema = Type.Object({
	state: JevContentSchema,
	questions: Type.Record(Type.String(), JevQuestionSchema),
});

type RawValidationError = ReturnType<typeof Value.Errors>[number];

function invalidRequest(path: string, detail: string): JevRuntimeError {
	return new JevRuntimeError({
		code: "invalid_request",
		message: `invalid request at "${path}": ${detail}`,
	});
}

function normalizePath(error: RawValidationError): string {
	const segments = error.instancePath
		? error.instancePath
				.split("/")
				.slice(1)
				.map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"))
		: [];
	const params = error.params as { requiredProperties?: string[] };
	if (error.keyword === "required" && params.requiredProperties?.length) {
		segments.push(params.requiredProperties[0]);
	}
	return segments.length > 0 ? segments.join(".") : "request";
}

/** Picks the deepest non-wrapper failure so the path points at the real field. */
function selectError(
	errors: RawValidationError[],
): RawValidationError | undefined {
	const withoutAnyOf = errors.filter((error) => error.keyword !== "anyOf");
	const nonConst = withoutAnyOf.filter((error) => error.keyword !== "const");
	const pool = nonConst.length > 0 ? nonConst : withoutAnyOf;
	return pool.reduce<RawValidationError | undefined>(
		(best, current) =>
			!best || current.instancePath.length > best.instancePath.length
				? current
				: best,
		undefined,
	);
}

/** A bad/missing question `type` is the real failure, so report that path directly. */
function assertKnownQuestionTypes(request: unknown): void {
	if (typeof request !== "object" || request === null) return;
	const questions = (request as { questions?: unknown }).questions;
	if (typeof questions !== "object" || questions === null || Array.isArray(questions))
		return;

	for (const [id, question] of Object.entries(
		questions as Record<string, unknown>,
	)) {
		const type = (question as { type?: unknown } | null)?.type;
		if (type !== "noul" && type !== "choice" && type !== "score") {
			throw invalidRequest(
				`questions.${id}.type`,
				"type must be one of noul, choice, score",
			);
		}
	}
}

function validateId(id: string): void {
	if (id.length > MAX_QUESTION_ID_LENGTH) {
		throw invalidRequest(
			"questions",
			`question ids must be ${MAX_QUESTION_ID_LENGTH} characters or fewer`,
		);
	}
	if (id.trim().length === 0) {
		throw invalidRequest(
			"questions",
			"question ids must contain at least one non-whitespace character",
		);
	}
}

function validateQuestionCriteria(id: string, question: JevQuestion): void {
	const path = `questions.${id}.criteria`;
	if (question.type === "choice") {
		const options = Object.keys(question.criteria);
		if (options.length < 1 || options.length > MAX_CHOICE_OPTIONS) {
			throw invalidRequest(
				path,
				`choice criteria must contain 1..${MAX_CHOICE_OPTIONS} options (received ${options.length})`,
			);
		}
		if (options.some((option) => option.trim().length === 0)) {
			throw invalidRequest(path, "choice option names must be non-empty");
		}
		return;
	}
	if (question.type === "score") {
		const levels = question.criteria.length;
		if (levels < MIN_SCORE_LEVELS || levels > MAX_SCORE_LEVELS) {
			throw invalidRequest(
				path,
				`score criteria must contain ${MIN_SCORE_LEVELS}..${MAX_SCORE_LEVELS} levels (received ${levels})`,
			);
		}
	}
}

/**
 * Validates a System One request (shape + cross-field bounds) before any spawn.
 * Every failure is `invalid_request` with a machine-readable field path.
 */
export function validateRequest(
	request: unknown,
	options?: JevValidateRequestOptions,
): JevValidatedRequest {
	if (options?.timeoutMs !== undefined) {
		if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
			throw invalidRequest("timeoutMs", "timeoutMs must be a finite positive number");
		}
	}

	if (!Value.Check(JevRequestSchema, request)) {
		assertKnownQuestionTypes(request);
		const selected = selectError(Value.Errors(JevRequestSchema, request));
		if (selected) {
			throw invalidRequest(normalizePath(selected), selected.message);
		}
		throw invalidRequest("request", "request does not match the System One shape");
	}

	const typed = request as JevRequest;
	validateQuestions(typed.questions);
	const { body, stateBytes } = serializeRequestBody(typed);
	return { request: typed, body, stateBytes, warnings: [] };
}

function validateQuestions(questions: Record<string, JevQuestion>): void {
	const entries = Object.entries(questions);
	if (entries.length < 1 || entries.length > MAX_QUESTIONS) {
		throw invalidRequest(
			"questions",
			`questions must contain 1..${MAX_QUESTIONS} entries (received ${entries.length})`,
		);
	}
	for (const [id, question] of entries) {
		validateId(id);
		validateQuestionCriteria(id, question);
	}
}

function serializeRequestBody(request: JevRequest): {
	body: string;
	stateBytes: number;
} {
	let stateBytes: number;
	let body: string;
	try {
		stateBytes = Buffer.byteLength(JSON.stringify(request.state), "utf8");
		body = JSON.stringify({ state: request.state, questions: request.questions });
	} catch {
		throw invalidRequest("state", "state could not be serialized to JSON");
	}

	const bodyBytes = Buffer.byteLength(body, "utf8");
	if (bodyBytes > MAX_REQUEST_BODY_BYTES) {
		throw invalidRequest(
			"request",
			`request body is ${bodyBytes} bytes; the limit is ${MAX_REQUEST_BODY_BYTES}`,
		);
	}
	return { body, stateBytes };
}

export interface JevValidatedResponse {
	answers: Record<string, JevAnswer>;
	model: string;
	usage?: JevUsage;
	warnings: string[];
}

const SCORE_TOLERANCE = 1e-9;
const PROBABILITY_WARN_MIN = 0.95;
const PROBABILITY_WARN_MAX = 1.05;
const PROBABILITY_FATAL_MIN = 0.5;
const PROBABILITY_FATAL_MAX = 1.5;

function invalidResponse(path: string, detail: string): JevRuntimeError {
	return new JevRuntimeError({
		code: "invalid_response",
		message: `invalid response at "${path}": ${detail}`,
	});
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function isUnitInterval(value: unknown): value is number {
	return isFiniteNumber(value) && value >= 0 && value <= 1;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameKeySet(actual: string[], expected: string[]): boolean {
	if (actual.length !== expected.length) return false;
	const expectedSet = new Set(expected);
	return actual.every((key) => expectedSet.has(key));
}

function parseUsage(value: unknown): JevUsage {
	if (!isPlainObject(value)) {
		throw invalidResponse("usage", "usage must be an object when present");
	}
	const input = value.input_tokens;
	const output = value.output_tokens;
	if (typeof input !== "number" || !Number.isInteger(input) || input < 0) {
		throw invalidResponse(
			"usage.input_tokens",
			"input_tokens must be a non-negative integer",
		);
	}
	if (typeof output !== "number" || !Number.isInteger(output) || output < 0) {
		throw invalidResponse(
			"usage.output_tokens",
			"output_tokens must be a non-negative integer",
		);
	}
	return { input_tokens: input, output_tokens: output };
}

function validateProbabilities(
	path: string,
	value: unknown,
	expectedKeys: string[],
	warnings: string[],
): Record<string, number> {
	if (!isPlainObject(value)) {
		throw invalidResponse(path, "probabilities must be an object");
	}
	if (!sameKeySet(Object.keys(value), expectedKeys)) {
		throw invalidResponse(
			path,
			`probabilities keys must equal ${expectedKeys.join(", ")}`,
		);
	}
	const probabilities: Record<string, number> = {};
	let sum = 0;
	for (const key of expectedKeys) {
		const probability = value[key];
		if (!isUnitInterval(probability)) {
			throw invalidResponse(
				`${path}.${key}`,
				"probability must be a finite number in [0, 1]",
			);
		}
		probabilities[key] = probability;
		sum += probability;
	}
	if (
		!Number.isFinite(sum) ||
		sum < PROBABILITY_FATAL_MIN ||
		sum > PROBABILITY_FATAL_MAX
	) {
		throw invalidResponse(
			path,
			`probabilities sum to ${sum}, outside [${PROBABILITY_FATAL_MIN}, ${PROBABILITY_FATAL_MAX}]`,
		);
	}
	if (sum < PROBABILITY_WARN_MIN || sum > PROBABILITY_WARN_MAX) {
		warnings.push(
			`${path} sum to ${Math.round(sum * 100) / 100}, outside [0.95, 1.05]`,
		);
	}
	return probabilities;
}

function requireConfidence(path: string, value: unknown): number {
	if (!isUnitInterval(value)) {
		throw invalidResponse(path, "confidence must be a finite number in [0, 1]");
	}
	return value;
}

function validateLegend(
	path: string,
	value: unknown,
	levelKeys: string[],
): Record<string, string> {
	if (!isPlainObject(value)) {
		throw invalidResponse(path, "legend must be an object");
	}
	if (!sameKeySet(Object.keys(value), levelKeys)) {
		throw invalidResponse(path, `legend keys must equal ${levelKeys.join(", ")}`);
	}
	const legend: Record<string, string> = {};
	for (const key of levelKeys) {
		const description = value[key];
		if (typeof description !== "string") {
			throw invalidResponse(`${path}.${key}`, "legend values must be strings");
		}
		legend[key] = description;
	}
	return legend;
}

function validateAnswer(
	id: string,
	question: JevQuestion,
	value: unknown,
	warnings: string[],
): JevAnswer {
	const path = `answers.${id}`;
	if (!isPlainObject(value)) {
		throw invalidResponse(path, "answer must be an object");
	}
	if (value.type !== question.type) {
		throw invalidResponse(
			`${path}.type`,
			`answer type must equal question type "${question.type}"`,
		);
	}
	if (question.type === "noul") return validateNoulAnswer(path, value);
	if (question.type === "choice") {
		return validateChoiceAnswer(path, question.criteria, value, warnings);
	}
	return validateScoreAnswer(path, question.criteria.length, value, warnings);
}

function validateNoulAnswer(
	path: string,
	value: Record<string, unknown>,
): JevAnswer {
	const noul = value.noul;
	if (!isUnitInterval(noul)) {
		throw invalidResponse(`${path}.noul`, "noul must be a finite number in [0, 1]");
	}
	if (value.confidence === undefined) return { type: "noul", noul };
	return {
		type: "noul",
		noul,
		confidence: requireConfidence(`${path}.confidence`, value.confidence),
	};
}

function validateChoiceAnswer(
	path: string,
	criteria: Record<string, JevContent>,
	value: Record<string, unknown>,
	warnings: string[],
): JevAnswer {
	const optionKeys = Object.keys(criteria);
	const choice = value.choice;
	if (typeof choice !== "string" || !optionKeys.includes(choice)) {
		throw invalidResponse(
			`${path}.choice`,
			"choice must be one of the requested options",
		);
	}
	return {
		type: "choice",
		choice,
		probabilities: validateProbabilities(
			`${path}.probabilities`,
			value.probabilities,
			optionKeys,
			warnings,
		),
		confidence: requireConfidence(`${path}.confidence`, value.confidence),
	};
}

function validateScoreAnswer(
	path: string,
	levelCount: number,
	value: Record<string, unknown>,
	warnings: string[],
): JevAnswer {
	const levelKeys = Array.from({ length: levelCount }, (_, index) =>
		String(index),
	);
	const score = value.score;
	const maxScore = levelKeys.length - 1;
	if (
		!isFiniteNumber(score) ||
		score < -SCORE_TOLERANCE ||
		score > maxScore + SCORE_TOLERANCE
	) {
		throw invalidResponse(
			`${path}.score`,
			`score must be a finite number in [0, ${maxScore}]`,
		);
	}
	return {
		type: "score",
		score,
		legend: validateLegend(`${path}.legend`, value.legend, levelKeys),
		probabilities: validateProbabilities(
			`${path}.probabilities`,
			value.probabilities,
			levelKeys,
			warnings,
		),
		confidence: requireConfidence(`${path}.confidence`, value.confidence),
	};
}

/** Strict System One stdout parse: strips a leading BOM + whitespace, requires a JSON object. */
export function parseStdout(
	stdout: string,
	truncated = false,
): Record<string, unknown> {
	if (truncated) {
		throw new JevRuntimeError({
			code: "malformed_output",
			message: "stdout was truncated at the 1 MiB stream cap",
		});
	}
	const cleaned = stdout.replace(/^\uFEFF/, "").trim();
	if (cleaned.length === 0) {
		throw new JevRuntimeError({
			code: "malformed_output",
			message: "stdout was empty",
		});
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(cleaned);
	} catch {
		throw new JevRuntimeError({
			code: "malformed_output",
			message: "stdout was not valid JSON",
		});
	}
	if (!isPlainObject(parsed)) {
		throw new JevRuntimeError({
			code: "malformed_output",
			message: "stdout JSON must be an object",
		});
	}
	return parsed;
}

/** Validates a parsed response against the request (R5) and returns typed answers. */
export function validateResponse(
	response: unknown,
	request: JevRequest,
): JevValidatedResponse {
	const warnings: string[] = [];
	if (!isPlainObject(response)) {
		throw invalidResponse("response", "response must be an object");
	}

	const answersValue = response.answers;
	if (!isPlainObject(answersValue) || Object.keys(answersValue).length === 0) {
		throw invalidResponse(
			"answers",
			"response must include a non-empty answers object",
		);
	}

	let model = "unknown";
	if (response.model !== undefined) {
		if (typeof response.model !== "string" || response.model.length === 0) {
			throw invalidResponse("model", "model must be a non-empty string when present");
		}
		model = response.model;
	}

	const usage =
		response.usage === undefined ? undefined : parseUsage(response.usage);

	for (const id of Object.keys(answersValue)) {
		if (!(id in request.questions)) {
			warnings.push(`answers.${id} was not requested`);
		}
	}

	const answers: Record<string, JevAnswer> = {};
	for (const [id, question] of Object.entries(request.questions)) {
		if (!(id in answersValue)) {
			throw invalidResponse(
				`answers.${id}`,
				"missing answer for a requested question",
			);
		}
		answers[id] = validateAnswer(id, question, answersValue[id], warnings);
	}

	return { answers, model, usage, warnings: [...new Set(warnings)] };
}

