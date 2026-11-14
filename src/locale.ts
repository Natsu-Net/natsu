/**
 * Language prefixes in the URL: `/fr/servers` is `/servers` drawn in French.
 *
 * A search engine sends no cookie, so a site whose language lives in a cookie
 * shows it a single language. With `app.localePrefixes({ prefixes: ["fr"] })`
 * every route is also served under `/fr`, the app sees the request without the
 * prefix (so its routes, middleware and path checks stay as they are) and
 * reads the language from `ctx.locale`. The default language keeps the bare
 * URLs, so nothing already linked or indexed moves.
 *
 * On the way out, an answer to a prefixed request keeps its visitor in that
 * language: same-site navigation targets in HTML (`<a href>`, `<form action>`)
 * and redirects (`Location`, `natsu-location`) get the prefix. Left alone:
 * paths the app excluded, paths with a file extension (assets, `sitemap.xml`),
 * links that already carry a prefix, and any `<a>` or `<form>` with an
 * `hreflang` attribute or `data-locale="off"` — a language switcher names the
 * exact URL it wants.
 */

export interface LocalePrefixOptions {
	/** The prefixes served besides the bare URLs, without slashes: `["fr"]`. */
	prefixes: readonly string[];
	/**
	 * Paths never served under a prefix and never rewritten: an exact path
	 * (`/sitemap.xml`) or, ending in `/`, everything below it (`/auth/`).
	 */
	exclude?: readonly string[];
}

export interface LocaleRouting {
	readonly prefixes: readonly string[];
	readonly exclude: readonly string[];
}

const PREFIX = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/;

export function localeRouting(options: LocalePrefixOptions): LocaleRouting {
	const prefixes = [...new Set(options.prefixes.map((prefix) => prefix.trim().toLowerCase()))];
	for (const prefix of prefixes) {
		if (!PREFIX.test(prefix)) throw new Error(`natsu: "${prefix}" is not a language prefix (two or three letters, optional region)`);
	}
	for (const path of options.exclude ?? []) {
		if (!path.startsWith("/")) throw new Error(`natsu: locale exclusion "${path}" must start with "/"`);
	}
	return { prefixes, exclude: [...(options.exclude ?? [])] };
}

export function isExcluded(routing: LocaleRouting, path: string): boolean {
	for (const rule of routing.exclude) {
		if (rule.endsWith("/") ? path === rule.slice(0, -1) || path.startsWith(rule) : path === rule) return true;
	}
	return false;
}

/** The prefix a path starts with and the path without it, or null when it has none. */
export function splitLocale(routing: LocaleRouting, path: string): { locale: string; path: string } | null {
	for (const locale of routing.prefixes) {
		const head = `/${locale}`;
		if (path === head || path === `${head}/`) return { locale, path: "/" };
		if (path.startsWith(`${head}/`)) {
			const rest = path.slice(head.length);
			return isExcluded(routing, rest) ? null : { locale, path: rest };
		}
	}
	return null;
}

/** A request for the same thing without the prefix; body, method and headers stay. */
export function strippedRequest(request: Request, path: string): Request {
	const url = new URL(request.url);
	url.pathname = path;
	return new Request(url.href, request);
}

const EXTENSION = /\/[^/]*\.[A-Za-z0-9]{1,8}$/;

/**
 * `target` as the visitor in `locale` should follow it: a same-site absolute
 * path gets the prefix, anything else comes back unchanged.
 */
export function localizeTarget(routing: LocaleRouting, locale: string, target: string): string {
	if (!target.startsWith("/") || target.startsWith("//") || target.startsWith("/\\")) return target;
	const end = target.search(/[?#]/);
	const path = end === -1 ? target : target.slice(0, end);
	const rest = end === -1 ? "" : target.slice(end);
	if (splitLocale(routing, path) || routing.prefixes.some((prefix) => path === `/${prefix}`)) return target;
	if (isExcluded(routing, path) || EXTENSION.test(path)) return target;
	return `/${locale}${path === "/" ? "" : path}${rest}`;
}

const TAG = /<(a|form)\b[^>]*>/gi;
const ATTRIBUTE = /(\s(?:href|action)\s*=\s*)(?:"([^"]*)"|'([^']*)')/i;
const OPT_OUT = /\s(?:hreflang\s*=|data-locale\s*=\s*["']?off\b)/i;

/** Rewrite the navigation targets of an HTML document or fragment for `locale`. */
export function localizeHtml(routing: LocaleRouting, locale: string, html: string): string {
	if (!html.includes("<a") && !html.includes("<A") && !html.includes("<form") && !html.includes("<FORM")) return html;
	return html.replace(TAG, (tag) => {
		if (OPT_OUT.test(tag)) return tag;
		return tag.replace(ATTRIBUTE, (whole, lead: string, double: string | undefined, single: string | undefined) => {
			// The prefix only goes in front of the path, so entities later in the value never need decoding.
			const value = double ?? single ?? "";
			const next = localizeTarget(routing, locale, value);
			if (next === value) return whole;
			const quote = double !== undefined ? '"' : "'";
			return `${lead}${quote}${next}${quote}`;
		});
	});
}
