import { describe, expect, test } from "bun:test";
import {
	MAX_SAMPLE_BYTES,
	buildSample,
	classifyProvenance,
} from "../extensions/ce-core/injection-screen/provenance";

const REPO = "/home/dev/repo";

function bash(command: string, repoRoot = REPO) {
	return classifyProvenance({ toolName: "bash", input: { command }, repoRoot });
}

function read(path: string, opts: { realPath?: string; platform?: NodeJS.Platform } = {}) {
	return classifyProvenance({
		toolName: "read",
		input: { path },
		repoRoot: REPO,
		...opts,
	});
}

describe("classifyProvenance — http", () => {
	test("bare URL", () => {
		expect(bash("curl https://example.com/x")?.kind).toBe("http");
	});

	test("curl piped to jq", () => {
		const p = bash("curl -s http://example.com/a | jq .");
		expect(p?.kind).toBe("http");
		expect(p?.ref).toContain("example.com");
	});

	test("env-prefixed wget", () => {
		expect(bash("VAR=1 wget http://example.com/f")?.kind).toBe("http");
	});

	test("python requests", () => {
		expect(bash(`python -c 'requests.get("http://example.com")'`)?.kind).toBe(
			"http",
		);
	});

	test("node fetch", () => {
		expect(bash(`node -e 'fetch("https://example.com")'`)?.kind).toBe("http");
	});

	test("no url is not flagged", () => {
		expect(bash('echo "no url here"')).toBeNull();
	});
});

describe("classifyProvenance — gh", () => {
	test("gh issue view", () => {
		expect(bash("gh issue view 1")?.kind).toBe("gh-issue");
	});

	test("gh pr diff", () => {
		expect(bash("gh pr diff 2")?.kind).toBe("gh-pr");
	});

	test("gh api", () => {
		expect(bash("gh api repos/o/r")?.kind).toBe("gh-api");
	});

	test("token-prefixed gh pr view", () => {
		expect(bash("GH_TOKEN=x gh pr view 3")?.kind).toBe("gh-pr");
	});

	test("gh auth status is not a read subcommand", () => {
		expect(bash("gh auth status")).toBeNull();
	});
});

describe("classifyProvenance — external-path", () => {
	test("read outside the repo", () => {
		expect(read("/tmp/x")?.kind).toBe("external-path");
	});

	test("read inside the repo", () => {
		expect(read("src/a.ts")).toBeNull();
	});

	test(".. traversal escapes the repo", () => {
		expect(read("../../etc/passwd")?.kind).toBe("external-path");
	});

	test("sibling path sharing the repo prefix is external", () => {
		expect(read("/home/dev/repo-other/secret")?.kind).toBe("external-path");
	});

	test("realPath overrides the lexical path", () => {
		expect(read("src/a.ts", { realPath: "/outside/x" })?.kind).toBe(
			"external-path",
		);
	});

	test("darwin comparison is case-insensitive", () => {
		const provenance = classifyProvenance({
			toolName: "read",
			input: { path: "/users/dev/repo/src/a.ts" },
			repoRoot: "/Users/dev/Repo",
			platform: "darwin",
		});
		expect(provenance).toBeNull();
	});

	test("case-sensitive elsewhere", () => {
		const provenance = classifyProvenance({
			toolName: "read",
			input: { path: "/home/dev/Repo/src/a.ts" },
			repoRoot: REPO,
			platform: "linux",
		});
		expect(provenance?.kind).toBe("external-path");
	});
});

describe("classifyProvenance — malformed input", () => {
	test("empty input returns null", () => {
		expect(classifyProvenance({} as never)).toBeNull();
	});
	test("null input returns null", () => {
		expect(classifyProvenance(null as never)).toBeNull();
	});
	test("unknown tool returns null", () => {
		expect(
			classifyProvenance({ toolName: "edit", input: {}, repoRoot: REPO }),
		).toBeNull();
	});
	test("bash with non-string command returns null", () => {
		expect(
			classifyProvenance({
				toolName: "bash",
				input: { command: 42 },
				repoRoot: REPO,
			} as never),
		).toBeNull();
	});
});

describe("buildSample", () => {
	test("exactly at the cap is verbatim", () => {
		const raw = "a".repeat(MAX_SAMPLE_BYTES);
		const sample = buildSample(raw);
		expect(sample.truncated).toBe(false);
		expect(sample.text).toBe(raw);
	});

	test("one byte over inserts a 1-byte omission marker", () => {
		const raw = "a".repeat(MAX_SAMPLE_BYTES + 1);
		const sample = buildSample(raw);
		expect(sample.truncated).toBe(true);
		expect(sample.text).toContain("[... 1 bytes omitted ...]");
		expect(sample.text.startsWith("a".repeat(8192))).toBe(true);
		expect(sample.text.endsWith("a".repeat(8192))).toBe(true);
	});

	test("multi-byte cut never splits a code point", () => {
		const raw = "a".repeat(8191) + "€" + "b".repeat(8192);
		const sample = buildSample(raw);
		expect(sample.truncated).toBe(true);
		expect(sample.text.includes("\uFFFD")).toBe(false);
		expect(Buffer.from(sample.text, "utf8").toString("utf8")).toBe(sample.text);
	});
});

