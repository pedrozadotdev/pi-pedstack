// Shared conversation-excerpt sanitizer (AD-7). One implementation of credential
// redaction + URL query/fragment stripping, imported by both the drift guard and
// the compaction guard. Pure: no I/O.

// Bounded prefix repetition (`{0,64}`) prevents catastrophic backtracking on
// long excerpt text with no `=`; the earlier unbounded `*` was quadratic.
const CREDENTIAL_ASSIGNMENT =
	/(\b[A-Za-z0-9_]{0,64}(?:TOKEN|KEY|SECRET|PASSWORD|PASSWD))=(\S+)/gi;
const FIRST_URL = /https?:\/\/[^\s]+/;

/** Redact credential assignments and strip URL query/fragment. */
export function redactSecrets(text: string): string {
	let out = typeof text === "string" ? text : String(text ?? "");
	out = out.replace(CREDENTIAL_ASSIGNMENT, "$1=[redacted]");
	const url = FIRST_URL.exec(out)?.[0];
	if (url) {
		try {
			const parsed = new URL(url);
			parsed.search = "";
			parsed.hash = "";
			parsed.username = "";
			parsed.password = "";
			out = out.replace(url, parsed.toString());
		} catch {
			// Not a parseable URL; keep the sanitized credential form.
		}
	}
	return out;
}
