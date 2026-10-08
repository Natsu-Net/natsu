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
import { GetController } from "./controller.ts";
import { scriptNonce } from "./csp.ts";
import { log } from "./logger.ts";
import type { CachedPage, Filled } from "./page-cache.ts";

export interface NavigateOptions {
	/**
	 * More response headers a document keeps from its first load, hashed into
	 * the document key next to CSP, CSP-Report-Only, Referrer-Policy,
	 * Permissions-Policy, COOP and COEP: a page that differs in one of them is
	 * always a real load.
	 */
	documentHeaders?: string[];
	/**
	 * Put the runtime's `<script defer>` in the head of every page (default
	 * true), before the head's first deferred script: pages with a region
	 * swap, and on every page `natsu.mount` and islands work. Off, a page
	 * with a region carries only the key and the app links
	 * `assets.url("natsu-navigate")` itself.
	 */
	inject?: boolean;
	/**
	 * Answer hover and touch prefetches (default true). Off, the key says so
	 * (`data-prefetch="off"`) and the runtime sends none, and any that comes
	 * anyway is refused before a route runs; a click still swaps.
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
export type ReloadReason = "route" | "document" | "shell" | "regions" | "response" | "inline-script" | "markup";

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
/** A script start tag anywhere, in any case. */
const SCRIPT_TAG = /<script[\t\n\f\r />]/i;
/** A script tag with a nonce, as a page using a nonce CSP carries (development checks only). */
const SCRIPT_NONCE = /<script\b[^>]*\snonce\s*=/i;
const NONCE_ATTRIBUTE = /\snonce\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;
/**
 * How the inline script that links a lazy stylesheet (Assets' `lazyLoader`)
 * starts, up to its selector: left out of the shell (see `shellOf`).
 */
export const LAZY_LOADER_HEAD = '(()=>{let d=0,a=document.currentScript.previousElementSibling,E=["pointerover","pointerdown","touchstart","keydown","focusin","scroll"],S=';
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

/** The longest `Natsu-Scripts` sent; past it the page is a real load (proxies cap a header near 8 KB). */
const SCRIPTS_HEADER_LIMIT = 6144;

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
 *   Routes.get("/shop", navigable("Shop@index"));
 *
 * Mark the handler the route is registered with: a wrapper put around a
 * navigable handler hides the mark, unless it is a navigable() too. On a
 * decorated controller, `@Navigable()` on the method does the same.
 */
export function navigable(ref: Handler | string, options: { prefetch?: boolean } = {}): Handler {
	const handler = typeof ref === "string" ? GetController(ref) : ref;
	const marked: Handler = (ctx) => handler(ctx);
	Object.defineProperty(marked, "name", { value: typeof ref === "string" ? ref : handler.name || "navigable" });
	keepNavigable(handler, marked);
	navigables.set(marked, { prefetch: options.prefetch !== false });
	return marked;
}

/** Handlers that answer `data-natsu-island` fetches. */
const islands = new WeakSet<Handler>();

/**
 * Let a route fill an island: an element with `data-natsu-island="<url>"`,
 * which the runtime fills from that URL after the page loads (a
 * notification bell, an account menu: what differs per visitor on a page
 * that is otherwise the same for everyone, and so cacheable).
 *
 *   Routes.get("/bell", island(bell));
 *
 * The runtime asks with `Natsu-Island: 1` and takes the answer only when it
 * says `Natsu-Island: 1` back, which only a route made with `island()` does.
 * Any other route is refused before its handler runs: an attribute is easy
 * to slip into user content, and an island naming `/account/delete` must not
 * pull that page's form, CSRF token and all, into someone's product page.
 */
export function island(ref: Handler | string): Handler {
	const handler = typeof ref === "string" ? GetController(ref) : ref;
	const marked: Handler = (ctx) => handler(ctx);
	Object.defineProperty(marked, "name", { value: typeof ref === "string" ? ref : handler.name || "island" });
	keepNavigable(handler, marked);
	islands.add(marked);
	return marked;
}

/** Island fetches in flight: refused before any route that is not an `island()`. */
const islandRequests = new WeakSet<Context>();
/** Island fetches an `island()` route was let through to answer: only these say Natsu-Island back. */
const islandAnswers = new WeakSet<Context>();

/** Whether this request is the runtime filling an island. */
export function isIslandRequest(ctx: Context): boolean {
	return islandRequests.has(ctx);
}

/**
 * Carry a handler's navigable and island flags over to one that wraps it.
 * The router's guards wrap a route's handler at compile time, and a wrapped
 * route must answer navigations exactly as the bare one would.
 */
export function keepNavigable(from: Handler, to: Handler): void {
	const flag = navigables.get(from);
	if (flag) navigables.set(to, flag);
	if (islands.has(from)) islands.add(to);
}

/**
 * Refuse a navigation before `handler` runs, when its route did not opt in or
 * the request is a prefetch the route does not take; and an island fetch,
 * when the route is not an `island()`. True when refused: the caller returns
 * without running the handler.
 */
export function refuseBeforeHandler(ctx: Context, handler: Handler): boolean {
	if (islandRequests.has(ctx)) {
		if (islands.has(handler)) {
			islandAnswers.add(ctx);
			return false;
		}
		refuseIsland(ctx);
		return true;
	}
	const nav = ctx.nav;
	if (!(nav instanceof NavRequest)) return false;
	const flag = navigables.get(handler);
	if (!flag) {
		nav.decide({ kind: "reload", reason: "route", detail: "the route is not navigable(): wrap the handler it is registered with in navigable() (or mark the controller method @Navigable()) to let it answer parts" });
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
	if (islandRequests.has(ctx)) {
		refuseIsland(ctx);
		return true;
	}
	const nav = ctx.nav;
	if (!(nav instanceof NavRequest)) return false;
	nav.decide({ kind: "reload", reason: "response", detail: "no route answers this path" });
	return true;
}

/** An empty answer the runtime leaves the island alone on. */
function refuseIsland(ctx: Context): void {
	const response = ctx.response;
	response.status = 204;
	response.body = null;
	response.headers.set("cache-control", NO_STORE);
	addVary(response.headers, "Natsu-Island");
	if (development()) log.info(`[<magenta>navigate</magenta>] GET ${ctx.path}: island refused: the route is not island()`);
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
	/** Development only: what each path was already warned about, so a log is not a flood. */
	private readonly warned = new Set<string>();
	/** What `full` read off each kept page (see `fullFilled`). */
	private readonly shapes = new WeakMap<CachedPage, Shape>();

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
		const isle = headers.get("natsu-island");
		if (isle !== null) {
			headers.delete("natsu-island");
			if (isle === "1" && ctx.method === "GET" && headers.get("sec-fetch-mode") !== "navigate") islandRequests.add(ctx);
		}
		const value = headers.get("natsu-nav");
		// Deleted whatever they hold, before anything else runs: a handler that
		// could see them could draw a different page, and that page could be
		// kept by PageCache under the full page's key and served to a crawler.
		if (value === null) {
			if (headers.has("natsu-prefetch")) headers.delete("natsu-prefetch");
			return false;
		}
		// An action the runtime posts (`Natsu-Action: 1`) is answered as a visit
		// is: its 303 back becomes a visit of the page, a refused form a part.
		const action = ctx.method === "POST" && headers.get("natsu-action") === "1";
		const prefetch = !action && headers.get("natsu-prefetch") === "1";
		headers.delete("natsu-nav");
		headers.delete("natsu-prefetch");
		headers.delete("natsu-action");
		if (ctx.method !== "GET" && !action) return false;
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

		const csp = header(ctx, "content-security-policy");
		const nonces = cspNonces(csp);
		const part = partOf(page, scan, `${doc}.${shell}`, nonces, this.runtime, csp !== null && /'strict-dynamic'/i.test(csp));
		if (part.scripts.length > SCRIPTS_HEADER_LIMIT) {
			return this.control(ctx, { kind: "reload", reason: "response", detail: `the page lists more scripts than a header carries (${part.scripts.length} bytes)` });
		}

		// It is a part: what waited for a page the visitor sees runs now, and
		// may still add headers (a cookie that clears a flash).
		nav.flush();
		const headers = response.headers;
		for (const name of ["content-length", "content-encoding", "etag", "last-modified", "expires", "location", "refresh"]) {
			headers.delete(name);
		}
		this.dropDocumentHeaders(headers);
		headers.set("content-type", "text/html; charset=utf-8");
		headers.set("cache-control", NO_STORE);
		headers.set("natsu-part", "1");
		if (part.scripts) headers.set("natsu-scripts", part.scripts);
		if (nonces.length > 0) headers.set("natsu-nonce", nonces.join(" "));
		addVary(headers, "Natsu-Nav");
		response.body = part.html;
	}

	/**
	 * After the route, on an island fetch that an `island()` route answered:
	 * the answer says it is one, which is what the runtime checks before it
	 * fills an element with it.
	 */
	public island(ctx: Context): void {
		if (!islandRequests.has(ctx)) return;
		const headers = ctx.response.headers;
		addVary(headers, "Natsu-Island");
		if (ctx.response.status !== 204 && islandAnswers.has(ctx)) headers.set("natsu-island", "1");
	}

	/**
	 * After the route, for anything else: a page with a region gets its key,
	 * and the runtime unless `inject` is off. The nonce on the runtime's tag
	 * is read from this response's own CSP, after any PageCache fill, so it is
	 * this visitor's.
	 */
	public full(ctx: Context, page: string): string {
		addVary(ctx.response.headers, "Natsu-Nav");
		const shape = shapeOf(page, this.inject && this.runtime !== "");
		const tags = this.tags(ctx, shape, shape.shell, shape.hash, page);
		return tags ? `${page.slice(0, shape.at)}${tags}${page.slice(shape.at)}` : page;
	}

	/**
	 * `full` for `page`, an answer PageCache filled from a page it keeps
	 * rewritten. The kept page is read once, not on every answer, and the
	 * answer is built from its pieces: cutting `page` itself would copy it a
	 * second time, which costs about as much as the rest of a hit.
	 * `transform` is what the answer still needs per request (the lazy
	 * stylesheet loaders' nonce), applied to the kept page's pieces.
	 */
	public fullFilled(ctx: Context, page: string, filled: Filled, transform?: (text: string) => string): string {
		addVary(ctx.response.headers, "Natsu-Nav");
		let shape = this.shapes.get(filled.page);
		if (shape === undefined) {
			const kept = filled.page.body;
			shape = shapeOf(kept, this.inject && this.runtime !== "");
			if (shape.at !== -1) shape = { ...shape, before: kept.slice(0, shape.at), after: kept.slice(shape.at) };
			this.shapes.set(filled.page, shape);
		}
		// A secret outside the regions (a CSRF token in a header form) makes
		// the shell this visitor's, and its hash too.
		const shell = shape.shell === undefined ? undefined : filled.fill(shape.shell);
		const tags = this.tags(ctx, shape, shell, shell === shape.shell ? shape.hash : hashOf(shell!), page);
		if (!tags) return transform ? transform(page) : page;
		const before = transform ? transform(shape.before!) : shape.before!;
		const after = transform ? transform(shape.after!) : shape.after!;
		return filled.fill(before) + tags + filled.fill(after);
	}

	/** The key and the runtime for a page of this shape; "" for none. */
	private tags(ctx: Context, shape: Shape, shell: string | undefined, hash: string, page: string): string {
		if (shape.refusal && development()) this.warnOnce(ctx, `no soft navigation from this page (${shape.refusal.reason}: ${shape.refusal.detail})`);
		if (shape.at === -1) return "";
		const csp = header(ctx, "content-security-policy");
		let tags = "";
		if (shell !== undefined) {
			if (development()) this.remember(hash, shell);
			const prefetch = this.prefetch ? "" : ' data-prefetch="off"';
			tags = `<meta name="natsu" content="${this.docHash((name) => header(ctx, name))}.${hash}"${prefetch}>`;
		}
		if (this.inject && this.runtime) {
			const nonce = scriptNonce(csp);
			tags += `<script src="${this.runtime}"${nonce ? ` nonce="${nonce}"` : ""} defer></script>`;
		}
		// A CSP set after Assets ran (a middleware that sets it once the route
		// has answered) is one this step never saw: the runtime's tag has no
		// nonce and is blocked, so the page simply loads for real every time.
		if (csp === null && development() && SCRIPT_NONCE.test(page)) {
			this.warnOnce(ctx, "the page's scripts carry nonces but the response had no Content-Security-Policy when Assets ran, so the runtime's script gets none; set the header before calling next(), or register that middleware inside Assets");
		}
		return tags;
	}

	private warnOnce(ctx: Context, message: string): void {
		const key = `${ctx.path}\0${message}`;
		if (this.warned.size >= 256 || this.warned.has(key)) return;
		this.warned.add(key);
		log.warn(`[<yellow>navigate</yellow>] ${ctx.path}: ${message}`);
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
		if (url.origin !== ctx.url.origin) return url.href;
		// A path that starts with `//` (or `/\`, which URLs read the same way)
		// would be read as another host: `/.` in front keeps it a path here,
		// and resolving drops the dot.
		const path = /^\/[/\\]/.test(url.pathname) ? `/.${url.pathname}` : url.pathname;
		return `${path}${url.search}${url.hash}`;
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

/** What `full` reads off a page: the same for every answer filled from one kept page. */
interface Shape {
	/** Where the tags go; -1 for a page that gets none. */
	at: number;
	/** The shell, for a page that gets a key, and its hash. */
	shell: string | undefined;
	hash: string;
	/** Why a page with a region gets no key (development says so, once per path). */
	refusal: { reason: string; detail: string } | undefined;
	/** A kept page either side of `at` (see `fullFilled`). */
	before?: string;
	after?: string;
}

/**
 * `runtime`: whether a page with no key still gets the runtime's tag (its
 * scripts' mounts and its islands work everywhere; only soft visits need a key).
 */
function shapeOf(page: string, runtime: boolean): Shape {
	const scan = page.indexOf(REGION_ATTRIBUTE) === -1 ? null : scanPage(page);
	if (scan === null || "reason" in scan) {
		const refusal = scan ?? undefined;
		const at = runtime && refusal?.reason !== "response" ? runtimeAt(page) : -1;
		return { at, shell: undefined, hash: "", refusal };
	}
	const shell = shellOf(page, scan);
	return { at: scan.deferred !== -1 ? scan.deferred : scan.head[2], shell, hash: hashOf(shell), refusal: undefined };
}

/**
 * Where the tags go in a page the region scan did not read: before the
 * head's first deferred script, as on a page with regions; before
 * `</head>` when it has none; -1 with no head. One walk over the head alone.
 */
function runtimeAt(html: string): number {
	const markup = readMarkup(html, true);
	return markup.deferred !== -1 ? markup.deferred : markup.head[2];
}


interface Region {
	id: string;
	/** From the region's `<` to past its end tag's `>`. */
	start: number;
	end: number;
}

interface ScriptTag {
	start: number;
	end: number;
	/** The start tag's attributes, as written. */
	attributes: Tag["attributes"];
	src: string;
	nonce: string | undefined;
}

/** Where a page's parts are. */
export interface PageScan {
	/** `<head`, past its `>`, `</head`, past its `>`. */
	head: [number, number, number, number];
	regions: Region[];
	/** Every `<script src>` a browser runs outside the head and the regions, in document order. */
	scripts: ScriptTag[];
	/** Text the parser reads as no tag (see `Markup.raw`): flat start/end pairs, in order. */
	raw: number[];
	/** The head's first script that runs after the page is parsed, or -1 (see `Markup.deferred`). */
	deferred: number;
}

/** Why a page with regions cannot answer a part. */
export interface PageRefusal {
	reason: "regions" | "response" | "inline-script" | "markup";
	detail: string;
}

/**
 * Find a page's head, regions and scripts, or say why it has none to offer.
 * Null when it has no region at all.
 *
 * Not a tree builder: one walk reads the page as a browser's tokenizer does
 * (`readMarkup`), noting the text that holds no tag (comments, raw text, tags
 * whose attribute values hold a `<`) and the markup that never runs
 * (template contents, svg and math). Then `indexOf` finds each occurrence
 * of the attribute, which is checked to be a real attribute of a real start
 * tag outside them, and one more pass counts the region's own tag name to
 * find its end. So a `</main>` inside a JSON-LD block, a comment, a style or
 * an attribute value never ends a region, and a `<script>` a browser would
 * never run (in a template, a noscript, an svg) is never listed. About
 * 0.08 ms for a 19 KB page, 0.25 ms for 72 KB and 0.9 ms for 282 KB
 * (bench/navigate.ts); a page without the attribute costs one `indexOf`.
 */
export function scanPage(html: string): PageScan | PageRefusal | null {
	if (html.indexOf(REGION_ATTRIBUTE) === -1) return null;
	const { raw, inert, unsure, head, deferred, templates } = readMarkup(html);
	const [headOpen, , headClose, headEnd] = head;
	if (headClose === -1) return { reason: "response", detail: "the page has no <head>…</head>" };

	const regions: Region[] = [];
	// The tag a hit sits in starts at the last `<` before it, or where the
	// raw range holding it starts (a tag whose values hold a `<`). That `<`
	// and the tag read there are kept until the next `<` (or the range's
	// end), so text that mentions the name a thousand times costs one walk
	// over it, not a walk back from each mention.
	let lt = -1;
	let after = 0;
	let tag: Tag | null = null;
	for (let hit = html.indexOf(REGION_ATTRIBUTE); hit !== -1; hit = html.indexOf(REGION_ATTRIBUTE, hit + REGION_ATTRIBUTE.length)) {
		// An attribute is preceded by whitespace and followed by `=`, `>`, `/`
		// or whitespace; text that merely mentions the name is not.
		if (!isSpace(html.charCodeAt(hit - 1)) || !isAttributeEnd(html.charCodeAt(hit + REGION_ATTRIBUTE.length))) continue;
		if (hit >= after) {
			const r = rangeAt(raw, hit);
			after = r !== -1 ? raw[r + 1]! : nextOrEnd(html, hit);
			lt = r !== -1 ? raw[r]! : tagAt(html, raw, hit);
			tag = lt === -1 ? null : readTag(html, lt);
		}
		if (!tag || tag.end <= hit || !tag.attributes.some((a) => a.at === hit && a.name === REGION_ATTRIBUTE)) continue;
		// In a template or an svg, the element is never one a swap can find.
		if (inside(inert, hit)) continue;

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
		const end = endOf(html, raw, inert, tag.name, tag.end);
		if (end === -1) return { reason: "regions", detail: `${label} has no end tag` };
		// A declarative shadow root is attached by the page's parser only; parsed
		// into a part, it stays an inert <template> and its content is gone.
		if (templates.some((at) => at > lt && at < end && readTag(html, at)?.attributes.some((a) => a.name === "shadowrootmode"))) {
			return { reason: "regions", detail: `region #${id} holds a declarative shadow root (<template shadowrootmode>), which a swap would leave inert` };
		}

		// A script parsed into a swapped region never runs, so a page whose
		// region needs one is loaded for real. A data block (JSON, JSON-LD) is
		// not a script that runs, and travels with its region.
		for (let i = firstAtOrAfter(raw, lt); i < raw.length && raw[i]! < end; i += 2) {
			if (!isScriptAt(html, raw[i]!)) continue;
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
	// Past the point where the walk cannot be sure it reads the page as a
	// browser does, it cannot say which scripts run, nor where a region ends.
	if (unsure < html.length && SCRIPT_TAG.test(html.slice(unsure))) {
		return {
			reason: "markup",
			detail: `a script comes after ${html.slice(unsure, tagNameEnd(html, unsure + 1))}> inside svg or math, which a browser may read as HTML; natsu cannot be sure which scripts it runs`,
		};
	}

	// The script list: every <script src> outside the head and the regions
	// that a browser runs. One in a template, an svg or a math element never
	// runs on a full load, so it must never run on a visit either.
	const scripts: ScriptTag[] = [];
	let region = 0;
	for (let i = 0; i < raw.length; i += 2) {
		const start = raw[i]!;
		if (start >= headOpen && start < headEnd) continue;
		while (region < regions.length && regions[region]!.end <= start) region++;
		if (region < regions.length && start >= regions[region]!.start) continue;
		if (!isScriptAt(html, start) || inside(inert, start)) continue;
		const tag = readTag(html, start);
		const src = tag?.get("src");
		if (!tag || src === undefined) continue;
		scripts.push({ start, end: raw[i + 1]!, attributes: tag.attributes, src, nonce: tag.get("nonce") });
	}

	return { head, regions, scripts, raw, deferred };
}

/**
 * What a swap leaves in place, as text: the head's scripts (a page-specific
 * one would never run after a swap, so a different one is a different
 * shell), then every byte outside the head and the regions less the script
 * list, with each region's id where it sits, nonces taken out. A different
 * text is a different shell.
 */
export function shellOf(html: string, scan: PageScan): string {
	const pieces: string[] = [];
	const [headOpen, headStart, headClose, headEnd] = scan.head;
	for (let i = firstAtOrAfter(scan.raw, headStart); i < scan.raw.length && scan.raw[i]! < headClose; i += 2) {
		const at = scan.raw[i]!;
		// A lazy stylesheet loader is page-specific (its chunk, its triggers),
		// and a swap needs none of it: the link's data-natsu-later says it.
		if (isScriptAt(html, at) && !html.startsWith(LAZY_LOADER_HEAD, tagEnd(html, at + 7))) pieces.push(html.slice(at, scan.raw[i + 1]!));
	}
	pieces.push("\0");
	const segments: number[] = [0, headOpen, headEnd];
	for (const region of scan.regions) segments.push(region.start, region.end);
	segments.push(html.length);
	let script = 0;
	for (let i = 0; i < segments.length; i += 2) {
		// Where each region sits: markup moved from one side of a region to
		// the other is a different shell, which a swap would leave misplaced.
		if (i >= 4) pieces.push(`\0${scan.regions[(i >> 1) - 2]!.id}\0`);
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
	return pieces.join("").replace(NONCE_ATTRIBUTE, "");
}

/** A part: the small document, and its script list for the `Natsu-Scripts` header. */
export interface Part {
	html: string;
	/** Space-separated, one URL-encoded attribute list per script; "" for none. */
	scripts: string;
}

/**
 * The part: a small document with the page's head less its scripts, the key
 * and the regions in order, all less their `<noscript>`s; the script list
 * goes in a header.
 *
 * Nothing in the part's markup ever becomes a script or gets the document's
 * nonce on the server's word alone, because a browser can read markup in a
 * page differently from this scanner (a stray end tag, foreign content), and
 * markup that slipped into a page must not ride along into trust:
 *
 * - The scripts travel in `Natsu-Scripts`, which only the server writes, and
 *   the runtime creates only those. Under a nonce CSP a script is listed
 *   with a `nonce` key (the runtime gives it the document's nonce) only if
 *   its nonce is this response's; one without is dropped when the CSP says
 *   `'strict-dynamic'` (a runtime-made script would run whatever its host,
 *   where the page's own would not) and listed without the key otherwise,
 *   so the CSP's host list decides, as on a full load. The runtime's own
 *   script is never listed.
 * - A nonce on anything in the head keeps its value when it is this
 *   response's and is dropped when not (bare ones too). The response's
 *   nonces go in `Natsu-Nonce`, and the runtime trusts only an element whose
 *   nonce is one of them: a value no markup can know in advance.
 */
export function partOf(
	html: string,
	scan: PageScan,
	key: string,
	nonces: readonly string[],
	runtime = "",
	strictDynamic = true,
): Part {
	const [, headStart, headClose] = scan.head;
	const raw = scan.raw;
	let head = "";
	let from = headStart;
	let r = firstAtOrAfter(raw, headStart);
	for (let lt = html.indexOf("<", headStart); lt !== -1 && lt < headClose; ) {
		while (r < raw.length && raw[r + 1]! <= lt) r += 2;
		const rawStart = r < raw.length && raw[r]! <= lt ? raw[r]! : -1;
		if (rawStart !== -1 && rawStart !== lt) {
			// Inside a comment or raw text: no tag here.
			lt = html.indexOf("<", raw[r + 1]!);
			continue;
		}
		if (rawStart === lt && (isScriptAt(html, lt) || isNoscriptAt(html, lt))) {
			head += html.slice(from, lt);
			from = raw[r + 1]!;
			lt = html.indexOf("<", from);
			continue;
		}
		const tag = isLetter(html.charCodeAt(lt + 1)) ? readTag(html, lt) : null;
		if (tag) {
			for (const attribute of tag.attributes) {
				if (attribute.name !== "nonce" || nonces.includes(attribute.value)) continue;
				let cut = attribute.at;
				while (cut > from && isSpace(html.charCodeAt(cut - 1))) cut--;
				head += html.slice(from, cut);
				from = attribute.end;
			}
		}
		lt = html.indexOf("<", rawStart === lt ? raw[r + 1]! : tag ? tag.end : lt + 1);
	}
	head += html.slice(from, headClose);
	// A <noscript> goes too: the runtime parses with scripting off, which reads
	// its content as markup (a `</div>` in it would close the region's own),
	// and with scripting on a browser never shows it anyway.
	let regions = "";
	for (const region of scan.regions) {
		let at = region.start;
		for (let i = firstAtOrAfter(raw, at); i < raw.length && raw[i]! < region.end; i += 2) {
			if (!isNoscriptAt(html, raw[i]!)) continue;
			regions += html.slice(at, raw[i]);
			at = Math.min(raw[i + 1]!, region.end);
		}
		regions += html.slice(at, region.end);
	}
	const scripts: string[] = [];
	for (const tag of scan.scripts) {
		if (runtime && tag.src === runtime) continue;
		const vouched = tag.nonce !== undefined && nonces.includes(tag.nonce);
		if (nonces.length > 0 && !vouched && strictDynamic) continue;
		const attributes = new URLSearchParams();
		for (const attribute of tag.attributes) {
			if (attribute.name !== "nonce") attributes.append(attribute.name, decodeEntities(attribute.value));
		}
		if (vouched && nonces.length > 0) attributes.append("nonce", "");
		scripts.push(attributes.toString());
	}
	return {
		html: `<!doctype html><html><head>${head}<meta name="natsu" content="${key}"></head><body>${regions}</body></html>`,
		scripts: scripts.join(" "),
	};
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

// --- reading markup as a browser does --------------------------------------------------

/** Elements whose content the tokenizer reads as text, not markup (`noscript`: scripts run); `plaintext` has no end. */
const RAW_TEXT = ["script", "style", "textarea", "title", "xmp", "iframe", "noembed", "noframes", "noscript", "plaintext"];
/** The start tags the walk acts on outside svg and math, by the length of their name. */
const WATCHED: string[][] = [];
for (const name of [...RAW_TEXT, "head", "body", "template", "svg", "math"]) (WATCHED[name.length] ??= []).push(name);
/** HTML start tags that close every open svg and math element (`font` too, with color, face or size). */
const BREAKOUT = new Set([
	"b", "big", "blockquote", "body", "br", "center", "code", "dd", "div", "dl", "dt", "em", "embed",
	"h1", "h2", "h3", "h4", "h5", "h6", "head", "hr", "i", "img", "li", "listing", "menu", "meta", "nobr",
	"ol", "p", "pre", "ruby", "s", "small", "span", "strong", "strike", "sub", "sup", "table", "tt", "u", "ul", "var",
]);
/**
 * Inside svg or math, the elements whose content a browser may read as HTML
 * (the integration points), and the names HTML reads as raw text: read the
 * same either way only while they hold nothing but text.
 */
const SWITCHES = new Set([...RAW_TEXT, "template", "foreignobject", "desc", "mi", "mo", "mn", "ms", "mtext", "annotation-xml"]);

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

/** What a browser makes of a page's markup, as far as a scan needs to know. */
interface Markup {
	/**
	 * Text the parser reads as no tag at all: comments (bogus ones too, like
	 * `<!doctype>`), CDATA in svg or math, raw-text elements whole (script,
	 * style, textarea, title, noscript…), and any tag whose attribute values
	 * hold a `<`. Flat start/end pairs, in order. A `<script` starts a range
	 * here exactly where the tokenizer starts a script element.
	 */
	raw: number[];
	/**
	 * Markup that is parsed but never runs: the contents of a `<template>`,
	 * and svg and math elements whole (a `<script src>` there loads nothing).
	 * Flat start/end pairs, in order.
	 */
	inert: number[];
	/**
	 * Where the walk stops being sure it reads the page as a browser builds
	 * it: inside svg or math, an element that switches back to HTML with
	 * markup in it (a `<foreignObject>`, a `<title>` holding tags), or an end
	 * tag for an element outside. The page's length when it never is.
	 */
	unsure: number;
	/** `<head`, past its `>`, `</head`, past its `>`; -1 for each not found. */
	head: [number, number, number, number];
	/**
	 * Where each `<template` start tag is, in order (a declarative shadow root
	 * is one), in svg and math too: one in a `foreignObject` is HTML.
	 */
	templates: number[];
	/**
	 * The head's first script that runs after the page is parsed (one with a
	 * `src`, or a module), or -1. An inline classic script runs where it
	 * stands, before any deferred one, so the runtime need not come before
	 * it (and a lazy stylesheet loader must stay right after its link).
	 */
	deferred: number;
}

/**
 * Walk a page as a browser's tokenizer reads it: one step from each `<` to
 * the next outside a tag, comment or raw text, so a `<` inside an attribute
 * value or a comment is never taken for a tag, and raw text ends where the
 * browser ends it (a script's `<!--<script>` escapes included). Template
 * contents and svg and math subtrees are tracked (as the tree builder
 * opens and closes them) but not built. `headOnly` stops at `</head>` or
 * `<body>`.
 */
function readMarkup(html: string, headOnly = false): Markup {
	const raw: number[] = [];
	const inert: number[] = [];
	const head: [number, number, number, number] = [-1, -1, -1, -1];
	const starts: number[] = [];
	let unsure = html.length;
	let deferred = -1;
	/** Open `<template>`s. */
	let templates = 0;
	/** Open svg and math elements, outermost first, by name. */
	const foreign: string[] = [];
	let inertFrom = -1;
	let lt = html.indexOf("<");
	walk: while (lt !== -1) {
		const c = html.charCodeAt(lt + 1);
		let end = lt + 1;
		if (c === 33 /* ! */ || c === 63 /* ? */) {
			if (c === 33 && html.startsWith("--", lt + 2)) end = commentEnd(html, lt);
			else if (c === 33 && foreign.length > 0 && html.startsWith("[CDATA[", lt + 2)) end = afterText(html, "]]>", lt + 9);
			else end = afterText(html, ">", lt + 2); // a bogus comment: <!doctype …>, <?xml …>, <![CDATA[ in HTML
			raw.push(lt, end);
		} else if (c === 47 /* / */) {
			const n = html.charCodeAt(lt + 2);
			if (n === 62) end = lt + 3; // `</>` is dropped
			else if (!isLetter(n)) {
				end = afterText(html, ">", lt + 2); // `</ …>` is a bogus comment
				raw.push(lt, end);
			} else {
				end = tagEnd(html, lt + 2);
				const nameEnd = tagNameEnds;
				if (end === -1) {
					raw.push(lt, html.length); // a tag the page ends inside is dropped, and all after it
					break;
				}
				if (holdsLt) raw.push(lt, end); // an attribute value holds a `<`
				const length = nameEnd - lt - 2;
				if (foreign.length > 0) {
					const name = html.slice(lt + 2, nameEnd).toLowerCase();
					// `</p>` and `</br>` are HTML and close every svg and math
					// element; any other end tag closes the nearest open one of
					// its name, or, with none, an element outside them.
					const breakout = name === "p" || name === "br";
					const open = breakout ? 0 : foreign.lastIndexOf(name);
					if (open === -1) unsure = Math.min(unsure, lt);
					else {
						foreign.length = open;
						if (open === 0 && templates === 0) inert.push(inertFrom, breakout ? lt : end);
					}
				} else if (length === 8 && templates > 0 && namedAt(html, lt + 2, "template")) {
					if (--templates === 0) inert.push(inertFrom, end);
				} else if (length === 4 && templates === 0 && head[0] !== -1 && head[2] === -1 && namedAt(html, lt + 2, "head")) {
					head[2] = lt;
					head[3] = end;
					if (headOnly) break;
				}
			}
		} else if (isLetter(c)) {
			end = tagEnd(html, lt + 1);
			const nameEnd = tagNameEnds;
			const closed = selfClosing;
			if (end === -1) {
				raw.push(lt, html.length);
				break;
			}
			let to = holdsLt ? end : -1; // an attribute value holds a `<`
			if (foreign.length > 0) {
				const name = html.slice(lt + 1, nameEnd).toLowerCase();
				if (BREAKOUT.has(name) || (name === "font" && readTag(html, lt)!.attributes.some((a) => a.name === "color" || a.name === "face" || a.name === "size"))) {
					// An HTML element: it closes every open svg and math element,
					// and is read again as HTML.
					foreign.length = 0;
					if (templates === 0) inert.push(inertFrom, lt);
					continue;
				}
				// Noted here too: in a foreignObject it is HTML, a declarative shadow root.
				if (name === "template") starts.push(lt);
				if (closed) {
					// `<path/>`: nothing opens.
				} else if (SWITCHES.has(name)) {
					const after = html.indexOf("<", end);
					if (after !== -1 && html.charCodeAt(after + 1) === 47 && namedAt(html, after + 2, name) && isTagEnd(html.charCodeAt(after + 2 + name.length))) {
						const close = tagEnd(html, after + 2 + name.length);
						end = to = close === -1 ? html.length : close;
					} else {
						unsure = Math.min(unsure, lt);
						foreign.push(name);
					}
				} else foreign.push(name);
			} else {
				const name = watchedAt(html, lt + 1, nameEnd - lt - 1);
				if (name === undefined) {
					// Most tags: nothing to do.
				} else if (name === "head") {
					if (templates === 0 && head[0] === -1) {
						head[0] = lt;
						head[1] = end;
					}
				} else if (name === "body") {
					if (headOnly && templates === 0) break;
				} else if (name === "template") {
					starts.push(lt);
					if (templates++ === 0) inertFrom = lt;
				} else if (name === "svg" || name === "math") {
					if (!closed) {
						if (templates === 0) inertFrom = lt;
						foreign.push(name);
					}
				} else {
					const close = rawEnd(html, name, end);
					end = to = close === -1 ? html.length : close;
					// A script the page ends inside is never run: the parser
					// marks it started and moves on.
					if (close === -1 && name === "script" && templates === 0) inert.push(lt, html.length);
					else if (name === "script" && deferred === -1 && templates === 0 && head[0] !== -1 && head[2] === -1 && isDeferredScriptAt(html, lt)) {
						deferred = lt;
						if (headOnly) break;
					}
				}
			}
			if (to !== -1) raw.push(lt, to);
		}
		lt = html.indexOf("<", end);
	}
	if (templates > 0 || foreign.length > 0) inert.push(inertFrom, html.length);
	return { raw, inert, unsure, head, deferred, templates: starts };
}

/** Which of the start tags the walk acts on (`WATCHED`) is named at `at`, `length` long, in any case. */
function watchedAt(html: string, at: number, length: number): string | undefined {
	const names = WATCHED[length];
	if (names === undefined) return undefined;
	for (const name of names) if (namedAt(html, at, name)) return name;
	return undefined;
}

function isDeferredScriptAt(html: string, at: number): boolean {
	const tag = readTag(html, at);
	return tag !== null && (tag.get("src") !== undefined || tag.get("type")?.trim().toLowerCase() === "module");
}

/** Past the first `text` at or after `from`; the page's length without one. */
function afterText(html: string, text: string, from: number): number {
	const at = html.indexOf(text, from);
	return at === -1 ? html.length : at + text.length;
}

/** Past the end of the comment opening at `lt`: `-->`, or `--!>` as browsers also read it; `<!-->` and `<!--->` are whole. */
function commentEnd(html: string, lt: number): number {
	if (html.startsWith(">", lt + 4)) return lt + 5;
	if (html.startsWith("->", lt + 4)) return lt + 6;
	for (let at = html.indexOf("--", lt + 4); at !== -1; at = html.indexOf("--", at + 1)) {
		if (html.charCodeAt(at + 2) === 62) return at + 3;
		if (html.startsWith("!>", at + 2)) return at + 4;
	}
	return html.length;
}

/** Whether the lower-case tag name `name` is spelled at `at`, in any case. */
function namedAt(html: string, at: number, name: string): boolean {
	for (let i = 0; i < name.length; i++) {
		if ((html.charCodeAt(at + i) | 32) !== name.charCodeAt(i)) return false;
	}
	return true;
}

/** Where a tag name that starts at `from` ends: at whitespace, `/` or `>`, as the tokenizer reads names. */
function tagNameEnd(html: string, from: number): number {
	let i = from;
	while (i < html.length && !isTagEnd(html.charCodeAt(i))) i++;
	return i;
}

/** Set by `tagEnd`: where the tag's name ends. */
let tagNameEnds = 0;
/** Set by `tagEnd`: whether the tag it read ends in `/>` (svg and math honour it). */
let selfClosing = false;
/** Set by `tagEnd`: whether the tag it read holds a `<` (in an attribute value or name). */
let holdsLt = false;

/**
 * Past the `>` that ends the tag whose name starts at `at` (or ends there),
 * as the tokenizer reads it: the name runs to whitespace, `/` or `>`; a
 * value quoted after `=` hides any `>` and `<` in it, and an `=` opens a
 * value only after an attribute's name (one at the start of a name is part
 * of it). -1 when the page ends first (a browser then drops the tag). One
 * pass over the tag's characters, which is quicker than jumping with
 * `indexOf`: values are short.
 */
function tagEnd(html: string, at: number): number {
	let i = at;
	while (i < html.length && !isTagEnd(html.charCodeAt(i))) i++;
	tagNameEnds = i;
	/** In an attribute's name, or after it: an `=` opens its value. */
	let named = false;
	let slash = false;
	let lt = false;
	for (; i < html.length; i++) {
		const c = html.charCodeAt(i);
		if (c === 62) {
			selfClosing = slash;
			holdsLt = lt;
			return i + 1;
		}
		slash = c === 47;
		if (slash) {
			named = false;
			continue;
		}
		if (c <= 32 && isSpace(c)) continue;
		if (c !== 61 || !named) {
			if (c === 60) lt = true;
			named = true; // an attribute's name, an `=` at its start included
			continue;
		}
		let j = i + 1;
		while (j < html.length && isSpace(html.charCodeAt(j))) j++;
		const quote = html.charCodeAt(j);
		named = false;
		if (quote === 34 || quote === 39) {
			for (j++; j < html.length; j++) {
				const v = html.charCodeAt(j);
				if (v === quote) break;
				if (v === 60) lt = true;
			}
			if (j >= html.length) return -1;
		} else {
			for (; j < html.length; j++) {
				const v = html.charCodeAt(j);
				if (v === 62 || (v <= 32 && isSpace(v))) break;
				if (v === 60) lt = true;
			}
			j--;
		}
		i = j;
	}
	return -1;
}

/** Past the end tag that ends the raw text of `name` begun at `from`; -1 when the page ends first. */
function rawEnd(html: string, name: string, from: number): number {
	if (name === "plaintext") return -1;
	let close = closeAt(html, name, from);
	if (name === "script" && close !== -1) {
		const escape = html.indexOf("<!--", from);
		if (escape !== -1 && escape < close) close = scriptCloseAt(html, from);
	}
	return close === -1 ? -1 : tagEnd(html, close + 2 + name.length);
}

/** The first `</name` end tag (any case) at or after `from`, or -1. */
function closeAt(html: string, name: string, from: number): number {
	for (let at = html.indexOf("</", from); at !== -1; at = html.indexOf("</", at + 2)) {
		if (namedAt(html, at + 2, name) && isTagEnd(html.charCodeAt(at + 2 + name.length))) return at;
	}
	return -1;
}

/**
 * The `</script` that ends a script's text, through the tokenizer's escape
 * states: after `<!--`, a `<script` makes the next `</script` only leave
 * that state, until `-->`. So `<!--<script>` in a data block runs the
 * block on past its own end tag, as a browser runs it. -1 for none.
 */
function scriptCloseAt(html: string, from: number): number {
	/** 0: script data; 1: escaped (after `<!--`); 2: double escaped (after `<!--<script`). */
	let state = 0;
	for (let at = from; ; ) {
		const lt = html.indexOf("<", at);
		if (state !== 0) {
			const dashes = html.indexOf("-->", at);
			if (dashes !== -1 && (lt === -1 || dashes < lt)) {
				state = 0;
				at = dashes + 3;
				continue;
			}
		}
		if (lt === -1) return -1;
		const end = html.charCodeAt(lt + 1) === 47 && namedAt(html, lt + 2, "script") && isTagEnd(html.charCodeAt(lt + 8));
		if (state === 0) {
			if (end) return lt;
			if (html.startsWith("!--", lt + 1)) {
				state = 1;
				at = lt + 2; // `<!-->` is over at once
				continue;
			}
		} else if (state === 1) {
			if (end) return lt;
			if (namedAt(html, lt + 1, "script") && isTagEnd(html.charCodeAt(lt + 7))) state = 2;
		} else if (end) state = 1;
		at = lt + 1;
	}
}

/** `<name` and `</name` followed by what may end a tag name, in any case, by name. */
const TAG_PATTERNS = new Map<string, RegExp>();

/**
 * Past the `>` of the end tag that closes the `name` element whose start tag
 * ends at `from`, counting the elements of the same name opened inside it
 * (outside raw text, templates and svg); -1 without one.
 */
function endOf(html: string, raw: number[], inert: number[], name: string, from: number): number {
	let pattern = TAG_PATTERNS.get(name);
	if (!pattern) {
		pattern = new RegExp(`</?${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=[\\t\\n\\f\\r />])`, "gi");
		if (TAG_PATTERNS.size < 64) TAG_PATTERNS.set(name, pattern);
	}
	pattern.lastIndex = from;
	let depth = 1;
	for (let match = pattern.exec(html); match !== null; match = pattern.exec(html)) {
		const at = match.index;
		if (inside(raw, at) || inside(inert, at)) continue;
		if (html.charCodeAt(at + 1) !== 47) {
			depth++;
			continue;
		}
		if (--depth === 0) return tagEnd(html, at + 2 + name.length);
	}
	return -1;
}

/** Whether `at` falls inside one of the ranges (a binary search: they are in order). */
function inside(ranges: number[], at: number): boolean {
	return rangeAt(ranges, at) !== -1;
}

/** Index (even) of the range that holds `at`, or -1. */
function rangeAt(ranges: number[], at: number): number {
	let lo = 0;
	let hi = (ranges.length >> 1) - 1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		if (at < ranges[mid * 2]!) hi = mid - 1;
		else if (at >= ranges[mid * 2 + 1]!) lo = mid + 1;
		else return mid * 2;
	}
	return -1;
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

/**
 * The `<` of the start tag that may hold `at` (an attribute there): where
 * the raw range holding it starts (a tag whose values hold a `<`), or the
 * last `<` before it; -1 when that `<` is in raw text, so `at` is in text.
 */
function tagAt(html: string, raw: number[], at: number): number {
	const r = rangeAt(raw, at);
	if (r !== -1) return raw[r]!;
	const lt = html.lastIndexOf("<", at);
	return lt === -1 || inside(raw, lt) ? -1 : lt;
}

/** The next `<` after `at`, or the page's length. */
function nextOrEnd(html: string, at: number): number {
	const next = html.indexOf("<", at);
	return next === -1 ? html.length : next;
}

interface Tag {
	name: string;
	/** Each attribute with where it starts and ends (past its value) in the page. */
	attributes: Array<{ name: string; value: string; at: number; end: number }>;
	/** Past the `>`. */
	end: number;
	get(name: string): string | undefined;
}

/**
 * Read the start tag at `lt`: its name and attributes as the HTML parser
 * splits them, quoted values included. Null if `lt` does not start one.
 */
function readTag(html: string, lt: number): Tag | null {
	if (html.charCodeAt(lt) !== 60 || !isLetter(html.charCodeAt(lt + 1))) return null;
	let i = tagNameEnd(html, lt + 1);
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
		attributes.push({ name: attribute, value, at, end: i });
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

/** Whether a `<script` start tag (in any case) begins at `at`. */
function isScriptAt(html: string, at: number): boolean {
	return html.charCodeAt(at) === 60 && html.slice(at + 1, at + 7).toLowerCase() === "script" && isTagEnd(html.charCodeAt(at + 7));
}

/** Whether a `<noscript` start tag (in any case) begins at `at`. */
function isNoscriptAt(html: string, at: number): boolean {
	return html.charCodeAt(at) === 60 && namedAt(html, at + 1, "noscript") && isTagEnd(html.charCodeAt(at + 9));
}

function isLetter(code: number): boolean {
	return (code >= 97 && code <= 122) || (code >= 65 && code <= 90);
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** An attribute value as the browser reads it: the character references a template writes, decoded. */
function decodeEntities(value: string): string {
	if (value.indexOf("&") === -1) return value;
	return value.replace(/&(?:#(\d+)|#x([\da-f]+)|(amp|lt|gt|quot|apos));?/gi, (match, dec?: string, hex?: string, name?: string) => {
		if (name) return ENTITIES[name.toLowerCase()] ?? match;
		const code = dec ? Number(dec) : Number.parseInt(hex!, 16);
		return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
	});
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
