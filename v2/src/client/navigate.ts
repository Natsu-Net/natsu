/// <reference lib="dom" />
/**
 * The browser half of natsu's page switching: a click on a link to another
 * page of the same site swaps only the parts of the page that change.
 *
 * The server sends HTML, never data to render. A page marks the elements
 * that change from page to page with `data-natsu-region` (each with an
 * `id`); everything else is the shell (header, banner, dialogs) and stays.
 * On a click this runtime asks for the next page with a `Natsu-Nav` header,
 * and the server answers with only that page's head, its regions and its
 * script list. The runtime merges the head, swaps the regions, and starts
 * any script this document has not run yet. Anything it cannot prove safe
 * becomes a real browser load, so a wrong guess costs speed, never
 * correctness.
 *
 * The server injects it, with the document key, before `</head>` of every
 * page that has a region:
 *
 *   <meta name="natsu" content="<doc>.<shell>">
 *   <script src="/_a/natsu-navigate.<hash>.js" nonce="…" defer></script>
 *
 * **What a page script writes.** One function, `natsu.mount`:
 *
 *   natsu.mount("[data-clock]", (el, signal) => {
 *     const timer = setInterval(() => tick(el), 1000);
 *     el.addEventListener("click", onClick, { signal });
 *     return () => clearInterval(timer);
 *   });
 *
 * It runs the function now on every match, and later on every match inside
 * a region swapped in, but only while the page shown lists the script that
 * registered it (two pages' scripts may share a selector). Swapping a region
 * out aborts `signal` and calls what the function returned. Elements in the
 * shell are mounted once. A script that calls `mount` while it runs is
 * swap-safe. Any other script this document ran (unless its tag says
 * `data-natsu-once`) makes every later visit a real load, so an unconverted
 * page behaves exactly as before and no listener ever stacks. Scripts that
 * call `mount` must run after this one: `defer`, as Assets emits them.
 *
 * **The wire format.** The request is a GET carrying
 * `Natsu-Nav: <doc>.<shell>` (and `Natsu-Prefetch: 1` for a hover). The
 * answers:
 *
 *  - a **part**: the page's own status, `Natsu-Part: 1`, and a small HTML
 *    document: the page's head (no scripts; a nonce the server vouched for
 *    written `nonce=""`, as the browser shows it on a live element), its
 *    regions in order, then its `<script src>` list;
 *  - `204` with `Natsu-Location: <url>`: the page redirected (a path for a
 *    target on this site); a same-origin target is visited (five hops at
 *    most), any other is a real load;
 *  - `204` with `Natsu-Reload: <reason>`: load this page for real;
 *  - `204` with `Natsu-Prefetch: skip`: a hover was refused (a click still
 *    swaps).
 *
 * **The swap**, step by step:
 *
 *  1. The part is parsed with `DOMParser`, and every `<noscript>` in it is
 *     removed: a parser with scripting off reads their content as markup, so
 *     `<noscript><style>` would otherwise become a live style.
 *  2. Its region ids must equal the current ones, in order.
 *  3. Its stylesheets go in before the current ones and must load first
 *     (four seconds at most; one the memory cache had, readable as it goes
 *     in, counts as loaded then). Every page's sheet is a slice of the same
 *     source in source order, so the old sheet, later in the cascade, keeps
 *     the old markup exactly as it was while the new one loads. A lazy half
 *     (`data-natsu-later`) loads too. There is no font step: in Chromium a
 *     face the new sheet declares again comes from the memory cache as the
 *     old sheet goes, so text does not flash in a fallback, and when the
 *     font cannot be cached, loading the new face early does not help,
 *     because removing the old sheet makes the browser build its faces
 *     afresh (tests/navigate.e2e.ts).
 *  4. In one synchronous step (inside a view transition only when
 *     `<html data-natsu-transition>` opts in): `natsu:before-swap`, history,
 *     the head merged by `outerHTML` (only what the server sent: scripts,
 *     nodes a third party added and `<html>` attributes are never touched;
 *     a new element with `nonce=""` gets the boot nonce, so a page's own
 *     inline `<style>` applies under a nonce `style-src`),
 *     the old stylesheets out, each region unmounted and replaced, scroll,
 *     focus, and the title read out through a `role=status` element.
 *  5. The mounts already registered run on the new regions. The listed
 *     scripts this document has not run are created with the boot nonce
 *     (which `'strict-dynamic'` does not need, and a bare nonce policy does)
 *     and `async = false`, so they run in order and their `mount` calls bind
 *     as they run; once they have loaded, `natsu:load` bubbles from each
 *     region.
 *
 * **Scroll** is kept per history entry, keyed by the entry the page on
 * screen belongs to, never by whatever `history.state` says at the moment:
 * a scroll during a back/forward fetch still belongs to the page being left.
 *
 * **The API**, on `window.natsu`:
 *
 *  - `mount(selector, (el, signal) => cleanup?)`
 *  - `visit(url, { history?: "push" | "replace" | "none", scroll?: "top" | "keep" | y })`
 *  - `refresh()`: this page again, scroll and focus kept (after an action)
 *  - `prefetch(url)`, and `island(el)` to fetch an island again
 *  - events on `document`: `natsu:visit` (cancelable), `natsu:before-swap`,
 *    and `natsu:load`, which bubbles from each new region (from `<body>`
 *    once at boot)
 *  - attributes: `data-natsu-reload` on a link, form or ancestor for a real
 *    load (`="false"` turns it back off inside), `data-natsu-prefetch="off"`,
 *    `data-natsu-once` on a script, `data-natsu-island="<url>"` on an
 *    element whose content comes from that URL after load, and
 *    `<html data-natsu-transition>`. `html[data-natsu-loading]` is set
 *    when a visit takes longer than 300 ms.
 *
 * With no key, no region, or a browser without `DOMParser` or `pushState`,
 * the runtime stays inert: `mount` still works and `visit` is
 * `location.assign`.
 *
 * Built as a classic script. `define: { NATSU_DEV: "true" }` gives the
 * development build, which says in the console why each visit became a
 * real load; any other build leaves those lines out.
 */

declare global {
	interface Window {
		natsu: NatsuClient;
	}
	interface NatsuVisitOptions {
		/** "push" (default), "replace" this entry, or "none" (back/forward). */
		history?: "push" | "replace" | "none";
		/** "top", "keep" (no scroll, no focus move), or a y to scroll to. By default: the hash target, else the top. */
		scroll?: "top" | "keep" | number;
	}
	interface NatsuClient {
		mount(selector: string, fn: (el: Element, signal: AbortSignal) => void | (() => void)): void;
		visit(url: string | URL, options?: NatsuVisitOptions): Promise<void>;
		refresh(): Promise<void>;
		prefetch(url: string | URL): void;
		island(el: Element): Promise<void>;
	}
}


declare const NATSU_DEV: boolean | undefined;
const DEV = typeof NATSU_DEV != "undefined" && NATSU_DEV;
const why = (...a: unknown[]) => console.info("natsu: real load,", ...a);

/** A registration: selector, function, and the src of the script that made it ("" = everywhere). */
type Reg = [string, (el: Element, signal: AbortSignal) => unknown, string];
/** An element and the registrations already mounted on it. */
type Mounted = Element & { natsu?: Set<Reg> };
type Opts = NatsuVisitOptions & { hops?: number };
type Answer = [Response, string];

const D = document;
const H = D.documentElement;
const L = location;
const HI = history;
const me = D.currentScript as HTMLScriptElement | null;
const NONCE = me?.nonce ?? "";
const KEY = D.querySelector<HTMLMetaElement>('meta[name="natsu"]')?.content;
const REGION = "[data-natsu-region][id]";
const LOADING = "data-natsu-loading";
const SHEET = "link[rel=stylesheet]";
const LATER = "data-natsu-later";
const PASSIVE = { passive: true };

const regs: Reg[] = [];
/** Live mounts: the element, and what stops it (abort the signal, run the cleanup). */
let live: [Element, () => void][] = [];
/** Scripts that called `mount` while they ran. */
const aware = new Set<string>();
/** Srcs whose mounts may run on the page shown. Unset at boot: all of them. */
let list: Set<string> | undefined;
let ready = false;

const on = (type: string, fn: (e: never) => unknown, options?: AddEventListenerOptions) =>
	addEventListener(type, fn as EventListener, options);
const fire = (name: string, target: EventTarget, detail?: unknown) =>
	target.dispatchEvent(new CustomEvent("natsu:" + name, { bubbles: true, cancelable: true, detail }));

const mountIn = (root: Element, only?: Reg) => {
	for (const r of only ? [only] : regs)
		if (!r[2] || !list || list.has(r[2]))
			for (const el of [root, ...root.querySelectorAll(r[0])] as Mounted[]) {
				const done = (el.natsu ||= new Set());
				if (!el.matches(r[0]) || done.has(r)) continue;
				done.add(r);
				const a = new AbortController();
				let cleanup: unknown;
				try {
					cleanup = r[1](el, a.signal);
				} catch (e) {
					reportError(e);
				}
				live.push([el, () => (a.abort(), typeof cleanup == "function" && cleanup())]);
			}
};

/** Stop the mounts inside `root`, and on it unless `inner`. */
const unmount = (root: Element, inner?: 1) =>
	(live = live.filter(([el, stop]) => {
		if (!root.contains(el) || (inner && el == root)) return 1;
		try {
			stop();
		} catch (e) {
			reportError(e);
		}
	}));

const island = async (el: Element, signal?: AbortSignal) => {
	// Only this site, and only an answer from a route that says it is an
	// island: markup that slipped into a page must not pull in another
	// origin's HTML, nor a whole page of this one.
	const u = new URL(el.getAttribute("data-natsu-island")!, L.href);
	if (u.origin != L.origin) return;
	const r = await fetch(u, { signal, headers: { "Natsu-Island": "1" } });
	const html =
		r.status == 200 && /^text\/html/.test(r.headers.get("content-type")!) && r.headers.get("natsu-island") == "1" && (await r.text());
	if (html !== false && el.isConnected) {
		unmount(el, 1);
		el.innerHTML = html;
		mountIn(el);
	}
};
// Built in, so it is tagged with no script and runs everywhere.
regs.push(["[data-natsu-island]", (el, signal) => island(el, signal).catch(() => {}), ""]);

const api: NatsuClient = (window.natsu = {
	mount(selector, fn) {
		const s = D.currentScript as HTMLScriptElement | null;
		if (s?.src) aware.add(s.src);
		// A script in <head> runs once per document, as the shell does: its mounts go everywhere.
		const r: Reg = [selector, fn, s && s.parentNode != D.head ? s.src : ""];
		regs.push(r);
		if (ready) mountIn(D.body, r);
	},
	visit: async (url) => L.assign(url),
	refresh: async () => L.reload(),
	prefetch() {},
	island,
});

/** Every script this document ran or started. */
const loaded = new Set([...D.scripts].map((s) => s.src));
/** The ones that must have called `mount` for a swap to be safe. */
let listed: string[] = [];
let status: HTMLElement | undefined;

const boot = () => {
	if (ready) return;
	ready = true;
	for (const s of D.body.querySelectorAll("script[src]") as NodeListOf<HTMLScriptElement>)
		if (s != me && !s.hasAttribute("data-natsu-once")) listed.push(s.src);
	if (status) D.body.append(status);
	mountIn(D.body);
	fire("load", D.body);
};
if (D.readyState == "complete") boot();
else {
	D.addEventListener("DOMContentLoaded", boot);
	on("load", boot);
}

if (KEY && D.querySelector(REGION) && window.DOMParser && HI.pushState) {
	status = D.createElement("p");
	status.setAttribute("role", "status");
	status.style.cssText = "position:fixed;clip-path:inset(50%)";
	if (ready) D.body.append(status);

	/** Head elements the server sent: the only ones a merge may remove. */
	const owned = new Set([...D.head.children].filter((e) => e.localName != "script"));
	const unsafe = () => {
		const bad = listed.filter((s) => !aware.has(s));
		if (DEV && (!ready || bad[0])) why(ready ? "these scripts never called natsu.mount:" : "before DOMContentLoaded", bad);
		return !ready || bad.length > 0;
	};
	const bare = (u: URL | Location) => u.href.split("#")[0]!;
	const here = () => L.pathname + L.search;
	/** The element a URL's hash names. */
	const anchor = (u: URL | Location) => {
		try {
			return D.getElementById(decodeURIComponent(u.hash.slice(1)));
		} catch {}
	};

	// --- history --------------------------------------------------------
	/** Ours in an entry's state: its id, the page it shows, its scroll when left. */
	const st = (): { id: number; p?: number; y?: number } | undefined => HI.state?.natsu;
	let id = Date.now();
	/** The history entry on screen: a swap or a same-page popstate changes it. */
	let cur = st()?.id ?? ++id;
	/**
	 * The page on screen, numbered. Every entry made from it carries the
	 * number (a hash link's, one a script rewrote with its state kept), so a
	 * popstate between two of them is a scroll, whatever the URL says.
	 */
	let page = ++id;
	/** Its path and query, for an entry with no state of ours. */
	let rendered = here();
	/** The entry a same-page hash link is leaving, until its popstate: the jump's scroll is not its own. */
	let frozen: number | undefined;
	const ys = new Map<number, number>();
	const put = (y?: number, url?: string) => HI.replaceState({ ...HI.state, natsu: { id: cur, p: page, y } }, "", url);
	// The browser restores scroll, on a reload too, until a swap makes the
	// entries manual. A reload keeps that, and leaves the scroll to us: now,
	// and again at load (images, fonts) unless the visitor scrolled meanwhile.
	const y0 = st()?.y;
	put(y0);
	if (y0 && HI.scrollRestoration == "manual") {
		scrollTo(0, y0);
		const at = scrollY;
		on("load", () => scrollY == at && scrollTo(0, y0));
	}
	on("scroll", () => cur != frozen && ys.set(cur, scrollY), PASSIVE);
	on("pagehide", () => {
		if ((st()?.id ?? cur) == cur) put(scrollY);
		cache.clear();
	});
	// Back from the back/forward cache after a visit became a real load: no
	// longer loading, and a loading timer frozen with the page must not fire.
	on("pageshow", (e: PageTransitionEvent) => e.persisted && idle());
	on("popstate", () => {
		const s = st();
		const y = s && (ys.get(s.id) ?? s.y);
		const same = s ? s.p == page : frozen != null || here() == rendered;
		// Whatever was on its way is over: this entry is what shows now.
		++seq;
		idle();
		frozen = undefined;
		if (!same) return visit(L.href, { history: "none", scroll: y });
		// The same page (a hash link's entry, or one made from this page): the
		// scroll the entry had, else its hash target, else where it is.
		if (s) cur = s.id;
		else (cur = ++id), put();
		y != null ? scrollTo(0, y) : anchor(L)?.scrollIntoView();
	});

	// --- which clicks and forms -----------------------------------------
	const ok = (el: Element, u: URL) =>
		u.origin == L.origin &&
		(el.closest("[data-natsu-reload]")?.getAttribute("data-natsu-reload") ?? "false") == "false" &&
		!/\.(?!html?$)\w+$/i.test(u.pathname);
	const link = (e: Event, click?: 1) => {
		const a = (e.target as Element).closest?.("a[href]");
		if (!(a instanceof HTMLAnchorElement) || (a.target && a.target != "_self") || a.hasAttribute("download")) return;
		const u = new URL(a.href);
		// The same page with a hash is the browser's own jump to an anchor, and
		// the scroll it makes belongs to the entry it pushes: the one left keeps
		// where it is now.
		if (bare(u) == bare(L) && u.href.includes("#")) {
			if (click) ys.set((frozen = cur), scrollY);
			return;
		}
		return ok(a, u) ? a : undefined;
	};
	// On window, bubbling: after every listener on the document, so one that
	// called preventDefault always wins.
	on("click", (e: MouseEvent) => {
		const a = !e.defaultPrevented && !e.button && !(e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) && link(e, 1);
		if (a) {
			e.preventDefault();
			visit(a.href);
		}
	});
	on("submit", (e: SubmitEvent) => {
		cache.clear();
		const form = e.target as HTMLFormElement;
		const by = e.submitter;
		const attr = (n: string) => by?.getAttribute("form" + n) ?? form.getAttribute(n);
		const target = attr("target");
		if (e.defaultPrevented || (attr("method") || "get").toLowerCase() != "get" || (target && target != "_self")) return;
		const u = new URL(attr("action") || "", D.baseURI);
		if (!ok(form, u) || (by && !ok(by, u))) return;
		u.search = new URLSearchParams(new FormData(form, by) as unknown as string[][]).toString();
		e.preventDefault();
		visit(u);
	});

	// --- prefetch -------------------------------------------------------
	const cache = new Map<string, { t: number; p: Promise<Answer | undefined> }>();
	let flying = 0;
	const get = (u: URL, pre?: 1) =>
		fetch(bare(u), { headers: { "Natsu-Nav": KEY!, ...(pre && { "Natsu-Prefetch": "1" }) } }).then(
			async (r): Promise<Answer> => [r, await r.text()],
		);
	/** A cached answer young enough to use, taken out of the cache. */
	const fresh = (k: string) => {
		const hit = cache.get(k);
		cache.delete(k);
		return hit && Date.now() - hit.t < 1e4 ? hit : undefined;
	};
	const prefetch = (url: string | URL) => {
		const u = new URL(url, L.href);
		const k = bare(u);
		const hit = fresh(k);
		const c = (navigator as { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
		if (hit) return void cache.set(k, hit); // now the most recently used
		if (unsafe() || c?.saveData || /2g/.test(c?.effectiveType!) || flying > 1 || k == bare(L) || u.origin != L.origin) return;
		flying++;
		const drop = (): undefined => void cache.delete(k);
		cache.set(k, {
			t: Date.now(),
			p: get(u, 1)
				.then((a) => (a[0].status == 200 && a[0].headers.has("natsu-part") ? a : drop()), drop)
				.finally(() => flying--),
		});
		if (cache.size > 5) cache.delete(cache.keys().next().value!);
	};
	let over: Element | undefined;
	let dwell: ReturnType<typeof setTimeout>;
	const intent = (e: Event, wait: number) => {
		const a = link(e);
		if (!a || a == over) return;
		over = a;
		clearTimeout(dwell);
		dwell = setTimeout(() => a.closest("[data-natsu-prefetch=off]") || prefetch(a.href), wait);
	};
	on("pointerover", (e: PointerEvent) => e.pointerType != "touch" && intent(e, 65), PASSIVE);
	on("pointerout", (e: PointerEvent) => {
		if (over && !over.contains(e.relatedTarget as Node)) {
			clearTimeout(dwell);
			over = undefined;
		}
	});
	on("touchstart", (e: TouchEvent) => intent(e, 0), PASSIVE);

	// --- visit ----------------------------------------------------------
	let seq = 0;
	let timer: ReturnType<typeof setTimeout>;
	/** No visit under way: no loading mark, and no timer to set one. */
	const idle = () => (clearTimeout(timer), H.removeAttribute(LOADING));
	/**
	 * A real navigation, which nothing intercepts: the answer to anything
	 * unsure. Not loading any more: one that never leaves the page (a
	 * download, a 204) must not leave the mark on it.
	 */
	const full = (u: URL, h?: string) => (idle(), h == "none" ? L.reload() : L[h == "replace" ? "replace" : "assign"](u.href));
	const regions = (doc: Document) => [...doc.querySelectorAll(REGION)];
	const ids = (els: Element[]) => els.map((e) => e.id).join(" ");
	const sheets = (doc: Document) => [...doc.head.querySelectorAll<HTMLLinkElement>(SHEET)];
	const href = (l: Element) => l.getAttribute("href");

	const visit = async (url: string | URL, o: Opts = {}): Promise<void> => {
		const u = new URL(url, L.href);
		let h = o.history;
		if (!fire("visit", D, { url: u.href }) && h != "none") return;
		if (unsafe() || u.origin != L.origin) return full(u, h);
		// The page already shown: the browser too replaces rather than pushes.
		if (!h && u.href == L.href) h = "replace";
		const n = ++seq;
		// A hover's pending prefetch would only fetch the same page twice; and
		// the link it holds may be in a region about to go, which it would keep.
		clearTimeout(dwell);
		over = undefined;
		clearTimeout(timer);
		timer = setTimeout(() => H.setAttribute(LOADING, ""), 300);
		let a: Answer | undefined;
		try {
			a = (o.scroll != "keep" && (await fresh(bare(u))?.p)) || (await get(u));
		} catch {}
		if (n != seq) return;
		if (!a) {
			if (DEV) why("network error", u.href);
			return full(u, h);
		}
		const [r, text] = a;
		const to = r.headers.get("natsu-location");
		if (to) {
			const v = new URL(to, u);
			v.hash ||= u.hash;
			const next: Opts = { ...o, history: h == "none" ? "replace" : h, hops: (o.hops ?? 0) + 1 };
			if (v.origin == L.origin && next.hops! < 6) return visit(v, next);
			if (DEV) why("redirect to", v.href);
			return full(v, next.history);
		}
		if (!r.headers.has("natsu-part")) {
			if (DEV) why(r.headers.get("natsu-reload") ?? "not a part", u.href);
			return full(u, h);
		}
		// Anything that throws before the swap (DOMParser under Trusted Types, a
		// header it cannot read) is a real load, never a click that did nothing.
		let begun: unknown;
		try {
			const f = new URL(r.url || u);
			f.hash = u.hash;
			const doc = new DOMParser().parseFromString(text, "text/html");
			// Read with scripting off, their content is markup: a <noscript><style> would apply.
			for (const e of doc.querySelectorAll("noscript")) e.remove();
			// A nonce in the part's head is the real one, and Natsu-Nonce lists the
			// ones the server vouched for. Those read "" (as a live element shows its
			// hidden nonce, so the merge sees an unchanged one as unchanged) and get
			// the boot nonce if they go in; any other nonce goes.
			const vouched = (r.headers.get("natsu-nonce") || "").split(" ");
			const trusted = new Set<Element>();
			for (const e of doc.head.querySelectorAll("[nonce]")) {
				const v = e.getAttribute("nonce");
				if (v && vouched.includes(v)) e.setAttribute("nonce", ""), trusted.add(e);
				else e.removeAttribute("nonce");
			}
			// The page's scripts come from Natsu-Scripts, never from markup: each
			// entry is one tag's attributes, its src made absolute against the part.
			const scripts = (r.headers.get("natsu-scripts") || "")
				.split(" ")
				.map((e) => new URLSearchParams(e))
				.filter((p) => p.has("src"))
				.map((p) => [new URL(p.get("src")!, f).href, p] as const);
			const now = regions(D);
			const next = regions(doc);
			// DOMParser leaves a declarative shadow root an inert <template>; a real load attaches it.
			const shadow = doc.querySelector(REGION + " template[shadowrootmode]");
			if (ids(now) != ids(next) || shadow) {
				if (DEV) why(...(shadow ? ["a declarative shadow root in a region:", shadow] : ["regions differ:", ids(now), "->", ids(next)]));
				return full(u, h);
			}

			// Where the page is, read now: once the new sheets are in, reading it
			// costs a style pass over the whole page. Every scroll after keeps it.
			ys.set(cur, scrollY);
			// Stylesheets go in ahead of the current ones, which keep the page on
			// screen styled as it is, and must load before anything moves.
			const want = sheets(doc);
			const old = sheets(D).filter((l) => owned.has(l));
			const adds: HTMLLinkElement[] = [];
			for (const l of want)
				if (!old.some((o) => href(o) == href(l)))
					for (const x of [href(l), l.getAttribute(LATER)])
						if (x) {
							const c = D.importNode(l);
							c.setAttribute("href", x);
							if (trusted.has(l)) c.nonce = NONCE;
							adds.push(c);
						}
			let fine: unknown = 1;
			if (adds[0])
				fine = await new Promise((y) => {
					let left = adds.length;
					// Settled (every load, an error, or four seconds, a failure too): the
					// handlers and the timer go, or they would keep this whole visit
					// alive on links that stay, chained to the next visit's.
					const end = (ok?: unknown) => {
						clearTimeout(t);
						for (const l of adds) l.onload = l.onerror = null;
						y(ok);
					};
					const t = setTimeout(end, 4e3);
					const done = (l: HTMLLinkElement) => l.onload && ((l.onload = null), --left || end(1));
					// The handlers go on before the links go in: a cached sheet may load at once.
					for (const l of adds) (l.onload = () => done(l)), (l.onerror = () => end(0));
					old[0] ? old[0].before(...adds) : D.head.append(...adds);
					// A sheet the memory cache held is parsed as it goes in, but its load
					// event can wait for the next frame: rules that can be read (never
					// while loading, nor across origins) are a loaded sheet, a frame early.
					for (const l of adds)
						try {
							if (l.sheet!.cssRules) done(l);
						} catch {}
				});
			if (n != seq || !fine) {
				for (const l of adds) l.remove();
				if (DEV && n == seq) why("a stylesheet did not load", u.href);
				return n == seq ? full(u, h) : undefined;
			}
			/** Sheets that stay, by the href the server wrote: the new page's and their lazy halves. */
			const keep = want.flatMap((l) => [href(l), l.getAttribute(LATER)]);

			const swap = () => {
				// Overtaken during the view transition's first frame (another visit,
				// a Back): this one is over, and leaves nothing behind.
				if (n != seq) return adds.forEach((l) => l.remove());
				begun = 1;
				fire("before-swap", D, { url: f.href });
				// From here the runtime restores this document's scroll, so the
				// browser must not: on the entry left, and on the entries after it.
				HI.scrollRestoration = "manual";
				// The entry left keeps its scroll and its page; the one shown gets a new page.
				if (!h) put(ys.get(cur));
				page = ++id;
				if (h) {
					// An entry reached by back/forward keeps its id; one with no state
					// of ours (a script wrote it) is given one.
					if (h == "none") cur = st()?.id ?? ++id;
					put(undefined, f.href);
				} else HI.pushState({ natsu: { id: (cur = ++id), p: page } }, "", f.href);
				rendered = here();
				// The head: what is in both stays, what went away goes, what is new comes in.
				const incoming = new Map<string, Element>();
				for (const e of doc.head.children) if (e.localName != "script" && !e.matches(SHEET)) incoming.set(e.outerHTML, e);
				for (const e of owned) {
					if (e.matches(SHEET) ? keep.includes(href(e)) : incoming.delete(e.outerHTML)) continue;
					// A lazy half that the page's own loader linked goes with its sheet.
					const later = e.getAttribute(LATER);
					if (later) D.head.querySelector(`link[href="${later}"]`)?.remove();
					e.remove();
					owned.delete(e);
				}
				for (const e of [...adds, ...incoming.values()]) {
					owned.add(e);
					// The CSP takes only the boot nonce, and only on what the server vouched for.
					if (trusted.has(e)) (e as HTMLElement).nonce = NONCE;
				}
				D.head.append(...incoming.values());
				// Focus inside a region going out: refresh() gives it back to its namesake.
				const was = D.activeElement;
				const fid = now.some((el) => el.contains(was)) && was!.id;
				now.forEach((el, i) => {
					unmount(el);
					el.replaceWith(next[i]!);
				});
				const s = o.scroll;
				if (s == "keep") fid && D.getElementById(fid)?.focus({ preventScroll: true });
				else {
					const t = anchor(f);
					// A y (back/forward), else the hash target, else the top.
					if (t && s == null) t.scrollIntoView();
					else scrollTo(0, +s! || 0);
					const pick = (sel: string) => next.map((e) => e.querySelector<HTMLElement>(sel)).find((e) => e);
					const auto = pick("[autofocus]");
					const el = auto || pick("h1") || (next[0] as HTMLElement);
					if (!auto && !el.hasAttribute("tabindex")) el.tabIndex = -1;
					el.focus({ preventScroll: true });
					status!.textContent = D.title;
				}
			};
			if (
				H.hasAttribute("data-natsu-transition") &&
				D.startViewTransition &&
				D.visibilityState == "visible" &&
				!matchMedia("(prefers-reduced-motion: reduce)").matches
			)
				await D.startViewTransition(swap).updateCallbackDone;
			else swap();
			if (n != seq) return;
			idle();

			// Mounts allowed here, then the scripts this document has not run, in order.
			list = new Set(scripts.map((s) => s[0]));
			for (const el of next) mountIn(el);
			await Promise.all(
				scripts.map(
					([src, p]) =>
						loaded.has(src) ||
						new Promise((y) => {
							const c = D.createElement("script");
							p.forEach((v, k) => k != "nonce" && c.setAttribute(k, v));
							c.async = false;
							// One the server vouched for gets the boot nonce; any other is left
							// to the page's CSP, exactly as on a full load.
							if (p.has("nonce")) c.nonce = NONCE;
							loaded.add(src);
							if (!p.has("data-natsu-once")) listed.push(src);
							c.onload = c.onerror = y;
							D.body.append(c);
						}),
				),
			);
			for (const el of next) fire("load", el);
		} catch (e) {
			if (begun) throw e;
			if (DEV) why("the part could not be read:", e);
			full(u, h);
		}
	};

	api.visit = visit;
	api.refresh = () => visit(L.href, { history: "replace", scroll: "keep" });
	api.prefetch = prefetch;
}
