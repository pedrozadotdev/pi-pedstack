import { describe, expect, test } from "bun:test";
import {
	classifyCommandEffect,
	type CommandEffect,
} from "../extensions/ce-core/utils/command-effect";

function effectOf(command: string): CommandEffect {
	return classifyCommandEffect(command);
}

// ── Canonical examples (requirements tasktraceability table) ───────

describe("classifyCommandEffect canonical examples", () => {
	test("read-only search stays read_only with no targets", () => {
		expect(effectOf('grep -rn "foo" extensions/')).toEqual({
			effect: "read_only",
			targets: [],
			unresolvable: false,
		});
	});

	test("sed -i extracts the file operand and mutates", () => {
		expect(effectOf("sed -i 's/a/b/' extensions/ce-core/index.ts")).toEqual({
			effect: "mutates_workspace",
			targets: ["extensions/ce-core/index.ts"],
			unresolvable: false,
		});
	});

	test("redirect target mutates the workspace", () => {
		expect(effectOf("echo x > extensions/ce-core/index.ts")).toEqual({
			effect: "mutates_workspace",
			targets: ["extensions/ce-core/index.ts"],
			unresolvable: false,
		});
	});

	test("interpreters are ambiguous", () => {
		expect(effectOf("python gen.py").effect).toBe("ambiguous");
		expect(
			effectOf(`node -e "require('fs').writeFileSync('extensions/x.ts','')"`)
				.effect,
		).toBe("ambiguous");
	});

	test("package runners are package_runner or ambiguous", () => {
		expect(["package_runner", "ambiguous"]).toContain(
			effectOf("bun run generate").effect,
		);
	});

	test("dependency installs are installs_dependencies", () => {
		expect(effectOf("bun install").effect).toBe("installs_dependencies");
		expect(effectOf("npm install left-pad").effect).toBe("installs_dependencies");
	});

	test("test/build runs are runs_tests_or_builds", () => {
		expect(effectOf("bun test").effect).toBe("runs_tests_or_builds");
		expect(effectOf("tsc --noEmit").effect).toBe("runs_tests_or_builds");
	});
});

// ── Redirect grammar ───────────────────────────────────────────────

describe("classifyCommandEffect redirect grammar", () => {
	test("captures fd-prefixed and combined redirects", () => {
		expect(effectOf("echo x 2> err.log").targets).toEqual(["err.log"]);
		expect(effectOf("echo x &> all.log").targets).toEqual(["all.log"]);
		expect(effectOf("echo x >> out.log").targets).toEqual(["out.log"]);
	});

	test('">" inside quotes is data, not a redirect', () => {
		expect(effectOf('echo "a > b"')).toEqual({
			effect: "read_only",
			targets: [],
			unresolvable: false,
		});
	});

	test("filters /dev/null and fd duplication", () => {
		expect(effectOf("echo x > /dev/null")).toEqual({
			effect: "mutates_workspace",
			targets: [],
			unresolvable: false,
		});
		expect(effectOf("echo x 2>&1").targets).toEqual([]);
	});
});

// ── Unresolvable targets ───────────────────────────────────────────

describe("classifyCommandEffect unresolvable targets", () => {
	test("sed -i with no file operand is unresolvable", () => {
		const result = effectOf("sed -i 's/a/b/'");
		expect(result.effect).toBe("mutates_workspace");
		expect(result.targets).toEqual([]);
		expect(result.unresolvable).toBe(true);
	});

	test("rm -- -foo is unresolvable", () => {
		expect(effectOf("rm -- -foo")).toMatchObject({
			effect: "deletes_or_destructive",
			targets: [],
			unresolvable: true,
		});
	});

	test("$VAR and glob targets are unresolvable", () => {
		expect(effectOf("echo x > $TARGET")).toMatchObject({
			effect: "mutates_workspace",
			targets: [],
			unresolvable: true,
		});
		expect(effectOf("rm *.ts")).toMatchObject({
			effect: "deletes_or_destructive",
			targets: [],
			unresolvable: true,
		});
	});

	test("destructive with a literal target resolves", () => {
		expect(effectOf("rm extensions/foo.ts")).toEqual({
			effect: "deletes_or_destructive",
			targets: ["extensions/foo.ts"],
			unresolvable: false,
		});
	});
});

// ── Composition ────────────────────────────────────────────────────

describe("classifyCommandEffect composition", () => {
	test("separator-joined segments union targets and take the worst effect", () => {
		expect(effectOf("rm x && echo y > z")).toEqual({
			effect: "deletes_or_destructive",
			targets: ["x", "z"],
			unresolvable: false,
		});
		expect(effectOf("bun test && echo x > f")).toEqual({
			effect: "mutates_workspace",
			targets: ["f"],
			unresolvable: false,
		});
	});

	test("read-only pipelines and conjunctions stay read_only", () => {
		expect(effectOf("cat x | grep y").effect).toBe("read_only");
		expect(effectOf("cat a && cat b").effect).toBe("read_only");
	});

	test("mixed read_only + interpreter is ambiguous", () => {
		expect(effectOf("grep foo; python mutate.py").effect).toBe("ambiguous");
	});

	test("heredocs are never read_only and flag mutating bodies", () => {
		expect(effectOf("cat <<'EOF'\nstuff\nEOF").effect).not.toBe("read_only");
		expect(effectOf("cat <<EOF\nrm -rf x\nEOF").effect).toBe("ambiguous");
	});
});

// ── Nested shells ──────────────────────────────────────────────────

describe("classifyCommandEffect nested shells", () => {
	test("a proven read-only inner command stays read_only", () => {
		expect(effectOf('bash -c "grep foo"').effect).toBe("read_only");
		expect(effectOf("sh -c 'ls -la'").effect).toBe("read_only");
	});

	test("mutating or redirecting inner commands are ambiguous", () => {
		expect(effectOf('bash -c "rm x"').effect).toBe("ambiguous");
		expect(effectOf('bash -c "echo x > f"').effect).toBe("ambiguous");
	});
});

// ── Edges and purity ───────────────────────────────────────────────

describe("classifyCommandEffect edges", () => {
	test("empty, whitespace, and unknown binaries are ambiguous", () => {
		for (const command of ["", "   ", "\n", "frobnicate --x"]) {
			expect(effectOf(command).effect).toBe("ambiguous");
		}
	});

	test("is pure and idempotent", () => {
		const command = "rm x && echo y > z";
		expect(effectOf(command)).toEqual(effectOf(command));
	});

	test("never throws on odd input", () => {
		expect(() => effectOf("|||;;&>><<")).not.toThrow();
		expect(effectOf("|||;;&>><<").effect).toBeString();
	});
});
