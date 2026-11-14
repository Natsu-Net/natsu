/**
 * Reading a response's Content-Security-Policy, for the scripts natsu
 * writes into a page itself (the lazy stylesheet loader, the navigation
 * runtime): each needs the nonce the policy lets scripts run by.
 */

import type { StylePolicy } from "./assets/contract.ts";

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

const HASH_SOURCE = /^'sha(?:256|384|512)-[A-Za-z0-9+/_-]+={0,2}'$/i;

interface StyleDirective {
	restricted: boolean;
	nonces: string[];
}

function styleDirectives(header: string): StyleDirective[] {
	const found: StyleDirective[] = [];
	for (const policy of header.split(",")) {
		const directives = new Map<string, string[]>();
		for (const directive of policy.split(";")) {
			const [name, ...sources] = directive.trim().split(/[\t\n\f\r ]+/);
			const key = name?.toLowerCase();
			if (key && !directives.has(key)) directives.set(key, sources);
		}
		const sources = directives.get("style-src-elem") ?? directives.get("style-src") ?? directives.get("default-src");
		if (!sources) continue;
		const nonces: string[] = [];
		let hashed = false;
		let inline = false;
		for (const source of sources) {
			const nonce = NONCE_SOURCE.exec(source)?.[1];
			if (nonce !== undefined) nonces.push(nonce);
			else if (HASH_SOURCE.test(source)) hashed = true;
			else if (source.toLowerCase() === "'unsafe-inline'") inline = true;
		}
		if (nonces.length === 0 && !hashed && inline) continue;
		found.push({ restricted: true, nonces });
	}
	return found;
}

export function stylePolicy(header: string | null | undefined): StylePolicy {
	if (!header) return { allowed: true };
	const directives = styleDirectives(header);
	const first = directives[0];
	if (!first) return { allowed: true };
	const nonce = first.nonces.find((candidate) => directives.every((directive) => directive.nonces.includes(candidate)));
	return nonce === undefined ? { allowed: false } : { allowed: true, nonce };
}

export function styleNonce(header: string | null | undefined): string | undefined {
	return stylePolicy(header).nonce;
}
