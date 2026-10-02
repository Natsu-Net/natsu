/**
 * Page navigation, the server half: a click on a link answers only the part
 * of the next page that changes, and a few kilobytes of script swap it in.
 *
 * A page is a **shell** (the header, the footer around everything, the
 * document itself) and one or more **regions**, each an element with an id
 * and `data-natsu-region`:
 *
 *   <main id="main" data-natsu-region>…</main>
 *
 * The client runtime (`client/navigate.ts`) fetches the next page with a
 * `Natsu-Nav` header naming the page it is on. The server renders and caches
 * exactly as it does for any visitor, then cuts the finished page: the head,
 * the regions and the page's script list go back as a small HTML document,
 * and the runtime swaps the regions in place. There is no client-side
 * rendering anywhere; what arrives is HTML the server wrote.
 *
 * What a swap cannot change is guarded by two hashes, carried as
 * `<meta name="natsu" content="doc.shell">` on every page with a region:
 *
 * - **doc**: the build plus the headers a document keeps from its first load
 *   (its CSP above all: a page whose CSP allows an ad network cannot be
 *   swapped into a document whose CSP does not).
 * - **shell**: every byte outside the head and the regions, and the region
 *   ids. A different header, a re-minted CSRF token in the sign-out form, a
 *   tester banner: the shell differs, and the answer is a real page load.
 *
 * Either differs, or anything else natsu cannot prove safe (a route that did
 * not opt in, a redirect to elsewhere, a download, an inline script in a
 * region), and the answer is a 204 that tells the runtime to load the page for
 * real. A wrong guess costs one extra request, never a broken page.
 *
 * Where it runs, so no app has an ordering rule to follow: inside
 * `Assets.middleware()`, which is already inside `compress()`. Before the
 * route it reads and deletes the request headers, so no handler, no
 * PageCache key and no render can ever see them; after the route it works on
 * the rewritten page, so the part links the whole page's CSS chunk.
 *
 *   const assets = new Assets({ …, navigate: true });
 *   Routes.get("/products/:id", navigable(showProduct));
 *
 * Routes opt in with `navigable()`, checked before the handler runs: a GET
 * that does something (confirms an email, spends a token) must never run once
 * for a soft visit and again for the real load that follows a refusal.
 */

import { addVary } from "./compress.ts";
import { config } from "./config.ts";
import type { Context, Handler } from "./context.ts";
import { log } from "./logger.ts";

export interface NavigateOptions {
	/**
	 * More response headers a document keeps from its first load, hashed into
	 * the document key next to CSP, CSP-Report-Only, Referrer-Policy,
	 * Permissions-Policy, COOP and COEP: a page that differs in one of them is
	 * always a real load.
	 */
	documentHeaders?: string[];
	/**
	 * Put the runtime's `<script>` in the head of every page with a region
	 * (default true). Off, the page carries only the key and the app links
	 * `assets.url("natsu-navigate")` itself.
	 */
	inject?: boolean;
	/**
	 * Answer hover and touch prefetches (default true). Off, every prefetch is
	 * refused before any route runs; a click still swaps.
	 */
	prefetch?: boolean;
}

/**
 * What a handler knows about the navigation it is answering: `ctx.nav`.
 *
 * It is for refusing, never for rendering differently: the page drawn for a
 * soft visit is the page drawn for anyone, because it may be the one PageCache
 * keeps for everyone. On a request that is not a navigation `skip`, `reload`
 * and `stale` return false and do nothing, so code can call them whether or
 * not navigation is on.
 */
export interface Nav {
	/** The runtime asked: a click, a back/forward or a prefetch. */
	readonly requested: boolean;
	/** A speculative fetch on hover or touch, which the visitor may never see. */
	readonly prefetch: boolean;
	/**
	 * Refuse a prefetch: "not now". The answer is a 204 the runtime does not
	 * keep, and a click on the same link fetches again. False, and nothing
	 * happens, on anything that is not a prefetch.
	 */
	skip(): boolean;
	/**
	 * Load this URL for real: the answer is a 204 and the runtime does a full
	 * page load. `reason` is for the development log.
	 */
	reload(reason?: string): boolean;
	/**
	 * Check the document key early, before any data is fetched: `headers` are
	 * the document headers this answer will carry (its CSP), and any it lacks
	 * are read from what the response already holds. True when they differ
	 * from the document the visitor is on: return without rendering, and natsu
	 * answers a full load.
	 */
	stale(headers: Headers): boolean;
	/**
	 * Run `fn` only if this answer is a page: at once on a request that is not
	 * a navigation, and on a navigation only once the answer is known to be a
	 * part. For one-shot state, such as clearing a flash message that this
	 * page shows: a refused answer, followed by the real load, must not clear
	 * it first. A prefetch that answers a part runs it too, and the visitor
	 * may never open that part, so state that must not be used up unseen
	 * refuses prefetches first: `if (flashed && ctx.nav.skip()) return;`.
	 */
	shown(fn: () => void): void;
}

/** Why a navigation became a real load, as the `Natsu-Reload` header says it. */
export type ReloadReason = "route" | "document" | "shell" | "regions" | "response" | "inline-script";

/** The attribute that makes an element a region. */
export const REGION_ATTRIBUTE = "data-natsu-region";

/** Name of the runtime's entry in the asset manifest. */
export const RUNTIME_ENTRY = "natsu-navigate";

/** What `Natsu-Nav` may hold: the two hashes, base 36, as the meta writes them. */
const KEY = /^[a-z0-9]{1,13}\.[a-z0-9]{1,13}$/;

/** Every response header a document keeps from its first load. */
const DOCUMENT_HEADERS = [
	"content-security-policy",
	"content-security-policy-report-only",
	"referrer-policy",
	"permissions-policy",
	"cross-origin-opener-policy",
	"cross-origin-embedder-policy",
];

/** A nonce differs on every response, so it is never part of a key. */
const CSP_NONCE = /'nonce-[^']*'/gi;
const NONCE_ATTRIBUTE = /\snonce\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+)/gi;
/** A CSP nonce is base64 or base64url (CSP3's `base64-value`). */
const NONCE_VALUE = /^[A-Za-z0-9+/=_-]+$/;

/**
 * Headers that describe a body, dropped from a 204: the answer has none.
 * The document headers go too (see `Navigation.dropDocumentHeaders`);
 * Set-Cookie and every other header pass through.
 */
const ENTITY_HEADERS = [
	"content-type",
	"content-length",
	"content-encoding",
	"content-language",
	"content-disposition",
	"content-range",
	"accept-ranges",
	"etag",
	"last-modified",
	"expires",
	"location",
	"refresh",
];

/** Control answers and parts are never stored: not by a CDN, not by the browser's cache. */
const NO_STORE = "private, no-store";

/** The answer for a request that is not a navigation: inert, and the same object for all of them. */
export const inertNav: Nav = Object.freeze({
	requested: false,
	prefetch: false,
	skip: () => false,
	reload: () => false,
	stale: () => false,
	shown: (fn: () => void) => fn(),
});

// --- routes ----------------------------------------------------------------

/** Handlers that may answer a part, and whether they take prefetches. */
const navigables = new WeakMap<Handler, { prefetch: boolean }>();

/**
 * Let a route answer navigations. Checked before the handler runs: a route
 * that is not navigable answers a soft visit with a full load and never runs
 * for it, so a GET with side effects cannot run twice. `prefetch: false`
 * refuses hover and touch prefetches the same way, for pages that are costly
 * to draw or that count their views.
 *
 *   Routes.get("/", navigable(home));
 *   Routes.get("/checkout/review", navigable(review, { prefetch: false }));
 */
export function navigable(handler: Handler, options: { prefetch?: boolean } = {}): Handler {
	const marked: Handler = (ctx) => handler(ctx);
	Object.defineProperty(marked, "name", { value: handler.name || "navigable" });
	navigables.set(marked, { prefetch: options.prefetch !== false });
	return marked;
}

/**
 * Carry a handler's navigable flag over to one that wraps it. The router's
 * guards wrap a route's handler at compile time, and a wrapped route must
 * answer navigations exactly as the bare one would.
 */
export function keepNavigable(from: Handler, to: Handler): void {
	const flag = navigables.get(from);
	if (flag) navigables.set(to, flag);
}

/**
 * Refuse a navigation before `handler` runs, when its route did not opt in or
 * the request is a prefetch the route does not take. True when refused: the
 * caller returns without running the handler.
 */
export function refuseBeforeHandler(ctx: Context, handler: Handler): boolean {
	const nav = ctx.nav;
	if (!(nav instanceof NavRequest)) return false;
	const flag = navigables.get(handler);
	if (!flag) {
		nav.decide({ kind: "reload", reason: "route", detail: "the route is not navigable(): wrap its handler to let it answer parts" });
		return true;
	}
	if (nav.prefetch && !flag.prefetch) {
		nav.decide({ kind: "skip", detail: "the route takes no prefetch" });
		return true;
	}
	return false;
}

/**
 * Refuse a navigation that reached no route: a static file or the fallback
 * 404. Neither is a page drawn in the shell the visitor is on.
 */
export function refuseWithoutRoute(ctx: Context): boolean {
	const nav = ctx.nav;
	if (!(nav instanceof NavRequest)) return false;
	nav.decide({ kind: "reload", reason: "response", detail: "no route answers this path" });
	return true;
}

// --- the request -------------------------------------------------------------

type Decision =
	| { kind: "reload"; reason: ReloadReason; detail: string }
	| { kind: "skip"; detail: string }
	| { kind: "location"; url: string; detail: string };

/** `ctx.nav` on a navigation: what the runtime sent, and what the answer will be. */
class NavRequest implements Nav {
	public readonly requested = true;
	/** A decision made before the page was drawn (a refusal), which the answer follows. */
	public decision: Decision | undefined;
	private readonly queued: Array<() => void> = [];

	constructor(
		private readonly navigation: Navigation,
		private readonly ctx: Context,
		/** The key of the document the visitor is on. */
		public readonly doc: string,
		public readonly shell: string,
		public readonly prefetch: boolean,
	) {}

	/** The first decision stands: a later call cannot turn a refusal into a part. */
	public decide(decision: Decision): void {
		this.decision ??= decision;
	}

	public skip(): boolean {
		if (!this.prefetch) return false;
		this.decide({ kind: "skip", detail: "the handler called ctx.nav.skip()" });
		return true;
	}

	public reload(reason?: string): boolean {
		this.decide({ kind: "reload", reason: "route", detail: reason ? `ctx.nav.reload("${reason}")` : "the handler called ctx.nav.reload()" });
		return true;
	}

	public stale(headers: Headers): boolean {
		const response = this.ctx.response;
		const own = response.headersInitialized ? response.headers : undefined;
		const doc = this.navigation.docHash((name) => headers.get(name) ?? own?.get(name) ?? null);
		if (doc === this.doc) return false;
		this.decide({ kind: "reload", reason: "document", detail: "ctx.nav.stale(): the document headers differ" });
		return true;
	}

	public shown(fn: () => void): void {
		this.queued.push(fn);
	}

	/** The answer is a part: run what waited for it, in order. */
	public flush(): void {
		for (const fn of this.queued.splice(0)) fn();
	}
}

// --- the engine ----------------------------------------------------------------

/**
 * Navigation for one `Assets`: reads the request, answers it, and marks full
 * pages. Internal; apps reach it through the `navigate` option.
 */
export class Navigation {
	/** A hash of the asset manifest, set by `Assets.build()`. */
	public buildId = "";
	/** The runtime's URL, set by `Assets.build()`; "" until then. */
	public runtime = "";
	private readonly documentHeaders: string[];
	private readonly inject: boolean;
	private readonly prefetch: boolean;
	/** Development only: recent shell texts by hash, to say what changed on a mismatch. */
	private readonly shells = new Map<string, string>();
	/** Development only: paths already warned about, so a log is not a flood. */
	private readonly warned = new Set<string>();

	constructor(options: NavigateOptions = {}) {
		this.documentHeaders = [
			...DOCUMENT_HEADERS,
			...(options.documentHeaders ?? []).map((name) => name.toLowerCase()).filter((name) => !DOCUMENT_HEADERS.includes(name)),
		];
		this.inject = options.inject !== false;
		this.prefetch = options.prefetch !== false;
	}

	/**
	 * Before the route: read and delete the request headers, and set
	 * `ctx.nav`. True when the answer is already decided and nothing further
	 * in should run (a prefetch, with prefetches turned off).
	 */
	public begin(ctx: Context): boolean {
		const headers = ctx.request.headers;
		const value = headers.get("natsu-nav");
		// Deleted whatever they hold, before anything else runs: a handler that
		// could see them could draw a different page, and that page could be
		// kept by PageCache under the full page's key and served to a crawler.
		if (value === null) {
			if (headers.has("natsu-prefetch")) headers.delete("natsu-prefetch");
			return false;
		}
		const prefetch = headers.get("natsu-prefetch") === "1";
		headers.delete("natsu-nav");
		headers.delete("natsu-prefetch");
		if (ctx.method !== "GET") return false;
		// A browser navigation never carries the header; one that claims to is
		// not the runtime, and gets the page.
		if (headers.get("sec-fetch-mode") === "navigate" || headers.get("sec-fetch-dest") === "document") return false;
		if (!KEY.test(value)) return false;
		const dot = value.indexOf(".");
		const nav = new NavRequest(this, ctx, value.slice(0, dot), value.slice(dot + 1), prefetch);
		ctx.nav = nav;
		if (prefetch && !this.prefetch) {
			nav.decide({ kind: "skip", detail: "prefetches are off (navigate.prefetch: false)" });
			this.answer(ctx, (html) => html);
			return true;
		}
		return false;
	}

	/**
	 * After the route, for a navigation: a part, or a 204 that says why not.
	 * `rewrite` points the page at its chunks (identity for a page already
	 * rewritten); it runs only once the page is known to be worth cutting.
	 */
	public answer(ctx: Context, rewrite: (html: string) => string): void {
		const nav = ctx.nav;
		if (!(nav instanceof NavRequest)) return;
		if (nav.decision) return this.control(ctx, nav.decision);
		const response = ctx.response;
		const body = response.body;

		// A redirect is followed by the runtime, softly when it stays on this
		// site. Followed by fetch instead, a redirect elsewhere fails CORS and
		// the fallback would run the redirecting handler a second time.
		const status = body instanceof Response ? body.status : response.status;
		const location = body instanceof Response ? body.headers.get("location") : header(ctx, "location");
		if (status >= 300 && status < 400 && location) {
			const target = this.resolve(ctx, location);
			return this.control(
				ctx,
				target === null
					? { kind: "reload", reason: "response", detail: `a redirect to ${location}, which is not an http(s) URL` }
					: { kind: "location", url: target, detail: `a ${status} redirect` },
			);
		}

		if (typeof body !== "string" || !isDocument(ctx, body)) {
			return this.control(ctx, { kind: "reload", reason: "response", detail: `the answer is ${describe(ctx, body)}, not a page` });
		}

		// Cheapest first: the document headers need no page at all, and a
		// mismatch here skips the rewrite, which profiles the whole page.
		const doc = this.docHash((name) => header(ctx, name));
		if (doc !== nav.doc) return this.control(ctx, { kind: "reload", reason: "document", detail: "the document headers or the build differ" });

		const page = rewrite(body);
		const scan = scanPage(page);
		if (scan === null) {
			return this.control(ctx, { kind: "reload", reason: "regions", detail: `the page has no element with ${REGION_ATTRIBUTE}` });
		}
		if ("reason" in scan) return this.control(ctx, { kind: "reload", reason: scan.reason, detail: scan.detail });

		const shellText = shellOf(page, scan);
		const shell = hashOf(shellText);
		if (development()) this.remember(shell, shellText);
		if (shell !== nav.shell) {
			return this.control(ctx, { kind: "reload", reason: "shell", detail: this.shellChange(nav.shell, shellText) });
		}

		// It is a part: what waited for a page the visitor sees runs now, and
		// may still add headers (a cookie that clears a flash).
		nav.flush();
		const nonces = cspNonces(header(ctx, "content-security-policy"));
		const headers = response.headers;
		for (const name of ["content-length", "content-encoding", "etag", "last-modified", "expires", "location", "refresh"]) {
			headers.delete(name);
		}
		this.dropDocumentHeaders(headers);
		headers.set("content-type", "text/html; charset=utf-8");
		headers.set("cache-control", NO_STORE);
		headers.set("natsu-part", "1");
		addVary(headers, "Natsu-Nav");
		response.body = partOf(page, scan, `${doc}.${shell}`, nonces, this.runtime);
	}

	/**
	 * After the route, for anything else: a page with a region gets its key,
	 * and the runtime unless `inject` is off. The nonce on the runtime's tag
	 * is read from this response's own CSP, after any PageCache fill, so it is
	 * this visitor's.
	 */
	public full(ctx: Context, page: string): string {
		addVary(ctx.response.headers, "Natsu-Nav");
		if (page.indexOf(REGION_ATTRIBUTE) === -1) return page;
		const scan = scanPage(page);
		if (scan === null) return page;
		if ("reason" in scan) {
			if (development() && this.warned.size < 256 && !this.warned.has(ctx.path)) {
				this.warned.add(ctx.path);
				log.warn(`[<yellow>navigate</yellow>] ${ctx.path}: no soft navigation from this page (${scan.reason}: ${scan.detail})`);
			}
			return page;
		}
		const shellText = shellOf(page, scan);
		const shell = hashOf(shellText);
		if (development()) this.remember(shell, shellText);
		const key = `${this.docHash((name) => header(ctx, name))}.${shell}`;
		let tags = `<meta name="natsu" content="${key}">`;
		if (this.inject && this.runtime) {
			const nonce = cspNonces(header(ctx, "content-security-policy"))[0];
			tags += `<script src="${this.runtime}"${nonce ? ` nonce="${nonce}"` : ""} defer></script>`;
		}
		const at = scan.head[2];
		return `${page.slice(0, at)}${tags}${page.slice(at)}`;
	}

	/** The document key: the build and the document headers, nonces left out. */
	public docHash(get: (name: string) => string | null): string {
		let text = this.buildId;
		for (const name of this.documentHeaders) text += `\0${(get(name) ?? "").replace(CSP_NONCE, "")}`;
		return hashOf(text);
	}

	/**
	 * Take the document headers (CSP and the rest the document key hashes)
	 * off a part or a 204. Neither is ever a document: the runtime reads it
	 * with `fetch`, and the document on screen keeps the headers of its first
	 * load, which the key has just proved equal. A CSP is also the longest
	 * header most pages carry, and with a fresh nonce in it no header
	 * compression shares it between answers: on a small part it is a good
	 * share of the bytes.
	 */
	private dropDocumentHeaders(headers: Headers): void {
		for (const name of this.documentHeaders) headers.delete(name);
	}

	/** A 204 that carries the decision, Set-Cookie and nothing that describes a body. */
	private control(ctx: Context, decision: Decision): void {
		const response = ctx.response;
		const body = response.body;
		const headers = response.headers;
		if (body instanceof Response) {
			// Cookies a handler put on its own Response still go out: a redirect
			// that signs someone in is followed with them set.
			for (const cookie of body.headers.getSetCookie()) headers.append("set-cookie", cookie);
			void body.body?.cancel().catch(() => {});
		} else if (body instanceof ReadableStream) {
			void body.cancel().catch(() => {});
		}
		response.body = null;
		response.status = 204;
		for (const name of ENTITY_HEADERS) headers.delete(name);
		this.dropDocumentHeaders(headers);
		headers.set("cache-control", NO_STORE);
		addVary(headers, "Natsu-Nav");
		if (decision.kind === "location") headers.set("natsu-location", decision.url);
		else if (decision.kind === "skip") headers.set("natsu-prefetch", "skip");
		else headers.set("natsu-reload", decision.reason);
		if (development()) {
			const what = decision.kind === "location"
				? `redirect to ${decision.url}`
				: decision.kind === "skip" ? "prefetch refused" : `full load (${decision.reason})`;
			log.info(`[<magenta>navigate</magenta>] GET ${ctx.path}: ${what}: ${decision.detail}`);
		}
	}

	/**
	 * Where a redirect goes, for the runtime. A target on this site is sent
	 * as a path: behind a proxy that ends TLS, the request's own URL says
	 * `http:` where the visitor is on `https:`, and an absolute URL built from
	 * it would read as another origin and cost a full load. Null for anything
	 * but http(s): a browser never follows a redirect to `javascript:` or
	 * `data:`, and handing one to a script that would is how an open redirect
	 * becomes a script running on the page.
	 */
	private resolve(ctx: Context, location: string): string | null {
		let url: URL;
		try {
			url = new URL(location, ctx.request.url);
		} catch {
			return null;
		}
		if (url.protocol !== "http:" && url.protocol !== "https:") return null;
		return url.origin === ctx.url.origin ? `${url.pathname}${url.search}${url.hash}` : url.href;
	}

	private remember(shell: string, text: string): void {
		this.shells.delete(shell);
		this.shells.set(shell, text);
		if (this.shells.size > 64) this.shells.delete(this.shells.keys().next().value as string);
	}

	/** Development: the first line of the shell that changed, when the old shell is still known. */
	private shellChange(old: string, text: string): string {
		const before = development() ? this.shells.get(old) : undefined;
		if (before === undefined) return "the markup outside the head and the regions differs";
		return `the markup outside the head and the regions differs: ${firstDifference(before, text)}`;
	}
}

// --- reading a page --------------------------------------------------------------

interface Region {
	id: string;
	/** From the region's `<` to past its end tag's `>`. */
	start: number;
	end: number;
}

interface ScriptTag {
	start: number;
	end: number;
	/** The start tag as written. */
	open: string;
	src: string;
	nonce: string | undefined;
}

/** Where a page's parts are. */
export interface PageScan {
	/** `<head`, past its `>`, `</head`, past its `>`. */
	head: [number, number, number, number];
	regions: Region[];
	/** Every `<script src>` outside the head and the regions, in document order. */
	scripts: ScriptTag[];
	/** Comments and raw text (script, style, textarea, title): flat start/end pairs, in order. */
	raw: number[];
}

/** Why a page with regions cannot answer a part. */
export interface PageRefusal {
	reason: "regions" | "response" | "inline-script";
	detail: string;
}

/**
 * Find a page's head, regions and scripts, or say why it has none to offer.
 * Null when it has no region at all.
 *
 * Not a tokenizer: one pass finds the raw-text spans (comments, script,
 * style, textarea, title; there are few), `indexOf` finds each occurrence of
 * the attribute, which is checked to be a real attribute of a real start tag
 * outside them, and one more pass counts the region's own tag name to find
 * its end. So a `</main>` inside a JSON-LD block, a comment or a style never
 * ends a region. About 0.04 ms for a 19 KB page, 0.12 ms for 72 KB and
 * 0.42 ms for 282 KB (bench/navigate.ts); a page without the attribute costs
 * one `indexOf`.
 *
 * It reads markup as templates write it: tag and attribute names in lower
 * case, `<` in attribute values escaped.
 */
export function scanPage(html: string): PageScan | PageRefusal | null {
	if (html.indexOf(REGION_ATTRIBUTE) === -1) return null;
	const raw = rawRanges(html);

	const headOpen = findTag(html, raw, "<head", 0);
	const headClose = headOpen === -1 ? -1 : findTag(html, raw, "</head", headOpen);
	if (headClose === -1) return { reason: "response", detail: "the page has no <head>…</head>" };
	const headStart = html.indexOf(">", headOpen) + 1;
	const headEnd = html.indexOf(">", headClose) + 1;
	if (headEnd === 0) return { reason: "response", detail: "the page's </head> never ends" };

	const regions: Region[] = [];
	for (let hit = html.indexOf(REGION_ATTRIBUTE); hit !== -1; hit = html.indexOf(REGION_ATTRIBUTE, hit + REGION_ATTRIBUTE.length)) {
		// An attribute is preceded by whitespace and followed by `=`, `>`, `/`
		// or whitespace; text that merely mentions the name is not.
		if (!isSpace(html.charCodeAt(hit - 1)) || !isAttributeEnd(html.charCodeAt(hit + REGION_ATTRIBUTE.length))) continue;
		if (inside(raw, hit)) continue;
		const lt = html.lastIndexOf("<", hit);
		const tag = lt === -1 ? null : readTag(html, lt);
		if (!tag || tag.end <= hit || !tag.attributes.some((a) => a.at === hit && a.name === REGION_ATTRIBUTE)) continue;

		const label = `<${tag.name}${tag.get("id") ? ` id="${tag.get("id")}"` : ""}>`;
		if (hit < headEnd) return { reason: "regions", detail: `${label} is a region inside <head>` };
		const last = regions[regions.length - 1];
		if (last && lt < last.end) return { reason: "regions", detail: `${label} is a region inside region #${last.id}; regions must not nest` };
		const id = tag.get("id");
		if (!id) return { reason: "regions", detail: `${label} is a region without an id` };
		if (regions.some((region) => region.id === id)) return { reason: "regions", detail: `two regions have the id "${id}"` };
		if (VOID.has(tag.name) || TABLE.has(tag.name)) {
			return { reason: "regions", detail: `${label} cannot be a region: it needs an end tag and must be valid as a child of <body>` };
		}
		const end = endOf(html, raw, tag.name, tag.end);
		if (end === -1) return { reason: "regions", detail: `${label} has no end tag` };

		// A script parsed into a swapped region never runs, so a page whose
		// region needs one is loaded for real. A data block (JSON, JSON-LD) is
		// not a script that runs, and travels with its region.
		for (let i = firstAtOrAfter(raw, lt); i < raw.length && raw[i]! < end; i += 2) {
			if (!html.startsWith("<script", raw[i]!)) continue;
			const script = readTag(html, raw[i]!);
			if (script && runs(script)) {
				return {
					reason: "inline-script",
					detail: script.get("src") !== undefined
						? `region #${id} holds <script src="${script.get("src")}">, which does not run when swapped in; move it after the region`
						: `region #${id} holds an inline script, which does not run when swapped in`,
				};
			}
		}
		regions.push({ id, start: lt, end });
	}
	if (regions.length === 0) return null;

	// The script list: every <script src> outside the head and the regions.
	const scripts: ScriptTag[] = [];
	let region = 0;
	for (let i = 0; i < raw.length; i += 2) {
		const start = raw[i]!;
		if (start >= headOpen && start < headEnd) continue;
		while (region < regions.length && regions[region]!.end <= start) region++;
		if (region < regions.length && start >= regions[region]!.start) continue;
		if (!html.startsWith("<script", start)) continue;
		const tag = readTag(html, start);
		const src = tag?.get("src");
		if (!tag || src === undefined) continue;
		scripts.push({ start, end: raw[i + 1]!, open: html.slice(start, tag.end), src, nonce: tag.get("nonce") });
	}

	return { head: [headOpen, headStart, headClose, headEnd], regions, scripts, raw };
}

/**
 * What a swap leaves in place, as text: every byte outside the head and the
 * regions, less the script list and nonces, then the region ids in order. A
 * different text is a different shell.
 */
export function shellOf(html: string, scan: PageScan): string {
	const pieces: string[] = [];
	const [headOpen, , , headEnd] = scan.head;
	const segments: number[] = [0, headOpen, headEnd];
	for (const region of scan.regions) segments.push(region.start, region.end);
	segments.push(html.length);
	let script = 0;
	for (let i = 0; i < segments.length; i += 2) {
		let from = segments[i]!;
		const to = segments[i + 1]!;
		while (script < scan.scripts.length && scan.scripts[script]!.start < to) {
			const tag = scan.scripts[script++]!;
			if (tag.start < from) continue;
			pieces.push(html.slice(from, tag.start));
			from = tag.end;
		}
		if (from < to) pieces.push(html.slice(from, to));
	}
	let text = pieces.join("").replace(NONCE_ATTRIBUTE, "");
	for (const region of scan.regions) text += `\0${region.id}`;
	return text;
}

/**
 * The part: a small document with the page's head less its scripts, the key,
 * the regions in order and the script list. A script is listed only if its
 * nonce is this response's (when the CSP has one): the runtime creates the
 * listed scripts itself, and under `'strict-dynamic'` a script it creates
 * runs whatever its host, so markup that slipped into the page cannot become
 * a script by riding along.
 *
 * A nonce on anything else in the head (an inline `<style>`, a preload) is
 * written as `nonce=""` when it is this response's, and dropped when it is
 * not. That is how the browser shows the same element on the page already
 * there (it hides a nonce once the element is in a document with a CSP), so
 * the runtime's merge by `outerHTML` sees an unchanged element as unchanged;
 * and an element that is new gets the document's own nonce from the runtime,
 * the only one its CSP accepts, only if the server had vouched for it.
 */
export function partOf(html: string, scan: PageScan, key: string, nonces: readonly string[], runtime = ""): string {
	const [, headStart, headClose] = scan.head;
	let head = "";
	let from = headStart;
	for (let i = firstAtOrAfter(scan.raw, headStart); i < scan.raw.length && scan.raw[i]! < headClose; i += 2) {
		const start = scan.raw[i]!;
		if (!html.startsWith("<script", start)) continue;
		head += html.slice(from, start);
		from = scan.raw[i + 1]!;
	}
	head += html.slice(from, headClose);
	head = head.replace(NONCE_ATTRIBUTE, (attribute) => (nonces.includes(nonceValue(attribute)) ? ' nonce=""' : ""));
	let regions = "";
	for (const region of scan.regions) regions += html.slice(region.start, region.end);
	let scripts = "";
	for (const tag of scan.scripts) {
		if (nonces.length > 0 && (tag.nonce === undefined || !nonces.includes(tag.nonce))) continue;
		if (runtime && tag.src === runtime) continue;
		scripts += `${tag.open.replace(NONCE_ATTRIBUTE, "")}</script>`;
	}
	return `<!doctype html><html><head>${head}<meta name="natsu" content="${key}"></head><body>${regions}${scripts}</body></html>`;
}

/** The value of a `nonce=…` attribute as NONCE_ATTRIBUTE matched it, quotes taken off. */
function nonceValue(attribute: string): string {
	const value = attribute.slice(attribute.indexOf("=") + 1).trim();
	return value.startsWith('"') || value.startsWith("'") ? value.slice(1, -1) : value;
}

/** Every nonce a CSP header allows, in order. */
export function cspNonces(csp: string | null): string[] {
	if (!csp) return [];
	const out: string[] = [];
	for (const match of csp.matchAll(/'nonce-([^']*)'/gi)) {
		const value = match[1] ?? "";
		if (NONCE_VALUE.test(value) && !out.includes(value)) out.push(value);
	}
	return out;
}

// --- the scanner's pieces ------------------------------------------------------------

/**
 * Where a comment or an element whose insides the parser reads as text opens;
 * the name is captured, or undefined for a comment. One regular expression
 * rather than an `indexOf` per opener: it is one pass over the page, and
 * Bun's `indexOf` slows several times over on needles such as `<style` that
 * a page never holds.
 */
const RAW_OPEN = /<(?:!--|(script|style|textarea|title)[\s/>])/g;

/** `<name` or `</name` as a tag, per tag name: what a region's end is found by. */
const TAG_PATTERNS = new Map<string, RegExp>();

/** No end tag, so never a region. */
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
/** Parsed away outside a table, so never a region: the swap parses the part as a body. */
const TABLE = new Set(["caption", "col", "colgroup", "tbody", "td", "tfoot", "th", "thead", "tr"]);

/** JavaScript MIME types (HTML's list); with `module`, `importmap` and `speculationrules`, what runs. */
const SCRIPT_TYPES = new Set([
	"application/ecmascript",
	"application/javascript",
	"application/x-ecmascript",
	"application/x-javascript",
	"text/ecmascript",
	"text/javascript",
	"text/javascript1.0",
	"text/javascript1.1",
	"text/javascript1.2",
	"text/javascript1.3",
	"text/javascript1.4",
	"text/javascript1.5",
	"text/jscript",
	"text/livescript",
	"text/x-ecmascript",
	"text/x-javascript",
	"module",
	"importmap",
	"speculationrules",
]);

/** Comments and raw-text elements, as flat start/end pairs in document order. */
function rawRanges(html: string): number[] {
	const out: number[] = [];
	const open = RAW_OPEN;
	open.lastIndex = 0;
	for (let match = open.exec(html); match !== null; match = open.exec(html)) {
		const lt = match.index;
		const name = match[1];
		let end: number;
		if (name === undefined) {
			// `<!-->` and `<!--->` are whole comments, empty ones.
			if (html.startsWith(">", lt + 4)) end = lt + 5;
			else if (html.startsWith("->", lt + 4)) end = lt + 6;
			else {
				const close = html.indexOf("-->", lt + 4);
				end = close === -1 ? html.length : close + 3;
			}
		} else {
			end = closeOf(html, `</${name}`, html.indexOf(">", lt + name.length + 1));
		}
		out.push(lt, end);
		open.lastIndex = end;
	}
	return out;
}

/** Past the `>` of the first `close` tag at or after `from`; the end of the page if there is none. */
function closeOf(html: string, close: string, from: number): number {
	if (from === -1) return html.length;
	for (let at = html.indexOf(close, from); at !== -1; at = html.indexOf(close, at + 1)) {
		if (!isTagEnd(html.charCodeAt(at + close.length))) continue;
		const gt = html.indexOf(">", at);
		return gt === -1 ? html.length : gt + 1;
	}
	return html.length;
}

/** The first `<name` (or `</name`) at or after `from` that is a tag outside raw text, or -1. */
function findTag(html: string, raw: number[], needle: string, from: number): number {
	for (let at = html.indexOf(needle, from); at !== -1; at = html.indexOf(needle, at + 1)) {
		if (isTagEnd(html.charCodeAt(at + needle.length)) && !inside(raw, at)) return at;
	}
	return -1;
}

/**
 * Past the `>` of the end tag that closes the `name` element whose start tag
 * ends at `from`, counting the elements of the same name opened inside it;
 * -1 without one.
 */
function endOf(html: string, raw: number[], name: string, from: number): number {
	let pattern = TAG_PATTERNS.get(name);
	if (!pattern) {
		// Names are letters, digits and dashes (readTag), so nothing in one is a pattern.
		pattern = new RegExp(`<(/?)${name}[\\s/>]`, "g");
		if (TAG_PATTERNS.size < 64) TAG_PATTERNS.set(name, pattern);
	}
	pattern.lastIndex = from;
	let depth = 1;
	for (let match = pattern.exec(html); match !== null; match = pattern.exec(html)) {
		if (inside(raw, match.index)) continue;
		if (match[1] === "") {
			depth++;
			continue;
		}
		if (--depth === 0) {
			const gt = html.indexOf(">", match.index);
			return gt === -1 ? -1 : gt + 1;
		}
	}
	return -1;
}

/** Whether `at` falls inside one of the raw ranges (a binary search: they are in order). */
function inside(raw: number[], at: number): boolean {
	let lo = 0;
	let hi = (raw.length >> 1) - 1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		if (at < raw[mid * 2]!) hi = mid - 1;
		else if (at >= raw[mid * 2 + 1]!) lo = mid + 1;
		else return true;
	}
	return false;
}

/** Index (even) of the first raw range that starts at or after `at`. */
function firstAtOrAfter(raw: number[], at: number): number {
	let lo = 0;
	let hi = raw.length >> 1;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (raw[mid * 2]! < at) lo = mid + 1;
		else hi = mid;
	}
	return lo * 2;
}

interface Tag {
	name: string;
	attributes: Array<{ name: string; value: string; at: number }>;
	/** Past the `>`. */
	end: number;
	get(name: string): string | undefined;
}

/**
 * Read the start tag at `lt`: its name and attributes as the HTML parser
 * splits them, quoted values included. Null if `lt` does not start one.
 */
function readTag(html: string, lt: number): Tag | null {
	let i = lt + 1;
	while (i < html.length && isNameChar(html.charCodeAt(i))) i++;
	if (i === lt + 1) return null;
	const name = html.slice(lt + 1, i).toLowerCase();
	const attributes: Tag["attributes"] = [];
	for (;;) {
		while (i < html.length && (isSpace(html.charCodeAt(i)) || html.charCodeAt(i) === 47)) i++;
		if (i >= html.length) return null;
		if (html.charCodeAt(i) === 62) break;
		const at = i;
		while (i < html.length && !isAttributeEnd(html.charCodeAt(i))) i++;
		if (i === at) i++; // a stray `=` is a one-letter name, as the parser reads it
		const attribute = html.slice(at, i).toLowerCase();
		let j = i;
		while (j < html.length && isSpace(html.charCodeAt(j))) j++;
		let value = "";
		if (html.charCodeAt(j) === 61) {
			j++;
			while (j < html.length && isSpace(html.charCodeAt(j))) j++;
			const quote = html.charCodeAt(j);
			if (quote === 34 || quote === 39) {
				const close = html.indexOf(html[j]!, j + 1);
				if (close === -1) return null;
				value = html.slice(j + 1, close);
				i = close + 1;
			} else {
				const from = j;
				while (j < html.length && !isSpace(html.charCodeAt(j)) && html.charCodeAt(j) !== 62) j++;
				value = html.slice(from, j);
				i = j;
			}
		}
		attributes.push({ name: attribute, value, at });
	}
	return {
		name,
		attributes,
		end: i + 1,
		get: (wanted) => attributes.find((a) => a.name === wanted)?.value,
	};
}

/** Whether a script element runs: anything with a `src`, or inline code of a script type. */
function runs(script: Tag): boolean {
	if (script.get("src") !== undefined) return true;
	const type = (script.get("type") ?? "").split(";")[0]!.trim().toLowerCase();
	return type === "" || SCRIPT_TYPES.has(type);
}

function isSpace(code: number): boolean {
	return code === 32 || code === 9 || code === 10 || code === 12 || code === 13;
}

/** What may follow a tag name: whitespace, `/`, `>`. */
function isTagEnd(code: number): boolean {
	return isSpace(code) || code === 47 || code === 62;
}

/** What ends an attribute name: whitespace, `/`, `>`, `=`. */
function isAttributeEnd(code: number): boolean {
	return isTagEnd(code) || code === 61 || Number.isNaN(code);
}

function isNameChar(code: number): boolean {
	return (code >= 97 && code <= 122) || (code >= 65 && code <= 90) || (code >= 48 && code <= 57) || code === 45;
}

// --- small helpers -------------------------------------------------------------------

/** Base-36 `Bun.hash`: at most 13 characters, and never leaves this process as anything but a key. */
function hashOf(text: string): string {
	return Bun.hash(text).toString(36);
}

/** A response header, without making the response allocate a Headers it does not have. */
function header(ctx: Context, name: string): string | null {
	return ctx.response.headersInitialized ? ctx.response.headers.get(name) : null;
}

/** Whether a string body is a page: by its type, or by its first character when it names none. */
export function isDocument(ctx: Context, body: string): boolean {
	const type = header(ctx, "content-type");
	return type ? type.includes("html") : body.startsWith("<");
}

function describe(ctx: Context, body: unknown): string {
	if (body === undefined || body === null) return "empty";
	if (body instanceof Response) return `a Response (${body.status})`;
	if (typeof body === "string") return header(ctx, "content-type") ?? "text";
	if (body instanceof Blob) return "a file";
	if (body instanceof ReadableStream) return "a stream";
	return "JSON";
}

function development(): boolean {
	return config.General.development;
}

/** The first line two texts differ on, trimmed to the neighbourhood of the first differing character. */
function firstDifference(before: string, after: string): string {
	const a = before.split("\n");
	const b = after.split("\n");
	for (let line = 0; line < Math.max(a.length, b.length); line++) {
		const x = a[line] ?? "";
		const y = b[line] ?? "";
		if (x === y) continue;
		let at = 0;
		while (at < x.length && at < y.length && x[at] === y[at]) at++;
		const from = Math.max(0, at - 40);
		const clip = (text: string) => JSON.stringify(text.slice(from, at + 80));
		return `line ${line + 1}, column ${at + 1}: was ${clip(x)}, now ${clip(y)}`;
	}
	return "only the region ids differ";
}
