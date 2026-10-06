import { describe, expect, test } from "bun:test";
import path from "node:path";
import {
	canonicalRel,
	globBase,
	globToRegExp,
	isInside,
	toPosix,
} from "../extensions/ce-core/utils/repo-paths";

describe("repo-paths — globToRegExp", () => {
	test("** matches zero or more directories", () => {
		const matcher = globToRegExp("src/**/*.ts");
		expect(matcher.test("src/a.ts")).toBe(true);
		expect(matcher.test("src/x/a.ts")).toBe(true);
		expect(matcher.test("src/x/y/a.ts")).toBe(true);
	});

	test("* matches a single segment and never crosses /", () => {
		const matcher = globToRegExp("src/*.ts");
		expect(matcher.test("src/a.ts")).toBe(true);
		expect(matcher.test("src/x/a.ts")).toBe(false);
	});

	test("escapes regex metacharacters", () => {
		const matcher = globToRegExp("a+b.ts");
		expect(matcher.test("a+b.ts")).toBe(true);
		expect(matcher.test("aab.ts")).toBe(false);
	});
});

describe("repo-paths — globBase", () => {
	test("returns the static directory prefix", () => {
		expect(globBase("src/**/*.ts")).toBe("src");
		expect(globBase("src/foo/*.ts")).toBe("src/foo");
		expect(globBase("a.txt")).toBe("");
	});
});

describe("repo-paths — canonicalRel", () => {
	test("collapses . and .. segments and returns a relative POSIX path", () => {
		const repo = path.resolve("/repo");
		expect(canonicalRel(repo, "a/./b/../c")).toBe("a/c");
	});
});

describe("repo-paths — isInside", () => {
	test("rejects escapes and absolute paths, accepts repo-relative paths", () => {
		expect(isInside("../x")).toBe(false);
		expect(isInside("/abs")).toBe(false);
		expect(isInside("a/b")).toBe(true);
	});

	test("rejects the repo root and empty paths", () => {
		expect(isInside("")).toBe(false);
	});
});

describe("repo-paths — toPosix", () => {
	test("normalizes platform separators to /", () => {
		expect(toPosix(`a${path.sep}b`)).toBe("a/b");
	});
});
