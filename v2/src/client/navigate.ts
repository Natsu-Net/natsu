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
 * The server puts the runtime's tag in every page with a head, before the
 * head's first deferred script (so every script that calls `mount` runs
 * after it), and the document key in every page with a region:
 *
 *   <meta name="natsu" content="<doc>.<shell>">
 *   <script src="/_a/natsu-navigate.<hash>.js" nonce="…" defer></script>
 *
 * A page without the key (no region) never swaps; `mount` and islands still
 * work there. A second copy of the runtime on a page stays out.
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
 * out aborts `signal` and calls what the function returned, for an element
 * page code moved out of it too (a portal to `<body>`); so does any later
 * swap for an element page code took out of the document. Elements in the
 * shell are mounted once, and stopped when a page that does not list the
 * script is shown.
 *
 * **Which scripts allow a swap.** Every script this document runs counts:
 * inline, module, `defer` or `async`, in the head or the body, the ones a
 * swap appends, and one a loader adds at any time (the document's scripts
 * are read as the runtime runs, at DOMContentLoaded, as each visit starts
 * and after the new regions' mounts, so one that takes its tag out still
 * counts). It is swap-safe once it has called
 * `mount`, at any time (the script is `document.currentScript`, or for a
 * module or a call made later the one the stack names). Any other makes
 * every later visit a real load, so an unconverted page behaves exactly as
 * before and no listener ever stacks; and one a swap created that has not
 * called `mount` once it has run gets its page loaded for real, since it may
 * be waiting for a `DOMContentLoaded` that never comes again. One a swap
 * created counts once it has run: a visit that starts while it still loads
 * (Back, pressed at once) stays a swap, and one to a page that lists it
 * waits for it. Left out: this
 * runtime, a tag with `data-natsu-once`, data blocks, `nomodule` and any
 * other type the browser does not run, and a classic head script that
 * blocks the parser. A head script runs once per document, as the shell
 * does, and its mounts apply on every page, whatever the page lists; so do
 * those of a script a loader created, which no page lists. A
 * script that calls `mount` must run after this one: `defer`, as Assets
 * emits them.
 *
 * **Which clicks.** A plain left click on a link to this site, and the
 * submit of a GET form. Left to the browser: a click with a modifier (on a
 * submit button too: it opens a tab or a window), a target other than
 * `_self` (the element's own, else the first `<base target>`), `download`, a file
 * (an extension other than `.html`), a link inside an editor
 * (`contenteditable`), `data-natsu-reload`, and a form whose
 * `accept-charset` is not UTF-8. A link to the page shown with a hash is
 * the browser's own jump. A form with no action goes to the page's own
 * URL, and one with no field to send to `action?`. While a Back or Forward
 * to another page is on its way, a link or form is read against the page
 * still on screen (and its `<base href>`).
 *
 * **The wire format.** The request is a GET carrying
 * `Natsu-Nav: <doc>.<shell>` (and `Natsu-Prefetch: 1` for a hover). The
 * answers:
 *
 *  - a **part**: the page's own status, `Natsu-Part: 1`, and a small HTML
 *    document: the page's head with no scripts, then its regions in order, with no `<noscript>`.
 *    Nothing in that markup is trusted. Its scripts come in
 *    `Natsu-Scripts`: one entry per tag, space-separated, each the tag's
 *    attributes URL-encoded (`src=%2F_a%2Fb.js&defer=&nonce=`); the `src`
 *    is resolved against the part's URL, and a `nonce` key means "give it
 *    the boot nonce". `Natsu-Nonce` lists the nonces the server vouches for
 *    in the head; an element with one reads `nonce=""` (as the browser
 *    shows it on a live element) and any other nonce is removed;
 *  - `204` with `Natsu-Location: <url>`: the page redirected (a path for a
 *    target on this site); a same-origin target is visited (five hops at
 *    most), any other is a real load;
 *  - `204` with `Natsu-Reload: <reason>`: load this page for real. For
 *    `route` (not navigable) and `response` (no page there) the path is a
 *    real load, never prefetched, for the rest of this document, as it is
 *    for an answer with no `natsu-` header at all (another server behind
 *    the same proxy);
 *  - `204` with `Natsu-Prefetch: skip`: a hover was refused (a click still
 *    swaps).
 *
 * An island asks its URL, on this origin only, with `Natsu-Island: 1`, and
 * takes the answer only when it is a `200` `text/html` that says
 * `Natsu-Island: 1` back, as only a route made with `island()` does: an
 * attribute slipped into content cannot pull another page into this one.
 *
 * **The swap**, step by step:
 *
 *  1. The part is parsed with `DOMParser`. The server leaves every
 *     `<noscript>` out of it: a parser with scripting off reads their content
 *     as markup, so `<noscript><style>` would become a live style, and a
 *     `</div>` inside would let the rest out of it. A part that cannot be
 *     parsed (Trusted Types refuses `DOMParser`), or still holds a
 *     `<noscript>`, is a real load. A region with a declarative shadow root
 *     (`<template shadowrootmode>`, which DOMParser leaves inert) is never
 *     sent as a part: the server answers with a real load. An answer already in hand (prefetched)
 *     yields a frame first, so the click's own frame paints.
 *  2. Its region ids must equal the current ones, in order.
 *  3. Its stylesheets go in before the current ones and must load first
 *     (four seconds at most; one the memory cache had, readable as it goes
 *     in, counts as loaded then). Every page's sheet is a slice of the same
 *     source in source order, so the old sheet, later in the cascade, keeps
 *     the old markup exactly as it was while the new one loads. A lazy half
 *     (`data-natsu-later`) loads too. A visit overtaken meanwhile removes the
 *     sheets it added. There is no font step: in Chromium a
 *     face the new sheet declares again comes from the memory cache as the
 *     old sheet goes, so text does not flash in a fallback, and when the
 *     font cannot be cached, loading the new face early does not help,
 *     because removing the old sheet makes the browser build its faces
 *     afresh (tests/navigate.e2e.ts).
 *  4. In one synchronous step (inside a view transition only when
 *     `<html data-natsu-transition>` or the key's `data-transition` opts in,
 *     and never under `prefers-reduced-motion`; a visit overtaken before the
 *     transition runs it swaps nothing): `natsu:before-swap`, history,
 *     the head merged by `outerHTML` (only what the server sent: scripts,
 *     nodes a third party added and `<html>` attributes are never touched;
 *     a new element the server vouched for gets the boot nonce, so a page's
 *     own inline `<style>` applies under a nonce `style-src`),
 *     the old stylesheets out, each region unmounted and replaced, scroll
 *     (a jump, as every scroll the runtime makes, whatever `scroll-behavior`
 *     says), focus (kept with `scroll: "keep"`), and the title read out
 *     through a `role=status` element.
 *  5. The mounts already registered run on the new regions. The listed
 *     scripts this document has not run are created from their entries,
 *     with the boot nonce where the entry says so (which `'strict-dynamic'`
 *     does not need, and a bare nonce policy does) and `async = false`, so
 *     they run in order and their `mount` calls bind as they run (one the
 *     browser never runs, `nomodule` or another type, is not waited for).
 *     Once they have run, a created script that has not called `mount`
 *     means a real load of this page; else `natsu:load` fires, unless
 *     another visit or a Back overtook this one meanwhile.
 *
 * **Scroll** is kept per history entry, keyed by the entry the page on
 * screen belongs to, never by whatever `history.state` says at the moment:
 * a scroll during a back/forward fetch still belongs to the page being left.
 * It is written into the entry too, once a scroll settles (200 ms) and at
 * `beforeunload` and `pagehide`, so a reload, or a return after the
 * document is gone, comes back to it; never into an entry that a Back or
 * Forward on its way has put in the address bar.
 * Each page shown is numbered, and every entry made from it carries the
 * number: the browser's own entry for a hash link gets it at its popstate.
 * A popstate to an entry with the number on screen is a scroll (to where the
 * entry was, else to its hash target); any other is a visit. An entry a
 * script pushed with no state of ours gets an id of its own at its first
 * scroll. Back or Forward ends any visit on its way; a hash link's own jump
 * does not, as a browser lets a load go on past it. A page restored from
 * the back/forward cache while a Back or Forward was on its way loads the
 * URL in the address bar for real.
 *
 * **Prefetch.** A pointer that rests 65 ms on a link (a finger too: the
 * browser taking the touch to pan, or a scroll, cancels it) fetches the part
 * with `Natsu-Prefetch: 1`, two at a time at most, and none on Save-Data or
 * 2G, or when `<meta name="natsu" data-prefetch="off">` says the server
 * refuses them. A link under `data-natsu-prefetch="viewport"` is fetched
 * once it is on screen too (an IntersectionObserver, in idle time, not on
 * 3G, and only while the cache has room, so it never pushes a hover out);
 * one under `"none"` (or `"off"`) never is. The key's `data-prefetch`
 * (`"viewport"`, `"none"`) is the default for a link that says nothing. A
 * click within ten seconds uses the answer: a part, or a
 * redirect or reload, acted on as it is. Any other (a skip, a 404 part) is
 * remembered as no answer for those ten seconds, so hovers stop asking and
 * the click fetches. Five answers are kept, least recently used out first.
 *
 * **Back and Forward** to a page this document swapped in use the part it
 * was shown from, for ten seconds from when it was asked for: the page comes
 * back at once. A click always asks again (unless a hover just did); a page
 * with live data, and an action's answer, are never kept; any submit or
 * action lets them all go.
 *
 * **The API**, `natsu` (types in `client/types.ts`):
 *
 *  - `mount<E>(selector, (el: E, signal) => cleanup?)`
 *  - `visit(url, { history?: "push" | "replace" | "none", scroll?: "top" | "keep" | y })`
 *  - `refresh()`: this page again, scroll and focus kept (after an action);
 *    when the server answers with a real load, `location.reload()`, and a
 *    redirect shows its page from the top, as a reload that redirects does
 *  - `prefetch(url)`, and `island(el)` to fetch an island again (only the
 *    latest fetch's answer goes in)
 *  - events on `document`: `natsu:visit` (cancelable: the visit does not
 *    happen, and on Back or Forward the page loads for real),
 *    `natsu:before-swap`, and `natsu:load`, once per page shown (at boot
 *    too) with `detail: { url, regions }`
 *  - attributes: `data-natsu-reload` on a link, form or ancestor for a real
 *    load, and on `<html>` for every visit from this document;
 *    `data-natsu-prefetch` for when links below it are fetched ahead
 *    (`"viewport"`, `"none"`, else on hover), and `data-natsu-reload`
 *    (present is on, `"false"`, `"off"` or `"none"` is off);
 *    `data-natsu-once` on a script, `data-natsu-island="<url>"` on an
 *    element whose content comes from that URL after load, and
 *    `<html data-natsu-transition>`. `html[data-natsu-loading]` is set
 *    when a visit takes longer than 150 ms, and cleared by any real load;
 *    it shows `<natsu-bar>`, a 2px bar the runtime adds to the body, styled
 *    from a constructed sheet in `@layer natsu` (so any page rule wins:
 *    `natsu-bar { display: none }`, or `--natsu-bar` for its colour).
 *
 * With no key or no region the runtime stays inert: `mount` still works and
 * `visit` is `location.assign`.
 *
 * **Actions and live data** (`data-uwu-action`, `<meta name="natsu-live">`)
 * are built in too: see the section of that name below.
 *
 * Built as a classic script. `define: { NATSU_DEV: "true" }` gives the
 * development build, which says in the console why each visit became a
 * real load; any other build leaves those lines out.
 */

import type { NatsuClient, NatsuVisitOptions } from "./types.ts";

declare const NATSU_DEV: boolean | undefined;
const DEV = typeof NATSU_DEV != "undefined" && NATSU_DEV;
const why = (...a: unknown[]) => console.info("natsu: real load,", ...a);

/** A registration: selector, function, and the src of the script that made it ("" = everywhere). */
type Reg = [string, (el: Element, signal: AbortSignal) => unknown, string];
/** An element and the registrations already mounted on it. */
type Mounted = Element & { natsu?: Set<Reg> };
type Answer = [Response, string];
/** `a`: the answer already on its way (an action's post), used instead of a GET. */
type Opts = NatsuVisitOptions & { hops?: number; a?: Promise<Answer>; k?: () => void };

const D = document;
const H = D.documentElement;
const L = location;
const HI = history;
const me = D.currentScript as HTMLScriptElement | null;
/** The boot nonce, for what goes in under the page's CSP (none: a runtime with no tag of its own). */
const NONCE = me?.nonce as string;
const META = D.querySelector<HTMLMetaElement>('meta[name="natsu"]');
const KEY = META?.content;
const OFF = /^(false|off|none)$/;
const REGION = "[data-natsu-region][id]";
const LOADING = "data-natsu-loading";
const SHEET = "link[rel=stylesheet]";
const LATER = "data-natsu-later";
const QUIET = { preventScroll: true };
/** Every scroll the runtime makes jumps, as the browser's own restore does, whatever `scroll-behavior` says. */
const INSTANT: ScrollToOptions = { behavior: "instant" };
const go = (top: number) => scrollTo({ ...INSTANT, top });

const regs: Reg[] = [];
/**
 * Live mounts: the element, what stops it (abort the signal, run the
 * cleanup), its registration, and the region it was mounted in.
 */
let live: [Element, () => void, Reg, Element | null][] = [];
/**
 * Scripts that called `mount`: each element, and its src. Also this
 * runtime's own tag, and a script a swap appended until it has run.
 */
const aware = new Set<unknown>([me]);
/** Srcs whose mounts may run on the page shown. Unset at boot: all of them. */
let list: string[] | undefined;
let ready = false;

const on = (type: string, fn: (e: never) => unknown) => addEventListener(type, fn as EventListener);
/** Every natsu event is on document, bubbling and cancelable. */
const fire = (name: string, detail: unknown) =>
	D.dispatchEvent(new CustomEvent("natsu:" + name, { bubbles: true, cancelable: true, detail }));
/** The nearest `data-natsu-<name>` at or above `el`: present is on, "false", "off" and "none" are off; undefined if none. */
const flag = (el: Element, name: string) => {
	const v = el.closest(`[data-natsu-${name}]`)?.getAttribute("data-natsu-" + name);
	return v == null ? v : !OFF.test(v);
};

const mountIn = (root: Element, only?: Reg) => {
	for (const r of only ? [only] : regs)
		if (!r[2] || !list || list.includes(r[2]))
			for (const el of [root, ...root.querySelectorAll(r[0])] as Mounted[]) {
				const done = (el.natsu ||= new Set());
				if (!el.matches(r[0]) || done.has(r)) continue;
				done.add(r);
				const a = new AbortController();
				// Read before the function runs: it may move the element (a portal to body).
				const home = el.closest(REGION);
				let cleanup: unknown;
				try {
					cleanup = r[1](el, a.signal);
				} catch (e) {
					reportError(e);
				}
				live.push([el, () => (a.abort(), typeof cleanup == "function" && cleanup()), r, home]);
			}
};

/**
 * Stop the mounts inside `root`, and on it unless `inner` (one mounted in it
 * that page code moved out counts); and any whose element page code took out
 * of the document since, which nothing else stops.
 */
const unmount = (root: Element, inner?: 1) =>
	(live = live.filter(([el, stop, r, home]) => {
		if ((!(root.contains(el) || root == home) || (inner && el == root)) && el.isConnected && (!r[2] || !list || list.includes(r[2]))) return 1;
		(el as Mounted).natsu!.delete(r);
		try {
			stop();
		} catch (e) {
			reportError(e);
		}
	}));

const island = async (el: Element & { q?: object }, signal?: AbortSignal) => {
	// Only this site, and only an answer from a route that says it is an
	// island: markup that slipped into a page must not pull in another
	// origin's HTML, nor a whole page of this one.
	const u = new URL((el as HTMLElement).dataset.natsuIsland!, L.href);
	if (u.origin != L.origin) return;
	// Only the answer to the latest fetch of this island goes in: an earlier one may come back last.
	const q = (el.q = {});
	const r = await fetch(u, { signal, headers: { "Natsu-Island": "1" } });
	const html =
		r.status == 200 && /^text\/html/.test(r.headers.get("content-type")!) && r.headers.get("natsu-island") == "1" && (await r.text());
	if (html !== false && el.isConnected && el.q == q) {
		unmount(el, 1);
		el.innerHTML = html;
		mountIn(el);
	}
};
/**
 * The runtime is on the page twice (the server's tag and one written by
 * hand): this copy stays out, and mounts through the first, so that its own
 * tag is not a script that never called mount.
 */
const first = window.natsu as NatsuClient | undefined;
first?.mount(":not(*)", () => {});

// Built in, so it is tagged with no script and runs everywhere.
regs.push(["[data-natsu-island]", (el, signal) => island(el, signal).catch(() => {}), ""]);

const api: NatsuClient = {
	mount(selector, fn) {
		// A module script, or a call made later (an event, after an await):
		// the stack names the script's URL, in every engine.
		const s = (D.currentScript || [...D.scripts].find((e) => e != me && e.src && new Error().stack!.includes(e.src + ":"))) as
			| HTMLScriptElement
			| undefined;
		if (s) aware.add(s.src || s);
		// A script in <head> runs once per document, as the shell does, and one a
		// loader created (force-async: async with no attribute) is listed by no
		// page: their mounts go everywhere.
		const r: Reg = [selector, fn as Reg[1], s && s.parentNode != D.head && s.async == s.hasAttribute("async") ? s.src : ""];
		regs.push(r);
		if (ready) mountIn(D.body, r);
	},
	visit: async (url) => L.assign(url),
	refresh: async () => L.reload(),
	prefetch() {},
	island,
};
if (!first) window.natsu = api;

/** The src of every script this document ran or started. */
const loaded = new Set<string>();
/** The run of each script a swap created, by src: a later visit that lists it waits for it too. */
const made: Record<string, unknown> = {};
/** The ones that must have called `mount` by the time a visit starts, for a swap to be safe. */
const listed = new Set<HTMLScriptElement>();
/**
 * What the browser runs: no type, a JavaScript one (each has "script" in
 * it), or a module; not JSON nor any other data block, nor a type a consent
 * manager turns on later, and never a `nomodule` one. A rarer type with
 * "script" in it (`text/typescript`) is taken for one.
 */
const runs = (s: HTMLScriptElement) => /script|^(module)?$/i.test(s.type.trim()) && !s.noModule;
/**
 * Every script that runs counts, inline and module ones too, but for the
 * runtime, a data-natsu-once tag, and a classic head script that blocks the
 * parser: it ran before the body existed, so it is shell. One a swap
 * appended counts once it has run, not while it still loads.
 */
const counts = (s: HTMLScriptElement) =>
	runs(s) &&
	!aware.has(s) &&
	!s.hasAttribute("data-natsu-once") &&
	!(s.parentNode == D.head && !/module/i.test(s.type) && !(s.src && (s.defer || s.async)));
/**
 * A listed script that has not called `mount` (yet), by its src: an inline
 * one that called it is in `aware` itself, so it is never listed.
 */
const blind = (s: HTMLScriptElement) => !aware.has(s.src || s);
const regions = (doc: Document) => [...doc.querySelectorAll(REGION)];
/**
 * Whether a script that counts has not called `mount`, noting the
 * document's scripts first: before every visit, for one a loader added since.
 */
const unbound = () => {
	for (const s of D.scripts) loaded.add(s.src), counts(s) && listed.add(s);
	return [...listed].some(blind);
};

/** What the runtime adds to the body at boot: the title's `role=status`, the loading bar. */
const extra: Element[] = [];
const boot = () => {
	if (!ready) {
		ready = true;
		D.body.append(...extra);
		mountIn(D.body);
		// Noted now too: a script page code takes out before the first visit still ran.
		unbound();
		// One natsu:load per page shown, this one included: a page-view hook counts each once.
		fire("load", { url: L.href, regions: regions(D) });
	}
};

// --- actions and live data ---------------------------------------------------

/**
 * The browser half of actions and live data, built into the runtime.
 *
 * **Actions.** uwu draws `@submit="action:add"` as a form with
 * `data-uwu-action="add" data-uwu-event="submit"` (a POST to the page,
 * `_action` in a hidden field) and `@click="action:done"` as an element with
 * `data-uwu-action="done" data-uwu-event="click"`. A mount on
 * `[data-uwu-action]` listens for that event and posts the form's fields
 * and the element's `data-*` (by dataset name; a form field of the same name
 * wins), `_action`, and the CSRF token (the form's, else the `natsu_csrf`
 * cookie), with `Natsu-Action: 1`. On a page with a key the post also
 * carries `Natsu-Nav`, and its answer is handled as a visit's: a 303 back
 * becomes a visit of the page (its regions swapped, scroll and focus kept),
 * a refused form comes back as a part with its errors. Without a key a form
 * is left to the browser, and a click reloads the page once it is done.
 * While a post is on its way its element is `aria-busy` and takes no other.
 *
 * **Live data.** A page that drew live data has
 * `<meta name="natsu-live" content="<tags>|<signature>">`. Its tags go to
 * the server over `/_uwu/socket` (`{ t: "watch", tags }`, again on every
 * page shown, "" when a page has none), and an `invalidate` frame refreshes
 * the page, unless an action is on its way (its own answer redraws the
 * page). A dropped socket reconnects, waiting longer each time up to 30 s,
 * and refreshes the page once back, for what it missed.
 */

/** Posts on their way. */
let acting = 0;

const send = (url: string, body: FormData | URLSearchParams, key?: string) =>
	fetch(url, { method: "POST", body, headers: { "Natsu-Action": "1", ...(key && { "Natsu-Nav": key }) } });

/**
 * `act(url, body)` runs the post and redraws the page; `key` is the
 * document key (forms go by the browser without one).
 */
const actions = (regs: Reg[], act: (url: string, body: FormData | URLSearchParams, k?: () => void) => unknown, key?: string) =>
	regs.push([
		"[data-uwu-action]",
		(el, signal) => {
			const d = (el as HTMLElement).dataset;
			el.addEventListener(
				d.uwuEvent || "click",
				async (e) => {
					const form = el instanceof HTMLFormElement && el;
					if (e.defaultPrevented || (form && !key)) return;
					e.preventDefault();
					if (el.hasAttribute("aria-busy")) return;
					const by = (e as SubmitEvent).submitter;
					const fd = form ? new FormData(form, by) : new FormData();
					for (const k in d) /^uwu[A-Z]/.test(k) || fd.has(k) || fd.set(k, d[k]!);
					fd.set("_action", d.uwuAction!);
					fd.has("_csrf") || fd.set("_csrf", /(?:^|; )natsu_csrf=([^;]*)/.exec(document.cookie)?.[1] || "");
					const to = form ? new URL(by?.getAttribute("formaction") || form.getAttribute("action") || "", document.baseURI).href : location.href;
					el.setAttribute("aria-busy", "true");
					acting++;
					try {
						await act(to, [...fd.values()].some((v) => typeof v != "string") ? fd : new URLSearchParams(fd as unknown as string[][]), form ? typed(form) : undefined);
					} finally {
						acting--;
						el.removeAttribute("aria-busy");
					}
				},
				{ signal },
			);
		},
		"",
	]);

/**
 * What was typed, picked or ticked in a form (never a hidden field, a
 * password or a file), and how to put it back in the form of the same action
 * at the same place on the page once a refusal has drawn it again: whatever the
 * server wrote in its fields, the visitor's own text is what they fix.
 */
const typed = (form: HTMLFormElement) => {
	const i = [...D.forms].indexOf(form);
	const of = (f?: HTMLFormElement) => [...(f?.elements || [])].filter((e) => !/^(hi|pa|fi|su|bu)/.test((e as HTMLInputElement).type)) as HTMLInputElement[];
	const was = of(form).map((e) => [e.value, e.checked] as const);
	return () => {
		const now = of(D.forms[i]);
		now.length == was.length && now.forEach((e, n) => ([e.value, e.checked] = was[n]!));
	};
};

/** Watch the page's live tags; `refresh` redraws it. */
const watchLive = (refresh: () => unknown) => {
	let ws: WebSocket | 0 = 0;
	let want = "";
	let wait = 1e3;
	let back = 0;
	let t: ReturnType<typeof setTimeout>;
	const say = () => ws && ws.readyState == 1 && ws.send(JSON.stringify({ t: "watch", tags: want }));
	const open = () => {
		const s = (ws = new WebSocket(location.origin.replace(/^http/, "ws") + "/_uwu/socket"));
		s.onopen = () => {
			wait = 1e3;
			say();
			// Back after a drop: whatever changed meanwhile was not heard.
			back && refresh();
		};
		s.onmessage = (e) => {
			try {
				JSON.parse(e.data).t == "invalidate" && !acting && (clearTimeout(t), (t = setTimeout(refresh, 30)));
			} catch {}
		};
		s.onclose = () => {
			ws = 0;
			back = 1;
			want && setTimeout(() => want && !ws && open(), (wait = Math.min(wait * 2, 3e4)));
		};
	};
	document.addEventListener("natsu:load", () => {
		const n = document.querySelector<HTMLMetaElement>('meta[name="natsu-live"]')?.content || "";
		if (n != want) (want = n), ws ? say() : n && open();
	});
};

/** An action's post, and the page drawn again: without a key, a reload once it is done (a page with one swaps instead). */
let act = (u: string, body: FormData | URLSearchParams, _k?: () => void): Promise<unknown> =>
	send(u, body).then((r) => (r.url && r.url != L.href ? L.assign(r.url) : L.reload()));
if (!first) {
	actions(regs, (u, body, k) => act(u, body, k), KEY && regions(D)[0] ? KEY : undefined);
	watchLive(() => api.refresh());
}

if (!first && KEY && regions(D)[0]) {
	const status = D.createElement("p");
	status.setAttribute("role", "status");
	status.style.cssText = "position:fixed;clip-path:inset(50%)";
	// The loading bar, an element no page selector names: styled from a sheet
	// in a layer of its own, so any rule of the page's (`natsu-bar { display:
	// none }`) wins over it. A constructed sheet is outside style-src, so it
	// shows under any CSP.
	extra.push(status, D.createElement("natsu-bar"));
	try {
		const css = new CSSStyleSheet();
		css.replaceSync(
			"@layer natsu{natsu-bar{position:fixed;inset:0 0 auto;height:2px;z-index:999999;pointer-events:none;background:var(--natsu-bar,#47f);transform-origin:0;transform:scaleX(0);opacity:0;transition:opacity .2s,transform 0s .2s}[data-natsu-loading] natsu-bar{opacity:1;transform:scaleX(.9);transition:transform 8s ease-out}@media(prefers-reduced-motion:reduce){natsu-bar,[data-natsu-loading] natsu-bar{transition:none}}}"
		);
		D.adoptedStyleSheets = [...D.adoptedStyleSheets, css];
	} catch {}

	/** Head elements the server sent: the only ones a merge may remove. */
	const owned = new Set([...D.head.children].filter((e) => !e.matches("script")));
	// Off when the page said this document is never to be swapped again (an ad shown, say).
	const unsafe = DEV
		? () => {
				const off = flag(H, "reload");
				const bad = unbound() && [...listed].filter(blind);
				if (!ready || off || bad)
					why(
						...(!ready
							? ["before DOMContentLoaded"]
							: off
								? ["<html data-natsu-reload>"]
								: [bad, "never called natsu.mount (call it at the top level of the script, or tag it data-natsu-once)"]),
					);
				return !ready || off || !!bad;
			}
		: () => !ready || flag(H, "reload") || unbound();
	const bare = (u: URL | Location) => u.href.split("#")[0]!;
	/** The element a URL's hash names. */
	const anchor = (u: URL | Location) => {
		try {
			return D.getElementById(decodeURIComponent(u.hash.slice(1)));
		} catch {}
	};

	// --- history --------------------------------------------------------
	/** Ours in an entry's state: its id, the page it shows, its scroll when left. */
	const st = (): { id: number; p?: number; y?: number } | undefined => HI.state?.natsu;
	let id = +new Date();
	/** The history entry on screen: a swap or a same-page popstate changes it. */
	let cur = st()?.id ?? ++id;
	/**
	 * The page on screen, numbered. Every entry made from it carries the
	 * number (a hash link's, one a script rewrote with its state kept), so a
	 * popstate between two of them is a scroll, whatever the URL says.
	 */
	let page = ++id;
	/** Its URL without the hash: for an entry with no state of ours, and to resolve links while `away`. */
	let rendered = bare(L);
	/** The entry a same-page hash link is leaving, until its popstate: the jump's scroll is not its own. */
	let frozen = 0;
	/**
	 * A Back or Forward to another page is on its way: the entry in the
	 * address bar is not the one on screen, so nothing is written into it,
	 * and a link or form on screen is read against the page it belongs to.
	 */
	let away: unknown;
	const ys = new Map<number, number>();
	/** Ours into the entry shown; one a script pushed with no state of ours gets an id of its own first. */
	const put = (y?: number, url?: string) => HI.replaceState({ ...HI.state, natsu: { id: cur, p: page, y } }, "", url);
	// The browser restores scroll, on a reload too, until a swap makes the
	// entries manual. A reload keeps that, and leaves the scroll to us: now,
	// and again at load (images, fonts) unless the visitor scrolled meanwhile.
	const y0 = st()?.y;
	put(y0);
	if (y0 && "manual" == HI.scrollRestoration) {
		go(y0);
		const at = scrollY;
		on("load", () => scrollY == at && go(y0));
	}
	let saving: ReturnType<typeof setTimeout>;
	/** The scroll of the page on screen, into its entry: a reload, or a return after the document is gone, comes back to it. */
	const save = () => away || frozen == cur || put(scrollY);
	on(
		"scroll",
		() => {
			frozen || away || st() || ((cur = ++id), put());
			frozen == cur || ys.set(cur, scrollY);
			// Into the entry too, once the scroll settles: Back or Forward leaves
			// it with no event of its own, and the document may be gone before
			// the visitor returns. A hover's prefetch waits no more.
			forget();
			clearTimeout(saving);
			saving = setTimeout(save, 200);
		},
	);
	// Back from the back/forward cache after a visit became a real load: no
	// longer loading, and a loading timer frozen with the page must not fire.
	// Kept while a Back or Forward was on its way, the page on screen is not
	// the one in the address bar: that one loads.
	on("pageshow", (e: PageTransitionEvent) => e.persisted && (idle(), away && L.reload()));
	// A replaceState in pagehide is lost on a reload; one in beforeunload is kept.
	on("beforeunload", save);
	on("pagehide", () => {
		save();
		clear();
	});
	on("popstate", () => {
		const s = st();
		const y = s && (ys.get(s.id) ?? s.y);
		away = s ? s.p != page : !frozen && bare(L) != rendered;
		// Whatever was on its way is over: this entry is what shows now. Not
		// after a hash link's own jump, which the browser lets a load go on past.
		frozen || (++seq, idle());
		frozen = 0;
		if (away) return visit(L.href, { history: "none", scroll: y });
		// The same page (a hash link's entry, or one made from this page): the
		// scroll the entry had, else its hash target, else where it is.
		s ? (cur = s.id) : ((cur = ++id), put());
		y != null ? go(y) : anchor(L)?.scrollIntoView(INSTANT);
	});

	// --- which clicks and forms -----------------------------------------
	const ok = (el: Element, u: URL) =>
		u.origin == L.origin &&
		!flag(el, "reload") &&
		!/\.(?!html?$)\w+$/i.test(u.pathname);
	/** A target other than this tab: the element's own, else the first `<base target>`. */
	const other = (t?: string | null) => (t ||= D.querySelector<HTMLBaseElement>("base[target]")?.target) && t != "_self";
	/** The page on screen's URL, and what its links resolve against: its `<base href>`, read against it while `away`. */
	const here = () => (away ? rendered : L.href);
	const base = () => new URL(D.querySelector("base[href]")?.getAttribute("href") || "", here());
	const link = (t: EventTarget | null, click?: 1) => {
		const a = (t as Element).closest?.("a[href]");
		// A link in an editor is not followed: a click there places the caret.
		if (!(a instanceof HTMLAnchorElement) || a.isContentEditable || other(a.target) || a.hasAttribute("download")) return;
		const u = new URL(a.getAttribute("href")!, base());
		// The same page with a hash is the browser's own jump to an anchor, and
		// the scroll it makes belongs to the entry it pushes: the one left keeps
		// where it is now.
		if (!away && bare(u) == bare(L) && u.href.includes("#")) {
			if (click) ys.set((frozen = cur), scrollY);
			return;
		}
		return ok(a, u) && ([a, u] as const);
	};
	/**
	 * Where the last click with a modifier landed (null after a plain one): a
	 * submit from that button opens where the browser says (a new tab, a
	 * window). Kept per element, so a link opened in a new tab holds back no
	 * later submit.
	 */
	let mod: unknown;
	// On window, bubbling: after every listener on the document, so one that
	// called preventDefault always wins.
	on("click", (e: MouseEvent) => {
		const a = !(e.defaultPrevented || e.button || (mod = ((e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) && e.target) || null)) && link(e.target, 1);
		if (a) {
			e.preventDefault();
			visit(a[1]);
		}
	});
	on("submit", (e: SubmitEvent) => {
		clear();
		const form = e.target as HTMLFormElement;
		const by = e.submitter;
		const attr = (n: string) => by?.getAttribute("form" + n) ?? form.getAttribute(n);
		// A query in another encoding than UTF-8 is the browser's to write.
		if (
			e.defaultPrevented ||
			by?.contains(mod as Node) ||
			/post|dialog/i.test(attr("method")!) ||
			other(attr("target")) ||
			/[^utf8-]/i.test(attr("accept-charset") || "")
		)
			return;
		// No action is the page's own URL, never the base.
		const u = new URL(attr("action") || here(), base());
		if (!ok(form, u) || (by && !ok(by, u))) return;
		// A file goes as its name, and a line break as CRLF, as the browser sends them in a query.
		// "?" first: with no field the query is empty, not gone, as the browser sends it.
		u.search =
			"?" + new URLSearchParams([...new FormData(form, by)].map(([k, v]) => [k, (v as File).name ?? (v as string).replace(/\r?\n/g, "\r\n")]));
		e.preventDefault();
		visit(u);
	});

	// --- prefetch -------------------------------------------------------
	const cache = new Map<string, { t: number; p: Promise<Answer | undefined> }>();
	let flying = 0;
	/**
	 * Paths whose route is not navigable, that are no page, or that another
	 * server answers (no natsu header at all: a blog behind the same proxy):
	 * a real load from now on, never prefetched.
	 */
	const refused = new Set<string>();
	/** The server's `navigate.prefetch`: "off" (false) refuses them all, "none" or "viewport" is the default for a link that says nothing. */
	const quiet = META!.dataset.prefetch == "off";
	/** A link's prefetch: "" none, "viewport", else "hover". */
	const pf = (el: Element) => {
		const v = el.closest("[data-natsu-prefetch]")?.getAttribute("data-natsu-prefetch") ?? META!.dataset.prefetch ?? "";
		return OFF.test(v) ? "" : v == "viewport" ? v : "hover";
	};
	const get = (u: URL, pre?: 1) =>
		fetch(bare(u), { headers: { "Natsu-Nav": KEY!, ...(pre && { "Natsu-Prefetch": "1" }) } }).then(
			async (r): Promise<Answer> => (
				(/^(route|response)$/.test(r.headers.get("natsu-reload")!) || !/natsu-/.test("" + [...r.headers.keys()])) && refused.add(u.pathname),
				[r, await r.text()]
			),
		);
	/** A cached answer young enough to use, taken out of the cache (or out of `kept`). */
	const fresh = (k: string, m = cache) => {
		const hit = m.get(k);
		m.delete(k);
		return (Date.now() - hit?.t! < 1e4 && hit) as typeof hit;
	};
	const prefetch = (url: string | URL) => {
		const u = new URL(url, L.href);
		const k = bare(u);
		const hit = fresh(k);
		if (hit) return void cache.set(k, hit); // now the most recently used
		if (quiet || unsafe() || slow(/2g/) || flying > 1 || k == bare(L) || u.origin != L.origin || refused.has(u.pathname))
			return;
		flying++;
		cache.set(k, {
			t: Date.now(),
			// Kept: a 200 part, or an answer that says reload or go elsewhere,
			// which the click acts on as it is. Anything else (a skip, a 404
			// part) stays as no answer, so hovers stop asking and the click
			// fetches; a network error goes.
			p: get(u, 1)
				.then((a) => {
					const x = a[0].headers;
					if (x.has("natsu-part") ? a[0].status == 200 : !x.has("natsu-prefetch")) return a;
				}, () => void cache.delete(k))
				.finally(() => (flying--, soon())),
		});
		trim(cache);
	};
	/**
	 * The parts of the pages this document showed, for Back and Forward only:
	 * a page left comes back at once while it is fresh (ten seconds from when
	 * it was asked for). A click always asks again, unless a hover just did.
	 */
	const kept: typeof cache = new Map();
	const trim = (m: typeof cache) => m.size > 5 && m.delete([...m.keys()][0]!);
	const clear = () => (cache.clear(), kept.clear());
	/** Save-Data, or a connection `re` names (2g for any prefetch, 3g too for one in view). */
	const slow = (re: RegExp) => {
		const c = (navigator as { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
		return c?.saveData || re.test(c?.effectiveType!);
	};
	// In view: a link with `data-natsu-prefetch="viewport"` (or every link,
	// when that is the site's default) is fetched once it has been on screen,
	// in idle time, two at a time, while the cache has room: at most five
	// parts are kept, and a link in view must not push out the one hovered.
	const seen = new Set<Element>();
	let due = 0;
	const pump = () => {
		due = 0;
		for (const [k, v] of cache) Date.now() - v.t < 1e4 || cache.delete(k);
		for (const a of seen) {
			if (flying > 1 || cache.size > 4 || slow(/[23]g/)) return;
			seen.delete(a);
			io?.unobserve(a);
			const l = link(a);
			l && prefetch(l[1]);
		}
	};
	const soon = () => seen.size && !due && (due = 1) && ("requestIdleCallback" in window ? requestIdleCallback : setTimeout)(pump);
	const io =
		window.IntersectionObserver &&
		new IntersectionObserver((es) => {
			for (const e of es) e.isIntersecting ? seen.add(e.target) : seen.delete(e.target);
			soon();
		});
	if (io)
		regs.push([
			META!.dataset.prefetch == "viewport" ? "a[href]" : "[data-natsu-prefetch=viewport] a[href],a[href][data-natsu-prefetch=viewport]",
			(el, signal) => pf(el) == "viewport" && (io.observe(el), (signal.onabort = () => (io.unobserve(el), seen.delete(el)))),
			"",
		]);
	let over: Element | null | undefined;
	let dwell: ReturnType<typeof setTimeout>;
	const intent = (e: Event) => {
		const a = link(e.target);
		if (!a || a[0] == over) return;
		over = a[0];
		clearTimeout(dwell);
		dwell = setTimeout(() => pf(a[0]) && prefetch(a[1]), 65);
	};
	const forget = () => {
		clearTimeout(dwell);
		over = null;
	};
	// A finger waits as a mouse does: a flick across a grid of links is a
	// scroll, which the browser says (pointercancel, as it takes the touch to
	// pan) or the page does.
	on("pointerover", intent);
	on("pointerout", (e: PointerEvent) => over && !over.contains(e.relatedTarget as Node) && forget());
	on("pointercancel", forget);

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
	const full = (u: URL, h?: string) =>
		// This page again (refresh) is a reload: a replace of a URL with a hash would only jump, and one without would lose the scroll.
		(idle(), L[h == "none" || (h && u.href == L.href) ? "reload" : h ? "replace" : "assign"](u.href));
	/** The regions' ids in order, each closed by a space, which no id holds. */
	const ids = (els: Element[]) => "" + els.map((e) => e.id + " ");
	const sheets = (doc: Document) => [...doc.head.querySelectorAll<HTMLLinkElement>(SHEET)];
	const href = (l: Element) => l.getAttribute("href");

	const visit = async (url: string | URL, o: Opts = {}): Promise<void> => {
		const u = new URL(url, L.href);
		// "push" is what no option means; "replace" and "none" write over the entry shown.
		let h = o.history != "push" ? o.history : undefined;
		// Cancelled: nothing happens, unless the URL already changed (back/forward).
		if (!fire("visit", { url: u.href })) {
			if (DEV && "none" == h) why("natsu:visit was cancelled", u.href);
			// A redirect's hop owns the loading timer its first visit started.
			return "none" == h ? full(u, h) : void (o.hops && idle());
		}
		if (unsafe() || u.origin != L.origin || refused.has(u.pathname)) return full(u, h);
		// The page already shown: the browser too replaces rather than pushes.
		if (!h && u.href == L.href) h = "replace";
		// A hover's pending prefetch would only fetch the same page twice; and
		// the link it holds may be in a region about to go, which it would keep.
		forget();
		clearTimeout(timer);
		timer = setTimeout(() => H.setAttribute(LOADING, ""), 150);
		const n = ++seq;
		let a: Answer | undefined;
		/** When the answer was asked for: one kept for Back and Forward lives ten seconds from then. */
		let t = Date.now();
		let hit: ReturnType<typeof fresh>;
		try {
			if (o.a) a = await o.a;
			else if (o.scroll != "keep" && (hit = fresh(bare(u)) || ("none" == h ? fresh(bare(u), kept) : undefined))) (t = hit.t), (a = await hit.p);
			// In hand already (prefetched): the swap would run in the click's own
			// task and hold its frame back, so it yields first.
			if (a)
				await new Promise(
					(y) => (window as { scheduler?: { yield?(): Promise<void> } }).scheduler?.yield?.().then(y) ?? requestAnimationFrame(() => setTimeout(y)),
				);
			if (!a && !o.a) a = await get(u);
		} catch {}
		if (n != seq) return;
		if (!a) {
			if (DEV) why("network error", u.href);
			return full(u, h);
		}
		const [r, text] = a;
		const head = r.headers;
		const to = head.get("natsu-location");
		if (to) {
			const v = new URL(to, u);
			v.hash ||= u.hash;
			// Shown from its top (or its hash), as a load that redirects is: a scroll asked for was for the URL asked for.
			// An action's refresh of the same page keeps its scroll and focus; one that sent the visitor elsewhere is a visit there.
			const same = bare(v) == bare(L);
			const next: Opts = { ...(o.a && same ? o : {}), a: undefined, history: o.a && !same ? undefined : h == "none" ? "replace" : h, hops: -~o.hops! };
			return next.hops! < 6 ? visit(v, next) : (DEV && why("redirect to", v.href), full(v, next.history));
		}
		if (!head.has("natsu-part")) {
			if (DEV) why(head.get("natsu-reload") ?? "not a part", u.href);
			return full(u, h);
		}
		// Anything that throws before the swap (DOMParser under Trusted Types, a
		// header it cannot read) is a real load, never a click that did nothing.
		let begun: unknown;
		try {
			const f = new URL(r.url || u);
			f.hash = u.hash;
			const doc = new DOMParser().parseFromString(text, "text/html");
			// Read now: the swap moves the head's elements out of `doc`.
			const live = doc.querySelector('meta[name="natsu-live"]');
			// A nonce in the part's head is the real one, and Natsu-Nonce lists the
			// ones the server vouched for. Those read "" (as a live element shows its
			// hidden nonce, so the merge sees an unchanged one as unchanged) and
			// carry the boot nonce, the only one the CSP takes, if they go in; any
			// other nonce goes.
			const vouched = (head.get("natsu-nonce") || "").split(" ");
			for (const e of doc.head.querySelectorAll<HTMLElement>("[nonce]")) {
				const v = e.getAttribute("nonce");
				if (v && vouched.includes(v)) e.setAttribute("nonce", ""), (e.nonce = NONCE);
				else e.removeAttribute("nonce");
			}
			// The page's scripts come from Natsu-Scripts, never from markup: each
			// entry is one tag's attributes, its src made absolute against the part.
			const scripts = (head.get("natsu-scripts") || "")
				.split(" ")
				.map((e) => new URLSearchParams(e))
				.filter((p) => p.has("src"))
				.map((p) => [new URL(p.get("src")!, f).href, p] as const);
			const now = regions(D);
			const next = regions(doc);
			// DOMParser reads a <noscript> with scripting off, as markup: the server
			// drops them, and one left (in svg, say) is refused. (A declarative
			// shadow root, which DOMParser would leave an inert <template>, the
			// server never sends: a region with one is a real load.)
			if (ids(now) != ids(next) || doc.querySelector("noscript")) {
				if (DEV)
					why(
						...(ids(now) != ids(next)
							? ["regions differ:", now.map((e) => e.id), "->", next.map((e) => e.id)]
							: ["a <noscript> in the part:", doc.querySelector("noscript")]),
					);
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
							c.nonce = l.nonce;
							adds.push(c);
						}
			const fine =
				!adds[0] ||
				(await new Promise<unknown>((y) => {
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
				}));
			if (n != seq || !fine) {
				adds.forEach((l) => l.remove());
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
				// The page's scripts, whose mounts may run from now on: a mount of any
				// other (on the shell too) goes as the regions are unmounted below.
				list = scripts.map((s) => s[0]);
				fire("before-swap", { url: f.href });
				// From here the runtime restores this document's scroll, so the
				// browser must not: on the entry left, and on the entries after it.
				HI.scrollRestoration = "manual";
				// The entry left keeps its scroll and its page (unless it is not the
				// one on screen: a Back on its way); the one shown gets a new page.
				h || away || put(ys.get(cur));
				page = ++id;
				// An entry replaced (one reached by back/forward too) keeps its id;
				// one with no state of ours (a script wrote it) is given one.
				cur = (h && st()?.id) || ++id;
				h ? put(undefined, f.href) : HI.pushState({ natsu: { id: cur, p: page } }, "", f.href);
				away = 0;
				rendered = bare(f);
				// The head: what is in both stays, what went away goes, what is new comes in.
				const incoming = new Map<string, Element>();
				for (const e of doc.head.children) if (!e.matches("script," + SHEET)) incoming.set(e.outerHTML, e);
				for (const e of owned) {
					if (e.matches(SHEET) ? keep.includes(href(e)) : incoming.delete(e.outerHTML)) continue;
					// A lazy half that the page's own loader linked goes with its sheet.
					D.head.querySelector(`link[href="${e.getAttribute(LATER)}"]`)?.remove();
					e.remove();
					owned.delete(e);
				}
				for (const e of [...adds, ...incoming.values()]) owned.add(e);
				D.head.append(...incoming.values());
				// Focus inside a region going out: refresh() gives it back to its namesake.
				const was = D.activeElement;
				const fid = now.some((el) => el.contains(was)) && was!.id;
				now.forEach((el, i) => {
					unmount(el);
					el.replaceWith(next[i]!);
				});
				// A refused form: what the visitor typed is put back.
				r.status == 422 && o.k?.();
				const s = o.scroll;
				if (s == "keep") fid && D.getElementById(fid)?.focus(QUIET);
				else {
					const t = anchor(f);
					// A y (back/forward), else the hash target, else the top.
					t && s == null ? t.scrollIntoView(INSTANT) : go(+s! || 0);
					const pick = (sel: string) => next.map((e) => e.querySelector<HTMLElement>(sel)).find((e) => e);
					const auto = pick("[autofocus]");
					const el = auto || pick("h1") || (next[0] as HTMLElement);
					auto || el.hasAttribute("tabindex") || (el.tabIndex = -1);
					el.focus(QUIET);
					status!.textContent = D.title;
				}
			};
			if (
				(H.hasAttribute("data-natsu-transition") || META!.hasAttribute("data-transition")) &&
				D.startViewTransition &&
				!D.hidden &&
				!matchMedia("(prefers-reduced-motion: reduce)").matches
			)
				await D.startViewTransition(swap).updateCallbackDone;
			else swap();
			if (n != seq) return;
			idle();
			// Kept for Back and Forward. Not an action's answer, and not a page
			// with live data, which may change while it is not watched.
			if (!o.a && r.status == 200 && !live) {
				kept.set(bare(f), { t, p: Promise.resolve(a) });
				trim(kept);
			}

			// Mounts allowed here (in the shell too: one a page that did not list
			// its script stopped), then the scripts this document has not run (one
			// a loader added before the visit began has run), in order: one a
			// visit before this one created and that still loads is waited for.
			mountIn(D.body);
			// Read again: a script a loader added since the visit began (a mount just now, say) is not created twice.
			unbound();
			await Promise.all(
				scripts.map(
					([src, p]) =>
						(made[src] ||=
							loaded.has(src) ||
							new Promise((y) => {
							const c = D.createElement("script");
							// One the server vouched for gets the boot nonce; any other is left
							// to the page's CSP, exactly as on a full load.
							p.forEach((v, k) => (k == "nonce" ? (c.nonce = NONCE) : c.setAttribute(k, v)));
							// Out of the count until it has run: a visit that starts first (Back,
							// pressed at once) must not take it for one that never called mount.
							aware.add(c);
							c.async = false;
							// One the browser never runs (nomodule, a consent-gated type) fires no event.
							runs(c) ? (c.onload = c.onerror = () => y(aware.delete(c))) : y(0);
							D.body.append(c);
							})),
				),
			);
			if (n != seq) return;
			// A script that never called mount (a new one waiting for
			// DOMContentLoaded, say, which never comes again) left this page
			// unbound: load it for real, which runs it as it expects.
			if (unbound()) {
				if (DEV) why([...listed].filter(blind), "never called natsu.mount (call it at the top level of the script, or tag it data-natsu-once)");
				return L.reload();
			}
			fire("load", { url: f.href, regions: next });
		} catch (e) {
			if (begun) throw e;
			if (DEV) why("the part could not be read:", e);
			full(u, h);
		}
	};

	api.visit = visit;
	api.refresh = () => visit(L.href, { history: "replace", scroll: "keep" });
	act = (u, body, k) => (clear(), visit(L.href, { history: "replace", scroll: "keep", k, a: send(u, body, KEY).then(async (r): Promise<Answer> => [r, await r.text()]) }));
	api.prefetch = prefetch;
}
// Last, so that a runtime added after load boots with all of the above set up.
if (!first) {
	// Noted as the runtime runs too: a deferred script may take its tag out before DOMContentLoaded.
	unbound();
	D.addEventListener("DOMContentLoaded", boot);
	on("load", boot);
	if (D.readyState == "complete") boot();
}
