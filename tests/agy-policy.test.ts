import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { linkSync, lstatSync, mkdirSync, mkdtempSync, opendirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { classifyAgyToolCall, judgeAgyRelevance } from "../extensions/ce-core/review/agy-policy";

let root = "";
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = ""; });
function workspace(): string { root = mkdtempSync(path.join(tmpdir(), "agy-policy-test-")); return root; }
function git(repo: string, args: string[]): string {
	return execFileSync("/usr/bin/git", args, { cwd: repo, encoding: "utf8" });
}

describe("classifyAgyToolCall", () => {
	test("rejects unknown tools before semantic judgment", () => {
		expect(classifyAgyToolCall("write_file", {}, "/repo").allowed).toBe(false);
	});

	test("allows a strictly shaped read from a regular in-workspace file", () => {
		const repo = workspace();
		writeFileSync(path.join(repo, "source.ts"), "export const value = 1;\n");
		expect(classifyAgyToolCall("view_file", { AbsolutePath: path.join(repo, "source.ts"), StartLine: 1, EndLine: 1 }, repo).allowed).toBe(true);
	});

	test("rejects a hard-linked external credential from direct reads", () => {
		const fixture = workspace();
		const repo = path.join(fixture, "repo");
		const outside = path.join(fixture, "outside");
		mkdirSync(repo);
		mkdirSync(outside);
		const credential = path.join(outside, "id_ed25519");
		const inWorkspace = path.join(repo, "source.ts");
		writeFileSync(credential, "private key material\n");
		linkSync(credential, inWorkspace);

		expect(lstatSync(inWorkspace).nlink).toBe(2);
		expect(classifyAgyToolCall("view_file", { AbsolutePath: inWorkspace }, repo)).toMatchObject({ allowed: false, semanticEligible: false });
	});

	test("rejects hard-linked external files from recursive searches", () => {
		const fixture = workspace();
		const repo = path.join(fixture, "repo");
		const outside = path.join(fixture, "outside");
		const search = path.join(repo, "search");
		mkdirSync(search, { recursive: true });
		mkdirSync(outside);
		const credential = path.join(outside, "id_ed25519");
		const inWorkspace = path.join(search, "source.ts");
		writeFileSync(credential, "private key material\n");
		linkSync(credential, inWorkspace);

		expect(lstatSync(inWorkspace).nlink).toBe(2);
		for (const [name, args] of [
			["grep_search", { SearchPath: search, Query: "private" }],
			["find_by_name", { SearchDirectory: search, Pattern: "*.ts" }],
		] as const) {
			expect(classifyAgyToolCall(name, args, repo)).toMatchObject({ allowed: false, semanticEligible: false });
		}
	});

	test("rejects a symlink followed by parent traversal for direct and recursive reads", () => {
		const fixture = workspace();
		const repo = path.join(fixture, "repo");
		const outside = path.join(fixture, "outside");
		mkdirSync(repo);
		mkdirSync(path.join(outside, "nested"), { recursive: true });
		mkdirSync(path.join(outside, "search"));
		mkdirSync(path.join(repo, "search"));
		symlinkSync(path.join(outside, "nested"), path.join(repo, "link"), "dir");
		writeFileSync(path.join(outside, "public.ts"), "outside source\n");
		writeFileSync(path.join(repo, "public.ts"), "inside source\n");
		writeFileSync(path.join(outside, "search", "secret.ts"), "outside search result\n");
		const viewPath = `${repo}${path.sep}link${path.sep}..${path.sep}public.ts`;
		const recursivePath = `${repo}${path.sep}link${path.sep}..${path.sep}search`;

		expect(path.resolve(viewPath)).toBe(path.join(repo, "public.ts"));
		expect(readFileSync(viewPath, "utf8")).toBe("outside source\n");
		expect(readdirSync(recursivePath)).toEqual(["secret.ts"]);
		expect(classifyAgyToolCall("view_file", { AbsolutePath: viewPath }, repo)).toMatchObject({ allowed: false, semanticEligible: false });
		expect(classifyAgyToolCall("grep_search", { SearchPath: recursivePath, Query: "outside" }, repo)).toMatchObject({ allowed: false, semanticEligible: false });
		expect(classifyAgyToolCall("find_by_name", { SearchDirectory: recursivePath, Pattern: "*.ts" }, repo)).toMatchObject({ allowed: false, semanticEligible: false });
	});

	test("rejects oversized reads and wide directory listings", () => {
		const repo = workspace();
		const largeFile = path.join(repo, "large.ts");
		writeFileSync(largeFile, "x".repeat(1024 * 1024 + 1));
		expect(classifyAgyToolCall("view_file", { AbsolutePath: largeFile }, repo).allowed).toBe(false);
		const wide = path.join(repo, "wide");
		mkdirSync(wide);
		for (let index = 0; index < 1200; index += 1) writeFileSync(path.join(wide, `file-${index}.ts`), "");
		expect(classifyAgyToolCall("list_dir", { DirectoryPath: wide }, repo).allowed).toBe(false);
		for (const [name, args] of [
			["grep_search", { SearchPath: wide, Query: "fixture" }],
			["find_by_name", { SearchDirectory: wide, Pattern: "*" }],
		] as const) {
			expect(classifyAgyToolCall(name, args, repo).allowed).toBe(false);
		}
	});

	test("stops list_dir enumeration immediately after the entry budget is exceeded", () => {
		const repo = workspace();
		const wide = path.join(repo, "wide");
		mkdirSync(wide);
		for (let index = 0; index < 1200; index += 1) writeFileSync(path.join(wide, `file-${index}.ts`), "");
		const sample = opendirSync(wide);
		const directoryPrototype = Object.getPrototypeOf(sample) as { readSync: () => unknown };
		sample.closeSync();
		const originalRead = directoryPrototype.readSync;
		let readCount = 0;
		directoryPrototype.readSync = function (this: unknown): unknown {
			readCount += 1;
			return originalRead.call(this);
		};
		try {
			expect(classifyAgyToolCall("list_dir", { DirectoryPath: wide }, repo).allowed).toBe(false);
		} finally {
			directoryPrototype.readSync = originalRead;
		}
		expect(readCount).toBe(1001);
	});

	test("applies one total-entry budget across nested recursive search directories", () => {
		const repo = workspace();
		const nested = path.join(repo, "nested");
		mkdirSync(nested);
		for (let directory = 0; directory < 20; directory += 1) {
			const child = path.join(nested, `dir-${directory}`);
			mkdirSync(child);
			for (let file = 0; file < 51; file += 1) writeFileSync(path.join(child, `file-${file}.ts`), "");
		}
		for (const [name, args] of [
			["grep_search", { SearchPath: nested, Query: "fixture" }],
			["find_by_name", { SearchDirectory: nested, Pattern: "*" }],
		] as const) {
			expect(classifyAgyToolCall(name, args, repo).allowed).toBe(false);
		}
	});

	test("caps the aggregate filename bytes examined by recursive searches", () => {
		const repo = workspace();
		const named = path.join(repo, "named");
		mkdirSync(named);
		for (let index = 0; index < 300; index += 1) {
			const name = `file-${String(index).padStart(3, "0")}-${"x".repeat(220)}`;
			writeFileSync(path.join(named, name), "");
		}
		expect(classifyAgyToolCall("grep_search", { SearchPath: named, Query: "fixture" }, repo).allowed).toBe(false);
	});

	test("rejects a recursive search subtree with one file above its byte budget", () => {
		const repo = workspace();
		const search = path.join(repo, "search");
		mkdirSync(search);
		writeFileSync(path.join(search, "large.ts"), Buffer.alloc(8 * 1024 * 1024 + 1));

		expect(classifyAgyToolCall("grep_search", { SearchPath: search, Query: "fixture" }, repo)).toMatchObject({ allowed: false, semanticEligible: false });
	});

	test("rejects recursive search when individually small files exceed the aggregate byte budget", () => {
		const repo = workspace();
		const search = path.join(repo, "search");
		mkdirSync(search);
		writeFileSync(path.join(search, "first.ts"), Buffer.alloc(5 * 1024 * 1024));
		writeFileSync(path.join(search, "second.ts"), Buffer.alloc(5 * 1024 * 1024));

		for (const [name, args] of [
			["grep_search", { SearchPath: search, Query: "fixture" }],
			["find_by_name", { SearchDirectory: search, Pattern: "*.ts" }],
		] as const) {
			expect(classifyAgyToolCall(name, args, repo)).toMatchObject({ allowed: false, semanticEligible: false });
		}
	});

	test.each([".npmrc", ".netrc", "_netrc", ".pypirc", ".git-credentials", ".dockercfg", "application_default_credentials.json", ".aws/credentials", ".docker/config.json", ".config/gcloud/credentials.db", ".kube/config", ".envrc", "id_ecdsa", "secrets.yaml", ".config/gh/hosts.yml"])("denies credential store %s before relevance judgment or recursive search", (name) => {
		const repo = workspace();
		const target = path.join(repo, name);
		mkdirSync(path.dirname(target), { recursive: true });
		writeFileSync(target, "fixture credential; never sent to a reviewer\n");
		expect(classifyAgyToolCall("view_file", { AbsolutePath: target }, repo)).toMatchObject({ allowed: false, semanticEligible: false });
		expect(classifyAgyToolCall("grep_search", { SearchPath: repo, Query: "fixture" }, repo)).toMatchObject({ allowed: false, semanticEligible: false });
		expect(classifyAgyToolCall("find_by_name", { SearchDirectory: repo, Pattern: "*" }, repo)).toMatchObject({ allowed: false, semanticEligible: false });
		const example = path.join(repo, `${path.basename(name)}.example`);
		writeFileSync(example, "placeholder\n");
		expect(classifyAgyToolCall("view_file", { AbsolutePath: example }, repo).allowed).toBe(true);
	});

	test("rejects denied credential paths and unknown arguments", () => {
		const repo = workspace();
		writeFileSync(path.join(repo, ".env"), "TOKEN=not-used\n");
		expect(classifyAgyToolCall("view_file", { AbsolutePath: path.join(repo, ".env") }, repo).allowed).toBe(false);
		writeFileSync(path.join(repo, "source.ts"), "x\n");
		expect(classifyAgyToolCall("view_file", { AbsolutePath: path.join(repo, "source.ts"), AllowOutsideWorkspace: true }, repo).allowed).toBe(false);
	});

	test("fails relevance closed when confidence is missing or below threshold", async () => {
		const runtime = { decide: async () => ({ answers: { relevant: { type: "noul" as const, noul: 0.99 } }, model: "test", warnings: [] }) };
		const result = await judgeAgyRelevance(runtime, "review task", "view_file", { AbsolutePath: "/repo/a.ts" }, "/repo", 0);
		expect(result.allowed).toBe(false);
	});

	test("denies whole-worktree Git diffs containing tracked credentials", () => {
		const gitPrefix = "/usr/bin/git --no-pager --no-optional-locks --no-lazy-fetch -c core.fsmonitor=false -c core.hooksPath=/dev/null -c core.attributesFile=/dev/null -c log.showSignature=false";
		const fixture = workspace();
		for (const secretPath of [".env", "id_rsa"]) {
			for (const cached of [false, true]) {
				const repo = path.join(fixture, `${secretPath === ".env" ? "env" : "key"}-${cached ? "staged" : "unstaged"}`);
				mkdirSync(repo);
				git(repo, ["init", "--quiet"]);
				writeFileSync(path.join(repo, secretPath), "TOKEN=before-secret\n");
				git(repo, ["add", "--", secretPath]);
				git(repo, ["-c", "user.name=AGY test", "-c", "user.email=agy@example.invalid", "-c", "core.hooksPath=/dev/null", "commit", "--quiet", "-m", "baseline"]);
				writeFileSync(path.join(repo, secretPath), "TOKEN=after-secret\n");
				if (cached) git(repo, ["add", "--", secretPath]);
				const diffArgs = ["--no-pager", "--no-optional-locks", "--no-lazy-fetch", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "core.attributesFile=/dev/null", "-c", "log.showSignature=false", "diff", ...(cached ? ["--cached"] : []), "--no-ext-diff", "--no-textconv", "--ignore-submodules=all", "--", "."];
				const output = git(repo, diffArgs);
				expect(output).toContain("TOKEN=before-secret");
				expect(output).toContain("TOKEN=after-secret");
				const suffix = `diff ${cached ? "--cached " : ""}--no-ext-diff --no-textconv --ignore-submodules=all -- .`;
				expect(classifyAgyToolCall("run_command", { CommandLine: `${gitPrefix} ${suffix}`, Cwd: repo, WaitMsBeforeAsync: 5000 }, repo)).toMatchObject({ allowed: false, semanticEligible: false });
			}
		}
	});

	test("does not expose secret commit subjects through any allowed Git command", () => {
		const repo = workspace();
		const secretSubject = "TOKEN=before-secret";
		git(repo, ["init", "--quiet"]);
		writeFileSync(path.join(repo, "tracked.ts"), "export const value = 1;\\n");
		git(repo, ["add", "--", "tracked.ts"]);
		git(repo, ["-c", "user.name=AGY test", "-c", "user.email=agy@example.invalid", "-c", "core.hooksPath=/dev/null", "commit", "--quiet", "-m", secretSubject]);

		const gitPrefix = "/usr/bin/git --no-pager --no-optional-locks --no-lazy-fetch -c core.fsmonitor=false -c core.hooksPath=/dev/null -c core.attributesFile=/dev/null -c log.showSignature=false";
		const gitArgsPrefix = ["--no-pager", "--no-optional-locks", "--no-lazy-fetch", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "core.attributesFile=/dev/null", "-c", "log.showSignature=false"];
		const suffixes = [
			"status --porcelain=v1 --untracked-files=no --ignore-submodules=all",
			"diff --no-ext-diff --no-textconv --ignore-submodules=all -- .",
			"diff --cached --no-ext-diff --no-textconv --ignore-submodules=all -- .",
			"log -n 20 --oneline --no-show-signature",
		];
		const unrestrictedLog = git(repo, [...gitArgsPrefix, "log", "-n", "20", "--oneline", "--no-show-signature"]);
		expect(unrestrictedLog).toContain(secretSubject);

		let allowedCommands = 0;
		for (const suffix of suffixes) {
			const decision = classifyAgyToolCall("run_command", { CommandLine: `${gitPrefix} ${suffix}`, Cwd: repo, WaitMsBeforeAsync: 5000 }, repo);
			if (!decision.allowed) continue;
			allowedCommands += 1;
			const output = git(repo, [...gitArgsPrefix, ...suffix.split(" ")]);
			expect(output).not.toContain(secretSubject);
		}
		expect(allowedCommands).toBeGreaterThan(0);
	});

	test("rejects an oversized Git config before allowing status inspection", () => {
		const repo = workspace();
		git(repo, ["init", "--quiet"]);
		const config = path.join(repo, ".git", "config");
		const existing = readFileSync(config, "utf8");
		writeFileSync(config, `${existing}\n#${"x".repeat(64 * 1024)}\n`);
		const gitPrefix = "/usr/bin/git --no-pager --no-optional-locks --no-lazy-fetch -c core.fsmonitor=false -c core.hooksPath=/dev/null -c core.attributesFile=/dev/null -c log.showSignature=false";

		expect(classifyAgyToolCall("run_command", {
			CommandLine: `${gitPrefix} status --porcelain=v1 --untracked-files=no --ignore-submodules=all`,
			Cwd: repo,
			WaitMsBeforeAsync: 5000,
		}, repo)).toMatchObject({ allowed: false, semanticEligible: false });
	});

	test("rejects a Git command outside the exact safe status form", () => {
		const result = classifyAgyToolCall(
			"run_command",
			{
				CommandLine: "/usr/bin/git status --porcelain=v1; touch /tmp/pwned",
				Cwd: "/repo",
				WaitMsBeforeAsync: 5000,
			},
			"/repo",
		);
		expect(result.allowed).toBe(false);
	});
});
