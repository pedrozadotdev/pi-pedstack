// Shared path/glob helpers (plan Unit 1). Extracted verbatim from
// stage-gate/evidence.ts so the scout and the stage gate share one
// implementation. Pure except `isEscapingSymlink`, which probes the filesystem.
import fs from "node:fs/promises";
import path from "node:path";

/** Canonical repo-relative POSIX path (backslashes normalized, `.`/`..` collapsed). */
export function canonicalRel(repoRoot: string, raw: string): string {
	const normalized = raw.replace(/\\/g, "/");
	return path.relative(repoRoot, path.resolve(repoRoot, normalized)).replace(/\\/g, "/");
}

export function toPosix(value: string): string {
	return value.split(path.sep).join("/");
}

export function isInside(rel: string): boolean {
	return rel !== "" && !rel.startsWith("../") && !path.isAbsolute(rel);
}

/** Converts a glob with `*` (single segment) and `**` (recursive) to a RegExp. */
export function globToRegExp(glob: string): RegExp {
	let source = "";
	for (let index = 0; index < glob.length; index++) {
		const char = glob[index];
		if (char === "*") {
			if (glob[index + 1] === "*") {
				index++;
				if (glob[index + 1] === "/") {
					index++;
					source += "(?:.*/)?";
				} else {
					source += ".*";
				}
			} else {
				source += "[^/]*";
			}
			continue;
		}
		source += /[\\^$+.()|{}[\]]/.test(char) ? `\\${char}` : char;
	}
	return new RegExp(`^${source}$`);
}

/** Static directory prefix of a glob, used to bound the filesystem walk. */
export function globBase(glob: string): string {
	const wildcard = glob.indexOf("*");
	const staticPart = wildcard === -1 ? glob : glob.slice(0, wildcard);
	const slash = staticPart.lastIndexOf("/");
	return slash === -1 ? "" : staticPart.slice(0, slash);
}

export async function isEscapingSymlink(
	repoRoot: string,
	abs: string,
): Promise<boolean> {
	try {
		const real = await fs.realpath(abs);
		return !isInside(canonicalRel(repoRoot, real));
	} catch {
		return true;
	}
}
