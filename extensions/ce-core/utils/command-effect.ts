/**
 * Pure deterministic shell-effect classifier for the Jev semantic stage guard.
 *
 * Bounded v1: no shell AST, no `$VAR`/command-substitution/glob/symlink
 * resolution, no heredoc body execution. Splits on shell separators (quote
 * aware), classifies each segment against family tables, unions literal
 * workspace targets, and takes the most-restrictive effect. Anything it cannot
 * prove becomes `ambiguous` (the caller routes those to Jev).
 *
 * @module command-effect
 */

export type EffectClass =
	| "read_only"
	| "mutates_workspace"
	| "deletes_or_destructive"
	| "installs_dependencies"
	| "runs_tests_or_builds"
	| "package_runner"
	| "pipe_to_shell"
	| "container_or_remote"
	| "ambiguous";

export interface CommandEffect {
	effect: EffectClass;
	targets: string[];
	/** A mutating/destructive family had a non-literal (or absent) target. */
	unresolvable: boolean;
}

// Most-restrictive wins, low → high.
const EFFECT_ORDER: readonly EffectClass[] = [
	"read_only",
	"runs_tests_or_builds",
	"ambiguous",
	"container_or_remote",
	"package_runner",
	"installs_dependencies",
	"pipe_to_shell",
	"mutates_workspace",
	"deletes_or_destructive",
];

const EFFECT_RANK = new Map<EffectClass, number>(
	EFFECT_ORDER.map((effect, index) => [effect, index]),
);

function mostRestrictive(a: EffectClass, b: EffectClass): EffectClass {
	return (EFFECT_RANK.get(a) ?? 0) >= (EFFECT_RANK.get(b) ?? 0) ? a : b;
}

// ── Tokenizer ──────────────────────────────────────────────────────

interface WordToken {
	kind: "word";
	text: string;
}
interface RedirectToken {
	kind: "redirect";
	op: ">" | ">>" | "<" | "<<" | "&>";
}
interface SepToken {
	kind: "sep";
}
type Token = WordToken | RedirectToken | SepToken;

interface Scan {
	tokens: Token[];
	hasSubstitution: boolean;
}

const WRITE_REDIRECTS = new Set<RedirectToken["op"]>([">", ">>", "&>"]);

interface ScanState {
	tokens: Token[];
	hasSubstitution: boolean;
	word: string;
	inWord: boolean;
}

function append(state: ScanState, chunk: string): void {
	state.word += chunk;
	state.inWord = true;
}

function pushWord(state: ScanState): void {
	if (!state.inWord) return;
	state.tokens.push({ kind: "word", text: state.word });
	state.word = "";
	state.inWord = false;
}

function pushSep(state: ScanState): void {
	pushWord(state);
	state.tokens.push({ kind: "sep" });
}

/** Quote-aware split into words, redirects, and separators. */
function scan(command: string): Scan {
	const state: ScanState = {
		tokens: [],
		hasSubstitution: false,
		word: "",
		inWord: false,
	};
	let i = 0;
	while (i < command.length) i = scanStep(command, i, state);
	pushWord(state);
	return { tokens: state.tokens, hasSubstitution: state.hasSubstitution };
}

function scanStep(command: string, i: number, state: ScanState): number {
	const c = command[i];
	if (c === "\\") return readEscape(command, i, state);
	if (c === "'" || c === '"') return readQuote(command, i, state);
	if (c === "$" && command[i + 1] === "(") state.hasSubstitution = true;
	if (c === "`") state.hasSubstitution = true;
	if (c === "\n") {
		pushSep(state);
		return i + 1;
	}
	if (c === " " || c === "\t" || c === "\r") {
		pushWord(state);
		return i + 1;
	}
	if (c === "&") return readAmpersand(command, i, state);
	if (c === "|") return readPipe(command, i, state);
	if (c === ";") {
		pushSep(state);
		return i + 1;
	}
	if (c === ">") return readOutputRedirect(command, i, state);
	if (c === "<") return readInputRedirect(command, i, state);
	append(state, c);
	return i + 1;
}

function readEscape(command: string, i: number, state: ScanState): number {
	append(state, i + 1 < command.length ? command[i + 1] : command[i]);
	return i + 2;
}

function readQuote(command: string, i: number, state: ScanState): number {
	return readQuoted(command, i, (chunk) => append(state, chunk));
}

function readAmpersand(command: string, i: number, state: ScanState): number {
	if (command[i + 1] === "&") {
		pushSep(state);
		return i + 2;
	}
	if (command[i + 1] === ">") {
		pushWord(state);
		state.tokens.push({ kind: "redirect", op: "&>" });
		return consumeFdDup(command, i + 2);
	}
	pushSep(state);
	return i + 1;
}

function readPipe(command: string, i: number, state: ScanState): number {
	pushSep(state);
	return command[i + 1] === "|" ? i + 2 : i + 1;
}

function readOutputRedirect(
	command: string,
	i: number,
	state: ScanState,
): number {
	// Drop a bare fd digit (`2>err`) so it is not emitted as a word.
	if (state.inWord && /^\d+$/.test(state.word)) {
		state.word = "";
		state.inWord = false;
	}
	pushWord(state);
	let j = i + 1;
	const op: RedirectToken["op"] = command[j] === ">" ? ">>" : ">";
	if (op === ">>") j++;
	state.tokens.push({ kind: "redirect", op });
	return consumeFdDup(command, j);
}

function readInputRedirect(
	command: string,
	i: number,
	state: ScanState,
): number {
	pushWord(state);
	let j = i + 1;
	let op: RedirectToken["op"] = "<";
	if (command[j] === "<") {
		op = "<<";
		j++;
		if (command[j] === "-") j++;
	}
	state.tokens.push({ kind: "redirect", op });
	return j;
}

/** Copy a quoted span (without the quotes); returns the index after the close. */
function readQuoted(
	command: string,
	start: number,
	emit: (chunk: string) => void,
): number {
	const quote = command[start];
	let i = start + 1;
	let chunk = "";
	while (i < command.length && command[i] !== quote) {
		if (quote === '"' && command[i] === "\\" && i + 1 < command.length) {
			chunk += command[i + 1];
			i += 2;
			continue;
		}
		chunk += command[i];
		i++;
	}
	emit(chunk);
	return i < command.length ? i + 1 : i;
}

/** Consume an `&N`/`&-` fd-duplication suffix so it is not read as a target. */
function consumeFdDup(command: string, i: number): number {
	if (command[i] !== "&") return i;
	const next = command[i + 1] ?? "";
	if (!/[0-9-]/.test(next)) return i;
	i++;
	while (i < command.length && /[0-9]/.test(command[i])) i++;
	return i;
}

// ── Heredoc extraction ─────────────────────────────────────────────

const HEREDOC_RE = /<{2}-?\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))/;
const MUTATING_WORD_RE =
	/\b(rm|rmdir|mv|cp|sed|tee|dd|truncate|shred|chmod|chown|ln|touch|mkdir|patch|git|install)\b/;

interface HeredocSplit {
	head: string;
	body: string;
	hasHeredoc: boolean;
}

/** Remove one heredoc body so body text is never parsed as commands. */
function splitHeredoc(command: string): HeredocSplit {
	const lines = command.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const match = lines[i].match(HEREDOC_RE);
		if (!match) continue;
		const delimiter = match[1] ?? match[2] ?? match[3];
		let end = i + 1;
		const body: string[] = [];
		for (; end < lines.length; end++) {
			if (lines[end].trim() === delimiter) break;
			body.push(lines[end]);
		}
		const tail = lines.slice(Math.min(end + 1, lines.length));
		return {
			head: [...lines.slice(0, i + 1), ...tail].join("\n"),
			body: body.join("\n"),
			hasHeredoc: true,
		};
	}
	return { head: command, body: "", hasHeredoc: false };
}

// ── Target extraction ──────────────────────────────────────────────

const DYNAMIC_TARGET = /[$`*?~{}()]/;
const NON_FILE_TARGETS = new Set([
	"-",
	"/dev/null",
	"/dev/stdout",
	"/dev/stderr",
]);

/** Literal = a concrete file path with no runtime expansion markers. */
function literalize(raw: string[]): { literal: string[]; unresolvable: boolean } {
	const literal: string[] = [];
	let unresolvable = false;
	for (const target of raw) {
		if (NON_FILE_TARGETS.has(target)) continue;
		if (
			target.length === 0 ||
			target.startsWith("-") ||
			DYNAMIC_TARGET.test(target)
		) {
			unresolvable = true;
			continue;
		}
		literal.push(target);
	}
	return { literal, unresolvable };
}

const EMPTY_FLAGS: ReadonlySet<string> = new Set();

/** Non-flag operands; `valueFlags` consume the token that follows them. */
function operands(
	args: string[],
	valueFlags: ReadonlySet<string> = EMPTY_FLAGS,
): string[] {
	const out: string[] = [];
	let endOfFlags = false;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (!endOfFlags && arg === "--") {
			endOfFlags = true;
			continue;
		}
		if (!endOfFlags && arg.startsWith("-") && arg !== "-") {
			if (!arg.includes("=") && valueFlags.has(arg)) i++;
			continue;
		}
		out.push(arg);
	}
	return out;
}

// ── Segment classification ─────────────────────────────────────────

interface SegmentResult {
	effect: EffectClass;
	targets: string[];
	unresolvable: boolean;
}

const READ_ONLY: SegmentResult = {
	effect: "read_only",
	targets: [],
	unresolvable: false,
};
const AMBIGUOUS: SegmentResult = {
	effect: "ambiguous",
	targets: [],
	unresolvable: false,
};

const READ_ONLY_COMMANDS = new Set([
	"grep", "rg", "cat", "ls", "head", "tail", "wc", "echo", "printf", "pwd",
	"which", "type", "file", "stat", "du", "df", "sort", "uniq", "cut", "tr",
	"jq", "awk", "diff", "cmp", "basename", "dirname", "realpath", "readlink",
	"tree", "less", "more", "seq", "sleep", "true", "false", "test",
]);
const DELETE_COMMANDS = new Set(["rm", "rmdir", "shred", "truncate"]);
const MUTATE_COMMANDS = new Set(["mv", "cp", "touch", "mkdir", "patch", "ln", "tee"]);
const INTERPRETER_COMMANDS = new Set([
	"python", "python3", "node", "deno", "ruby", "perl", "php", "lua", "osascript",
]);
const SHELL_COMMANDS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);
const CONTAINER_COMMANDS = new Set([
	"docker", "podman", "kubectl", "helm", "terraform", "ssh", "scp", "rsync",
]);
const INSTALL_MANAGERS = new Set(["bun", "npm", "pnpm", "yarn"]);
const POLICY_SCRIPTS = new Set(["test", "build", "typecheck", "lint", "check", "ci"]);
const WRAPPERS = new Set(["sudo", "env", "command", "nohup", "nice", "time"]);
const TRUNCATE_FLAGS: ReadonlySet<string> = new Set(["-s", "--size", "-r", "--reference"]);

function mutating(effect: EffectClass, raw: string[]): SegmentResult {
	const { literal, unresolvable } = literalize(raw);
	return {
		effect,
		targets: literal,
		unresolvable: unresolvable || raw.length === 0,
	};
}

function isEnvAssignment(word: string): boolean {
	return /^[A-Za-z_][A-Za-z0-9_]*=/.test(word);
}

function commandName(word: string): string {
	return word.slice(word.lastIndexOf("/") + 1) || word;
}

/** `sed -i` in any combined short-flag form (`-i`, `-ni`, `--in-place`). */
function hasInPlace(args: string[]): boolean {
	return args.some(
		(arg) =>
			arg === "--in-place" ||
			arg.startsWith("--in-place=") ||
			/^-[a-zA-Z]*i/.test(arg),
	);
}

function classifyWords(words: string[]): SegmentResult {
	let start = 0;
	while (
		start < words.length &&
		(isEnvAssignment(words[start]) || WRAPPERS.has(words[start]))
	) {
		start++;
	}
	while (start < words.length && words[start].startsWith("-")) start++;
	if (start >= words.length) return AMBIGUOUS;
	return classifyCommand(commandName(words[start]), words.slice(start + 1));
}

function classifyCommand(cmd: string, args: string[]): SegmentResult {
	if (cmd === "git") return classifyGit(args);
	if (cmd === "sed") return classifySed(args);
	if (cmd === "dd") return classifyDd(args);
	if (cmd === "curl" || cmd === "wget") return classifyDownload(cmd, args);

	const fileResult = classifyFileCommand(cmd, args);
	if (fileResult) return fileResult;
	return classifyExecCommand(cmd, args) ?? AMBIGUOUS;
}

/** Commands whose operands are literal file targets. */
function classifyFileCommand(
	cmd: string,
	args: string[],
): SegmentResult | null {
	if (DELETE_COMMANDS.has(cmd)) {
		return mutating(
			"deletes_or_destructive",
			operands(args, cmd === "truncate" ? TRUNCATE_FLAGS : EMPTY_FLAGS),
		);
	}
	if (cmd === "chmod" || cmd === "chown" || cmd === "chgrp") {
		const ops = operands(args);
		ops.shift();
		return mutating("mutates_workspace", ops);
	}
	if (MUTATE_COMMANDS.has(cmd)) {
		return mutating("mutates_workspace", operands(args));
	}
	return null;
}

/** Commands classified by name/policy, not by extracted targets. */
function classifyExecCommand(
	cmd: string,
	args: string[],
): SegmentResult | null {
	if (INSTALL_MANAGERS.has(cmd)) return classifyManager(args);
	if (cmd === "tsc") return testBuild();
	if (cmd === "npx" || cmd === "bunx" || cmd === "pnpx") {
		return classifyRunner(args);
	}
	if (cmd === "make") return classifyMake(args);
	if (cmd === "find") return classifyFind(args);
	if (SHELL_COMMANDS.has(cmd)) return classifyShell(args);
	if (CONTAINER_COMMANDS.has(cmd)) {
		return { effect: "container_or_remote", targets: [], unresolvable: false };
	}
	if (INTERPRETER_COMMANDS.has(cmd)) return AMBIGUOUS;
	if (READ_ONLY_COMMANDS.has(cmd)) return READ_ONLY;
	return null;
}

function classifyFind(args: string[]): SegmentResult {
	const canExec = args.some(
		(arg) => arg === "-exec" || arg === "-execdir" || arg === "-ok",
	);
	return canExec ? AMBIGUOUS : READ_ONLY;
}

function testBuild(): SegmentResult {
	return { effect: "runs_tests_or_builds", targets: [], unresolvable: false };
}

function packageRunner(): SegmentResult {
	return { effect: "package_runner", targets: [], unresolvable: false };
}

function classifySed(args: string[]): SegmentResult {
	if (!hasInPlace(args)) return READ_ONLY;
	const ops = operands(args);
	// ponytail: the first sed operand is the script; files follow it.
	return mutating("mutates_workspace", ops.slice(1));
}

function classifyDd(args: string[]): SegmentResult {
	const of = args.find((arg) => arg.startsWith("of="));
	return mutating("deletes_or_destructive", of ? [of.slice(3)] : []);
}

function classifyDownload(cmd: string, args: string[]): SegmentResult {
	const flag = cmd === "curl" ? "-o" : "-O";
	const index = args.findIndex((arg) => arg === flag || arg === "--output");
	const target = index >= 0 ? args[index + 1] : undefined;
	if (target === undefined) return READ_ONLY;
	return mutating("mutates_workspace", [target]);
}

function classifyManager(args: string[]): SegmentResult {
	const rest = args.filter((arg) => !arg.startsWith("-"));
	const sub = rest[0];
	if (sub === undefined) return args.length === 0 ? AMBIGUOUS : READ_ONLY;
	if (["install", "add", "i", "ci", "upgrade", "update"].includes(sub)) {
		return {
			effect: "installs_dependencies",
			targets: [],
			unresolvable: false,
		};
	}
	if (sub === "test" || sub === "tsc") return testBuild();
	if (sub === "run") {
		const script = rest[1];
		return script && POLICY_SCRIPTS.has(script) ? testBuild() : packageRunner();
	}
	if (sub === "x" || sub === "exec") return packageRunner();
	return packageRunner();
}

function classifyRunner(args: string[]): SegmentResult {
	const first = args.find((arg) => !arg.startsWith("-"));
	return first === "tsc" || first === "make" ? testBuild() : packageRunner();
}

function classifyMake(args: string[]): SegmentResult {
	const target = args.find((arg) => !arg.startsWith("-"));
	return target && POLICY_SCRIPTS.has(target) ? testBuild() : AMBIGUOUS;
}

/** `bash -c "<inner>"` recurses only to prove a read-only inner command. */
function classifyShell(args: string[]): SegmentResult {
	const index = args.findIndex((arg) => arg === "-c");
	if (index === -1) return { effect: "pipe_to_shell", targets: [], unresolvable: false };
	const inner = args[index + 1];
	if (inner === undefined) return AMBIGUOUS;
	const nested = classifyCommandEffect(inner);
	if (
		nested.effect === "read_only" &&
		nested.targets.length === 0 &&
		!nested.unresolvable
	) {
		return READ_ONLY;
	}
	return AMBIGUOUS;
}

const READ_ONLY_GIT = new Set([
	"status", "diff", "log", "show", "branch", "remote", "rev-parse",
	"ls-files", "blame", "describe", "shortlog", "grep", "fetch", "tag",
	"config", "reflog", "worktree", "submodule", "help", "version",
]);

function classifyGit(args: string[]): SegmentResult {
	const sub = args.find((arg) => !arg.startsWith("-"));
	if (sub === undefined) return AMBIGUOUS;
	if (sub === "clean") return mutating("deletes_or_destructive", []);
	if (sub === "rm") return mutating("deletes_or_destructive", operands(args.slice(args.indexOf(sub) + 1)));
	if (sub === "apply" || sub === "mv") {
		return mutating("mutates_workspace", operands(args.slice(args.indexOf(sub) + 1)));
	}
	if (READ_ONLY_GIT.has(sub)) return READ_ONLY;
	// ponytail: other git subcommands can mutate but expose no literal path.
	return mutating("mutates_workspace", []);
}

function combine(a: SegmentResult, b: SegmentResult): SegmentResult {
	const targets = [...a.targets];
	for (const target of b.targets) {
		if (!targets.includes(target)) targets.push(target);
	}
	return {
		effect: mostRestrictive(a.effect, b.effect),
		targets,
		unresolvable: a.unresolvable || b.unresolvable,
	};
}

function splitSegments(tokens: Token[]): Token[][] {
	const segments: Token[][] = [];
	let current: Token[] = [];
	for (const token of tokens) {
		if (token.kind === "sep") {
			segments.push(current);
			current = [];
		} else {
			current.push(token);
		}
	}
	segments.push(current);
	return segments;
}

function classifySegment(tokens: Token[]): SegmentResult {
	const words: string[] = [];
	const redirects: string[] = [];
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (token.kind === "word") {
			words.push(token.text);
			continue;
		}
		if (token.kind === "redirect" && WRITE_REDIRECTS.has(token.op)) {
			const next = tokens[i + 1];
			if (next && next.kind === "word") {
				redirects.push(next.text);
				i++;
			}
		}
	}
	const base = classifyWords(words);
	if (redirects.length === 0) return base;
	return combine(base, mutating("mutates_workspace", redirects));
}

/**
 * Classify the deterministic effect of a raw shell command.
 *
 * Pure and total: malformed input degrades to `ambiguous`, never throws.
 */
export function classifyCommandEffect(command: string): CommandEffect {
	if (typeof command !== "string") {
		return { effect: "ambiguous", targets: [], unresolvable: false };
	}
	const { head, body, hasHeredoc } = splitHeredoc(command);
	const { tokens, hasSubstitution } = scan(head);

	const segments = splitSegments(tokens).filter(
		(segment) => segment.length > 0,
	);
	let result: SegmentResult =
		segments.length === 0
			? AMBIGUOUS
			: segments.map(classifySegment).reduce(combine);

	if (hasHeredoc || hasSubstitution) {
		result = {
			...result,
			effect: mostRestrictive(result.effect, "ambiguous"),
		};
	}
	if (hasHeredoc && MUTATING_WORD_RE.test(body)) {
		result = { ...result, unresolvable: true };
	}
	return result;
}
