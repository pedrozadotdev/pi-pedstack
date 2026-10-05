export type JevErrorCode =
	| "invalid_request"
	| "unsupported_platform"
	| "missing_executable"
	| "spawn_failed"
	| "timeout"
	| "aborted"
	| "nonzero_exit"
	| "malformed_output"
	| "invalid_response";

export type JevExitReason =
	| "general"
	| "auth"
	| "permission"
	| "rate_limit"
	| "network"
	| "server"
	| "max_turns"
	| "no_response"
	| "insufficient_credits"
	| "interrupted";

export interface JevRuntimeErrorOptions {
	code: JevErrorCode;
	message: string;
	exitCode?: number;
	reason?: JevExitReason;
	stderrExcerpt?: string;
	cause?: unknown;
}

/** Typed failure for every Jev transport error (see requirements R6). */
export class JevRuntimeError extends Error {
	readonly code: JevErrorCode;
	readonly exitCode?: number;
	readonly reason?: JevExitReason;
	readonly stderrExcerpt?: string;

	constructor(options: JevRuntimeErrorOptions) {
		super(options.message, { cause: options.cause });
		this.name = "JevRuntimeError";
		this.code = options.code;
		this.exitCode = options.exitCode;
		this.reason = options.reason;
		this.stderrExcerpt = options.stderrExcerpt;
	}
}

const EXIT_REASONS: Record<number, JevExitReason> = {
	1: "general",
	2: "general",
	3: "auth",
	4: "permission",
	5: "rate_limit",
	6: "network",
	7: "server",
	8: "max_turns",
	9: "no_response",
	10: "insufficient_credits",
	130: "interrupted",
};

/** Maps a non-zero exit code to its R6 reason; unknown codes default to `general`. */
export function mapExitCodeToReason(exitCode: number): JevExitReason {
	return EXIT_REASONS[exitCode] ?? "general";
}

const MAX_STDERR_EXCERPT_BYTES = 2048;
const REDACTED_BODY = "[redacted-body]";

function truncateToBytes(input: string, maxBytes: number): string {
	const buffer = Buffer.from(input, "utf8");
	if (buffer.byteLength <= maxBytes) return input;

	// Do not split a UTF-8 multi-byte sequence: walk back off continuation bytes.
	let end = maxBytes;
	while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--;
	return buffer.subarray(0, end).toString("utf8");
}

/** Builds an in-memory stderr excerpt: echo-redacted and capped at 2 KiB. */
export function buildStderrExcerpt(stderr: string, body?: string): string {
	const redacted =
		body && body.length > 0 ? stderr.split(body).join(REDACTED_BODY) : stderr;
	return truncateToBytes(redacted, MAX_STDERR_EXCERPT_BYTES);
}
