/**
 * Reading a response's Content-Security-Policy, for the scripts natsu
 * writes into a page itself (the lazy stylesheet loader, the navigation
 * runtime): each needs the nonce the policy lets scripts run by.
 */

/** A nonce source as CSP3 writes it: `'nonce-` and a base64 or base64url value, nothing to escape in an attribute. */
const NONCE_SOURCE = /^'nonce-([A-Za-z0-9+/_-]+={0,2})'$/i;

/**
 * The nonce `header` (a Content-Security-Policy) allows scripts by.
 *
 * A <script> is held to a policy's `script-src-elem`, or its `script-src`
 * when it has none, or its `default-src`; the first directive of a name
 * counts and later ones are ignored, as a browser parses them. A nonce
 * another directive names (`style-src`) would not let the script run. The
 * header may hold several policies, joined by commas, each enforced on its
 * own; a script carries one nonce, the first that any of them allows
 * scripts by.
 */
export function scriptNonce(header: string | null): string | undefined {
	if (!header) return undefined;
	for (const policy of header.split(",")) {
		const directives = new Map<string, string[]>();
		for (const directive of policy.split(";")) {
			const [name, ...sources] = directive.trim().split(/[\t\n\f\r ]+/);
			const key = name?.toLowerCase();
			if (key && !directives.has(key)) directives.set(key, sources);
		}
		const sources = directives.get("script-src-elem") ?? directives.get("script-src") ?? directives.get("default-src") ?? [];
		for (const source of sources) {
			const nonce = NONCE_SOURCE.exec(source)?.[1];
			if (nonce !== undefined) return nonce;
		}
	}
	return undefined;
}
