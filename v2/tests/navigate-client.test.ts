/**
 * The page-switching runtime (`src/client/navigate.ts`) in happy-dom.
 *
 * Each test opens a fresh happy-dom window, writes a page into it, runs the
 * runtime as the browser would run the injected `<script defer>` (with
 * `document.currentScript` pointing at its tag), then runs the page's own
 * scripts and fires DOMContentLoaded. `fetch` answers from a table of parts
 * written in the server's wire format, and `location.assign`, `replace`
 * and `reload` only record what a real load would have been.
 *
 * Page scripts are plain functions keyed by their src (an inline one by
 * `#id`): the harness runs one when its tag runs (at boot, after the
 * runtime, or when the runtime appends it), with `document.currentScript`
 * set, which is how `natsu.mount` learns who is calling; a module script
 * runs with none, as in a browser. A tag with no function is a script that
 * never calls `mount`.
 *
 * happy-dom fires `load` on stylesheets and scripts synchronously, and has
 * no layout, fonts or view transitions: the real-browser half is
 * `navigate.e2e.ts`.
 */

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { brotliCompressSync, constants } from "node:zlib";
import { Window } from "happy-dom";
import HistoryItemList from "happy-dom/lib/history/HistoryItemList.js";
import type { NatsuClient, NatsuLoadDetail, NatsuVisitOptions } from "../src/client/types.ts";

// happy-dom's replaceState drops the entries after the current one; a
// browser keeps them, and back/forward tests need them.
HistoryItemList.prototype.replace = function (this: { items: unknown[]; currentItem: unknown }, item: unknown) {
	this.items[this.items.indexOf(this.currentItem)] = item;
	this.currentItem = item;
};

const ENTRY = new URL("../src/client/navigate.ts", import.meta.url).pathname;
const ORIGIN = "https://shop.test";

/** The runtime as it ships: one classic script, minified. */
async function build(dev: boolean): Promise<string> {
	const out = await Bun.build({ entrypoints: [ENTRY], format: "iife", minify: true, define: { NATSU_DEV: String(dev) } });
	if (!out.success) throw new AggregateError(out.logs, "navigate.ts did not build");
	return out.outputs[0]!.text();
}

let CODE = "";
let DEV_CODE = "";
beforeAll(async () => {
	CODE = await build(false);
	DEV_CODE = await build(true);
});

// --- pages and answers --------------------------------------------------

const LINKS = `<a id="to-b" href="/b">B</a><a id="to-c" href="/c">C</a>`;

interface PageInit {
	title?: string;
	head?: string;
	sheet?: string;
	shell?: string;
	main?: string;
	foot?: string;
	scripts?: string[];
	key?: string;
}

/** A full page as the server sends it, with the runtime injected before </head>. */
const page = (o: PageInit = {}) =>
	`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${o.title ?? "A"}</title>` +
	`<link rel="stylesheet" href="${o.sheet ?? "/_a/site.a.css"}">${o.head ?? ""}` +
	(o.key === "" ? "" : `<meta name="natsu" content="${o.key ?? "k1.s1"}">`) +
	`<script src="/_a/natsu.js" nonce="N0NCE" defer></script></head><body>` +
	`<header id="hdr">${o.shell ?? LINKS}</header>` +
	`<main id="main" data-natsu-region>${o.main ?? "<h1>Page A</h1>"}</main>` +
	`<footer id="foot" data-natsu-region>${o.foot ?? "footer A"}</footer>` +
	(o.scripts ?? []).map((s) => `<script src="${s}" nonce="N0NCE" defer></script>`).join("") +
	`</body></html>`;

interface PartInit {
	title?: string;
	head?: string;
	sheet?: string;
	main?: string;
	foot?: string;
	regions?: string;
	/** Natsu-Scripts entries: a bare src is a vouched `<script src defer>`; anything with `=` is sent as written. */
	scripts?: string[];
	/** Natsu-Nonce. */
	nonces?: string;
}

interface Part {
	body: string;
	headers: Record<string, string>;
}

/** One Natsu-Scripts entry, as the server writes a `<script src defer>` carrying the response's nonce. */
const entry = (src: string) => (src.includes("=") ? src : new URLSearchParams({ src, defer: "", nonce: "" }).toString());

/** A part: the page's head without scripts and its regions; the scripts and the vouched nonces go in headers. */
const part = (o: PartInit = {}): Part => ({
	body:
		`<!doctype html><html><head><meta charset="utf-8"><title>${o.title ?? "B"}</title>` +
		`<link rel="stylesheet" href="${o.sheet ?? "/_a/site.a.css"}">${o.head ?? ""}<meta name="natsu" content="k1.s1"></head><body>` +
		(o.regions ??
			`<main id="main" data-natsu-region>${o.main ?? "<h1>Page B</h1>"}</main><footer id="foot" data-natsu-region>${o.foot ?? "footer B"}</footer>`) +
		`</body></html>`,
	headers: {
		...(o.scripts && { "natsu-scripts": o.scripts.map(entry).join(" ") }),
		...(o.nonces && { "natsu-nonce": o.nonces }),
	},
});

const answer = (p: Part, status = 200) =>
	new Response(p.body, { status, headers: { "content-type": "text/html; charset=utf-8", "natsu-part": "1", ...p.headers } });
const control = (headers: Record<string, string>) => new Response(null, { status: 204, headers });

// --- the harness ----------------------------------------------------------

type W = any; // happy-dom's Window, used as a browser window
type Route = (headers: Record<string, string>) => Response | Promise<Response>;
type PageScript = (w: W, el: Element) => void;

interface Open {
	html: string;
	url?: string;
	routes?: Record<string, Route>;
	scripts?: Record<string, PageScript>;
	/** Fire DOMContentLoaded after the page scripts (default true). */
	ready?: boolean;
	dev?: boolean;
	/** Stylesheet hrefs that fail, or never load. */
	failCss?: string[];
	holdCss?: string[];
	/** Script srcs the runtime appends that stay loading until `release`d. */
	holdJs?: string[];
	/** Runs on the window before the runtime does: history state, stubs. */
	before?: (window: W) => void;
}

interface Opened {
	window: W;
	document: W;
	natsu: NatsuClient;
	/** Requests made through fetch, as "path?query" with their headers (and a POST's method and body). */
	calls: { url: string; headers: Record<string, string>; method?: string; body?: string }[];
	/** Real loads: ["assign", url], ["replace", url], ["reload"]. */
	loads: string[][];
	/** Errors the runtime reported (a mount that threw). */
	errors: unknown[];
	/** Wait until every prefetch asked so far has been answered and taken in (not a fixed time: a loaded machine is slow). */
	prefetched(): Promise<void>;
	/** Let a held stylesheet (`holdCss`) or script (`holdJs`) finish loading. */
	release(href: string): void;
	ready(): void;
	/** Dispatch a click; true when the runtime took it (prevented its default). */
	click(target: string | Element, init?: Record<string, unknown>, native?: boolean): boolean;
	submit(form: string, submitter?: string): boolean;
	scroll(y: number): void;
}

const windows: W[] = [];
afterEach(async () => {
	for (const w of windows.splice(0)) await w.happyDOM.close();
});

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
/** Let a visit run to its end: fetch, parse, stylesheets, swap, scripts. */
const settle = () => tick(15);
/** Wait until `done` holds (two seconds at most), for what a loaded machine may take longer than `settle` to do. */
const until = async (done: () => unknown) => {
	for (let i = 0; i < 400 && !done(); i++) await tick(5);
};

function open(o: Open): Opened {
	const window: W = new Window({
		url: o.url ?? `${ORIGIN}/a`,
		width: 1280,
		height: 800,
		settings: {
			disableJavaScriptFileLoading: true,
			disableCSSFileLoading: true,
			handleDisabledFileLoadingAsSuccess: true,
			navigation: { disableMainFrameNavigation: true },
		},
	} as never);
	windows.push(window);
	// happy-dom outside its own VM leaves the language's builtins unset on the window.
	for (const name of ["Map", "Set", "WeakMap", "Promise", "Date", "JSON", "Array", "Object", "Number", "String", "RegExp", "Error", "TypeError", "Math", "decodeURIComponent", "reportError"])
		if (window[name] === undefined) window[name] = (globalThis as W)[name];
	const errors: unknown[] = [];
	window.reportError = (e: unknown) => void errors.push(e);
	const document = window.document;
	document.write(o.html);
	const held = new Set([...(o.holdCss ?? []), ...(o.holdJs ?? [])]);
	const calls: Opened["calls"] = [];
	let prefetching = 0;
	const loads: string[][] = [];
	Object.defineProperty(window.location, "assign", { value: (u: string) => loads.push(["assign", String(u)]) });
	Object.defineProperty(window.location, "replace", { value: (u: string) => loads.push(["replace", String(u)]) });
	Object.defineProperty(window.location, "reload", { value: () => loads.push(["reload"]) });
	window.fetch = async (input: string, init: { headers?: Record<string, string>; method?: string; body?: unknown } = {}) => {
		const url = new URL(String(input), window.location.href);
		const headers = { ...init.headers };
		const post = init.method && init.method !== "GET";
		calls.push({ url: url.pathname + url.search, headers, ...(post ? { method: init.method, body: String(init.body) } : {}) });
		const route = o.routes?.[(post ? `${init.method} ` : "") + url.pathname + url.search];
		const answer = () => (route ? route(headers) : new Response("not found", { status: 404, headers: { "content-type": "text/plain" } }));
		if (!headers["Natsu-Prefetch"]) return answer();
		// A prefetch is over once the runtime has read its body and, a task later, settled its own chain.
		prefetching++;
		const over = () => void setTimeout(() => prefetching--);
		try {
			const r = await answer();
			const read = r.text.bind(r);
			r.text = () => read().finally(over);
			return r;
		} catch (e) {
			over();
			throw e;
		}
	};

	let current: Element | null = null;
	Object.defineProperty(document, "currentScript", { get: () => current, configurable: true });
	const runAs = (el: Element, fn: () => void) => {
		current = el;
		try {
			fn();
		} finally {
			current = null;
		}
	};
	const script = (el: Element) => {
		const fn = o.scripts?.[el.getAttribute("src") ?? `#${el.id}`];
		if (fn) runAs(el.getAttribute("type") === "module" ? null! : el, () => fn(window, el));
	};
	// Scripts the runtime appends: run in the capture phase of their (synchronous) load event.
	document.addEventListener(
		"load",
		(e: Event) => {
			const t = e.target as Element;
			if (t.localName === "script" && !t.hasAttribute("data-booted")) {
				if (held.has(t.getAttribute("src") ?? "")) return e.stopImmediatePropagation();
				script(t);
			}
			if (t.localName === "link") {
				const href = t.getAttribute("href") ?? "";
				if (o.failCss?.includes(href) || held.has(href)) {
					e.stopImmediatePropagation();
					if (o.failCss?.includes(href)) queueMicrotask(() => t.dispatchEvent(new window.Event("error")));
				}
			}
		},
		true,
	);
	for (const s of document.scripts) s.setAttribute("data-booted", "");
	// What the browser does after parsing: the deferred runtime, then the page's deferred scripts in order.
	const runtime = document.querySelector('script[src="/_a/natsu.js"]');
	if (runtime) runtime.nonce = "N0NCE";
	o.before?.(window);
	runAs(runtime, () => new Function("window", `with (window) {${o.dev ? DEV_CODE : CODE}}`)(window));
	for (const s of document.scripts) if (s !== runtime) script(s);

	const opened: Opened = {
		window,
		document,
		get natsu() {
			return window.natsu;
		},
		calls,
		loads,
		errors,
		async prefetched() {
			for (let i = 0; i < 400 && prefetching; i++) await tick(5);
			await tick();
		},
		release(href) {
			held.delete(href);
			document.querySelector(`link[href="${href}"], script[src="${href}"]`)?.dispatchEvent(new window.Event("load"));
		},
		ready: () => document.dispatchEvent(new window.Event("DOMContentLoaded")),
		click(target, init = {}, native = false) {
			const el = typeof target === "string" ? document.querySelector(target) : target;
			const e = new window.MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init });
			// After the runtime's listener: note its answer, then keep happy-dom
			// from following a link the runtime left alone.
			let taken = false;
			const stop = (ev: Event) => {
				taken = ev.defaultPrevented;
				if (!native) ev.preventDefault();
			};
			window.addEventListener("click", stop, { once: true });
			el.dispatchEvent(e);
			return taken;
		},
		submit(form, submitter) {
			const f = document.querySelector(form);
			const e = new window.SubmitEvent("submit", {
				bubbles: true,
				cancelable: true,
				submitter: submitter ? document.querySelector(submitter) : null,
			});
			let taken = false;
			const stop = (ev: Event) => {
				taken = ev.defaultPrevented;
				ev.preventDefault();
			};
			window.addEventListener("submit", stop, { once: true });
			f.dispatchEvent(e);
			return taken;
		},
		scroll(y) {
			window.scrollTo(0, y);
			window.dispatchEvent(new window.Event("scroll"));
		},
	};
	if (o.ready !== false) opened.ready();
	return opened;
}

const text = (p: Opened, sel: string) => p.document.querySelector(sel)?.textContent;
const path = (p: Opened) => p.window.location.pathname + p.window.location.search + p.window.location.hash;

/**
 * A same-page hash link, followed as a browser follows it: the jump moves
 * the page at once, popstate comes (with no state), and the scroll event
 * comes before it or after. happy-dom only pushes the entry.
 */
function jump(p: Opened, sel: string, y: number, eventFirst = false) {
	p.click(sel, {}, true);
	p.window.scrollTo(0, y);
	const scrolled = () => p.window.dispatchEvent(new p.window.Event("scroll"));
	if (eventFirst) scrolled();
	p.window.dispatchEvent(new p.window.PopStateEvent("popstate", { state: null }));
	if (!eventFirst) scrolled();
}

// --- tests ------------------------------------------------------------------

describe("boot", () => {
	test("a page with a key and a region is live: a click swaps the regions and keeps the shell", async () => {
		const p = open({ html: page(), routes: { "/b": () => answer(part()) } });
		const header = p.document.getElementById("hdr");
		expect(p.click("#to-b")).toBe(true);
		await settle();
		expect(p.calls).toEqual([{ url: "/b", headers: { "Natsu-Nav": "k1.s1" } }]);
		expect(p.loads).toEqual([]);
		expect(text(p, "main h1")).toBe("Page B");
		expect(text(p, "#foot")).toBe("footer B");
		expect(p.document.getElementById("hdr")).toBe(header);
		expect(path(p)).toBe("/b");
		expect(p.document.title).toBe("B");
	});

	test("the runtime on the page twice: the second copy stays out, and its tag does not make swaps unsafe", async () => {
		let api: W;
		const seen: string[] = [];
		const p = open({
			html: page({ scripts: ["/js/natsu-again.js"] }),
			scripts: {
				"/js/natsu-again.js": (w) => {
					api = w.natsu;
					new Function("window", `with (window) {${CODE}}`)(w);
				},
			},
			routes: { "/b": () => answer(part()) },
			before: (w) => w.document.addEventListener("natsu:load", (e: W) => void seen.push(e.detail.url)),
		});
		expect(p.natsu).toBe(api);
		expect(p.document.querySelectorAll("[role=status]").length).toBe(1);
		expect(seen).toEqual([`${ORIGIN}/a`]);
		expect(p.click("#to-b")).toBe(true);
		await settle();
		expect(p.calls.map((c) => c.url)).toEqual(["/b"]);
		expect(p.loads).toEqual([]);
		expect(text(p, "main h1")).toBe("Page B");
	});

	test("no key, or no region: inert; visit is location.assign and mount still runs", async () => {
		const mounted: string[] = [];
		const p = open({
			html: page({ key: "" }),
			scripts: { "/js/a.js": (w) => w.natsu.mount("h1", (el: Element) => void mounted.push(el.textContent!)) },
			routes: { "/b": () => answer(part()) },
		});
		await p.natsu.visit("/b");
		expect(p.loads).toEqual([["assign", "/b"]]);
		expect(p.calls).toEqual([]);
		expect(p.click("#to-b")).toBe(false);

		const q = open({
			html: page({ scripts: ["/js/a.js"] }).replaceAll(" data-natsu-region", ""),
			scripts: { "/js/a.js": (w) => w.natsu.mount("h1", (el: Element) => void mounted.push(el.textContent!)) },
		});
		await q.natsu.visit("/b");
		expect(q.loads).toEqual([["assign", "/b"]]);
		expect(mounted).toEqual(["Page A"]);
	});

	test("a click before DOMContentLoaded is a real load", async () => {
		const p = open({ html: page(), routes: { "/b": () => answer(part()) }, ready: false });
		expect(p.click("#to-b")).toBe(true);
		await settle();
		expect(p.loads).toEqual([["assign", `${ORIGIN}/b`]]);
		expect(p.calls).toEqual([]);
		p.ready();
		p.click("#to-b");
		await settle();
		expect(p.calls.length).toBe(1);
		expect(path(p)).toBe("/b");
	});

	test("natsu:load fires once at boot, on document, with the URL and the regions", () => {
		const p = open({ html: page(), ready: false });
		const seen: unknown[] = [];
		p.document.addEventListener("natsu:load", (e: W) => seen.push([e.target === p.document, e.detail.url, e.detail.regions.map((r: Element) => r.id)]));
		p.ready();
		p.window.dispatchEvent(new p.window.Event("load"));
		expect(seen).toEqual([[true, `${ORIGIN}/a`, ["main", "foot"]]]);
	});

	test("the entry gets an id and a page number; scroll restoration is the browser's until a swap makes the entries manual", async () => {
		const p = open({ html: page(), routes: { "/a": () => answer(part({ title: "A" })), "/b": () => answer(part()) } });
		expect(p.window.history.scrollRestoration).toBe("auto");
		const s = p.window.history.state.natsu;
		expect([typeof s.id, typeof s.p]).toEqual(["number", "number"]);
		p.click("#to-b");
		await settle();
		expect(p.window.history.scrollRestoration).toBe("manual");
		expect(p.window.history.state.natsu.p).not.toBe(s.p);
		// The entry left was made manual before the push.
		p.window.history.back();
		await settle();
		expect(path(p)).toBe("/a");
		expect(p.window.history.scrollRestoration).toBe("manual");
	});
});

describe("which clicks", () => {
	const shell =
		LINKS +
		`<a id="blank" href="/b" target="_blank">x</a><a id="dl" href="/b" download>x</a>` +
		`<a id="ext" href="https://else.test/b">x</a><a id="feed" href="/feed.xml">x</a><a id="html" href="/b.html">x</a>` +
		`<a id="hash" href="#top">x</a><a id="hash2" href="/a#top">x</a><a id="mail" href="mailto:a@b.c">x</a>` +
		`<div data-natsu-reload><a id="reload" href="/b">x</a><p data-natsu-reload="false"><a id="again" href="/b">x</a></p></div>` +
		`<svg><a id="svg" href="/b"><text>x</text></a></svg><a id="self" href="/b" target="_self"><span id="inner">x</span></a>` +
		`<div contenteditable="true"><a id="edit" href="/b">x</a></div>`;
	const routes = { "/b": () => answer(part()), "/b.html": () => answer(part()) };

	test("left alone: modifiers, other buttons, targets, downloads, other origins, files, anchors, data-natsu-reload, SVG links, a link in an editor", async () => {
		const p = open({ html: page({ shell }), routes });
		const ignored: [string, Record<string, unknown>?][] = [
			["#to-b", { ctrlKey: true }],
			["#to-b", { metaKey: true }],
			["#to-b", { shiftKey: true }],
			["#to-b", { altKey: true }],
			["#to-b", { button: 1 }],
			["#blank"],
			["#dl"],
			["#ext"],
			["#feed"],
			["#hash"],
			["#hash2"],
			["#mail"],
			["#reload"],
			["#svg"],
			// A click there places the caret.
			["#edit"],
		];
		for (const [sel, init] of ignored) expect([sel, p.click(sel, init)]).toEqual([sel, false]);
		await settle();
		expect(p.calls).toEqual([]);
		expect(p.loads).toEqual([]);
	});

	test("taken: target=_self, a click on a child, .html, data-natsu-reload=\"false\" inside", async () => {
		const p = open({ html: page({ shell }), routes });
		for (const sel of ["#inner", "#html", "#again"]) {
			expect(p.click(sel)).toBe(true);
			await settle();
		}
		expect(p.calls.map((c) => c.url)).toEqual(["/b", "/b.html", "/b"]);
	});

	test("a document listener that called preventDefault wins", async () => {
		const p = open({ html: page(), routes });
		p.document.addEventListener("click", (e: Event) => e.preventDefault());
		p.click("#to-b");
		await settle();
		expect(p.calls).toEqual([]);
	});

	test("a <base target> other than _self leaves links and forms to the browser; a target=_self of their own wins", async () => {
		const head = `<base target="_blank">`;
		const p = open({
			html: page({
				head,
				shell: LINKS + `<a id="self" href="/b" target="_self">x</a><form id="f" action="/b"></form><form id="fs" action="/c" target="_self"></form>`,
			}),
			routes: { "/b": () => answer(part({ head })), "/c": () => answer(part({ head, title: "C" })) },
		});
		expect(p.click("#to-b")).toBe(false);
		expect(p.submit("#f")).toBe(false);
		await settle();
		expect(p.calls).toEqual([]);
		expect(p.click("#self")).toBe(true);
		await settle();
		expect(path(p)).toBe("/b");
		expect(p.submit("#fs")).toBe(true);
		await settle();
		expect([path(p), p.document.title]).toEqual(["/c", "C"]);
	});

	test("a link to the page shown replaces the entry rather than pushing one", async () => {
		const p = open({ html: page({ shell: `<a id="me" href="/a">A</a>` }), routes: { "/a": () => answer(part()) } });
		const length = p.window.history.length;
		p.click("#me");
		await settle();
		expect(p.calls.map((c) => c.url)).toEqual(["/a"]);
		expect(p.window.history.length).toBe(length);
	});

	test("the target comes from the first <base> that has one, as the browser reads it: a later <base target=_blank> still opens a new tab", async () => {
		const head = `<base href="/"><base target="_blank">`;
		const p = open({
			html: page({ head, shell: LINKS + `<form id="f" action="/b"></form>` }),
			routes: { "/b": () => answer(part({ head })) },
		});
		// Chromium opens /b in a new tab for both and leaves this one on /a.
		expect([p.click("#to-b"), p.submit("#f")]).toEqual([false, false]);
		await settle();
		expect(p.calls).toEqual([]);
	});
});

describe("GET forms", () => {
	const shell =
		`<form id="get" action="/search"><input name="q" value="tea cup"><button id="go" name="sort" value="new">go</button>` +
		`<button id="other" formaction="/other" name="x" value="1">o</button><button id="blank" formtarget="_blank">b</button>` +
		`<button id="post" formmethod="post">p</button></form>` +
		`<form id="post-form" method="post" action="/search"><input name="q" value="x"></form>` +
		`<form id="here"><input name="q" value="1"></form>` +
		`<form id="off" action="/search" data-natsu-reload><input name="q" value="1"></form>`;
	const routes = {
		"/search?q=tea+cup&sort=new": () => answer(part({ title: "Search" })),
		"/other?q=tea+cup&x=1": () => answer(part({ title: "Other" })),
		"/search?q=tea+cup": () => answer(part({ title: "Plain" })),
		"/a?q=1": () => answer(part({ title: "Here" })),
	};

	test("the query is built from the form and its submitter; formaction is honoured", async () => {
		const p = open({ html: page({ shell }), routes });
		expect(p.submit("#get", "#go")).toBe(true);
		await settle();
		expect(path(p)).toBe("/search?q=tea+cup&sort=new");
		expect(p.document.title).toBe("Search");
		p.submit("#get", "#other");
		await settle();
		expect(path(p)).toBe("/other?q=tea+cup&x=1");
		p.submit("#get");
		await settle();
		expect(path(p)).toBe("/search?q=tea+cup");
	});

	test("a file field sends its file's name, as the browser does in a query", async () => {
		const p = open({
			html: page({ shell: `<form id="up" action="/search"><input name="q" value="x"><input type="file" name="photo"><input type="file" name="none"></form>` }),
			routes: { "/search?q=x&photo=cat+1.jpg&none=": () => answer(part({ title: "Found" })) },
		});
		p.document.querySelector('input[name="photo"]').files = [new p.window.File(["meow"], "cat 1.jpg")];
		p.submit("#up");
		await settle();
		expect(path(p)).toBe("/search?q=x&photo=cat+1.jpg&none=");
		expect(p.document.title).toBe("Found");
	});

	test("a form with no action goes to the page's own URL", async () => {
		const p = open({ html: page({ shell }), routes });
		p.submit("#here");
		await settle();
		expect(path(p)).toBe("/a?q=1");
	});

	test("a click on the submit button with Ctrl, Shift, Meta or Alt leaves the submission to the browser (a new tab, a window)", async () => {
		const p = open({ html: page({ shell: LINKS + shell }), routes });
		for (const key of ["ctrlKey", "shiftKey", "metaKey", "altKey"]) {
			p.click("#go", { [key]: true });
			expect([key, p.submit("#get", "#go")]).toEqual([key, false]);
		}
		// A link opened in a new tab is no reason to leave a later submit (Enter in the field) alone.
		p.click("#to-b", { ctrlKey: true });
		expect(p.submit("#get")).toBe(true);
		await settle();
		p.click("#go");
		expect(p.submit("#get", "#go")).toBe(true);
		await settle();
		expect(p.calls.map((c) => c.url)).toEqual(["/search?q=tea+cup", "/search?q=tea+cup&sort=new"]);
	});

	test("a line break goes as CRLF, as the browser sends it in a query", async () => {
		const p = open({
			html: page({ shell: `<form id="note" action="/note"><textarea name="t">a\nb</textarea><input type="hidden" name="h" value="x"></form>` }),
			routes: { "/note?t=a%0D%0Ab&h=c%0D%0Ad%0D%0Ae": () => answer(part({ title: "Note" })) },
		});
		// Set by a script: a CRLF already there stays one.
		p.document.querySelector('input[name="h"]').value = "c\r\nd\ne";
		p.submit("#note");
		await settle();
		expect([path(p), p.document.title]).toEqual(["/note?t=a%0D%0Ab&h=c%0D%0Ad%0D%0Ae", "Note"]);
	});

	test("an accept-charset other than UTF-8 is the browser's: the query would be in that encoding", async () => {
		const p = open({
			html: page({
				shell:
					`<form id="latin" action="/search" accept-charset="ISO-8859-1"><input name="q" value="café"></form>` +
					`<form id="utf" action="/search" accept-charset="UTF-8"><input name="q" value="tea cup"></form>`,
			}),
			routes,
		});
		expect(p.submit("#latin")).toBe(false);
		expect(p.submit("#utf")).toBe(true);
		await settle();
		expect(p.document.title).toBe("Plain");
	});

	test("left alone: POST, formmethod=post, formtarget, data-natsu-reload, a listener that prevented it", async () => {
		const p = open({ html: page({ shell }), routes });
		expect(p.submit("#post-form")).toBe(false);
		expect(p.submit("#get", "#post")).toBe(false);
		expect(p.submit("#get", "#blank")).toBe(false);
		expect(p.submit("#off")).toBe(false);
		p.document.addEventListener("submit", (e: Event) => e.preventDefault(), { once: true });
		p.submit("#get", "#go");
		await settle();
		expect(p.calls).toEqual([]);
	});

	test("a form with no action goes to the page's own URL, not the <base href>, as the browser sends it", async () => {
		const p = open({
			url: `${ORIGIN}/shop/list`,
			html: page({ head: `<base href="/shop/">`, shell: LINKS + `<form id="filter"><input name="q" value="x"></form>` }),
			routes: { "/shop/list?q=x": () => answer(part({ title: "Filtered", head: `<base href="/shop/">` })), "/shop/?q=x": () => answer(part({ title: "Shop home", head: `<base href="/shop/">` })) },
		});
		expect(p.submit("#filter")).toBe(true);
		await settle();
		// Chromium: http://host/shop/list?q=x (the form's action is the document's URL when it has none).
		expect([path(p), p.document.title]).toEqual(["/shop/list?q=x", "Filtered"]);
	});

	test("a GET form with no field to send goes to its action with an empty query, as the browser does: a new entry", async () => {
		const p = open({
			url: `${ORIGIN}/search`,
			html: page({ shell: LINKS + `<form id="all" action="/search"><button id="show">Show all</button></form>` }),
			routes: { "/search?": () => answer(part({ title: "All" })), "/search": () => answer(part({ title: "All" })) },
		});
		const length = p.window.history.length;
		expect(p.submit("#all", "#show")).toBe(true);
		await settle();
		// Chromium: http://host/search? (pushed: it is not the URL shown).
		expect([p.window.location.href, p.window.history.length]).toEqual([`${ORIGIN}/search?`, length + 1]);
	});
});

describe("head", () => {
	test("merged by outerHTML: canonical added then removed, description replaced, third-party nodes and the key kept", async () => {
		const p = open({
			html: page({ head: `<meta name="description" content="about A">` }),
			routes: {
				"/b": () => answer(part({ head: `<meta name="description" content="about B"><link rel="canonical" href="/b">` })),
				"/c": () => answer(part({ title: "C", head: `<meta name="description" content="about B">` })),
			},
		});
		const key = p.document.querySelector('meta[name="natsu"]');
		const charset = p.document.querySelector("meta[charset]");
		// What a third party adds after load: never the merge's to remove.
		const ad = p.document.createElement("style");
		ad.id = "third-party";
		p.document.head.append(ad);
		p.document.documentElement.setAttribute("data-theme", "dark");
		p.click("#to-b");
		await settle();
		const metas = () => [...p.document.querySelectorAll('meta[name="description"]')].map((m: W) => m.content);
		expect(metas()).toEqual(["about B"]);
		expect(p.document.querySelector('link[rel="canonical"]')?.getAttribute("href")).toBe("/b");
		expect(p.document.querySelector('meta[name="natsu"]')).toBe(key);
		expect(p.document.querySelector("meta[charset]")).toBe(charset);
		expect(p.document.getElementById("third-party")).toBe(ad);
		expect(p.document.documentElement.getAttribute("data-theme")).toBe("dark");
		expect(p.document.querySelectorAll("title").length).toBe(1);
		p.click("#to-c");
		await settle();
		expect(p.document.querySelector('link[rel="canonical"]')).toBeNull();
		expect(metas()).toEqual(["about B"]);
		expect(p.document.title).toBe("C");
		expect(p.document.getElementById("third-party")).toBe(ad);
	});

	test("a nonce Natsu-Nonce vouches for gets the boot nonce on a new element; an unchanged one stays; any other nonce goes", async () => {
		// A browser shows a live element's nonce as "" (it hides it); the part carries the real one.
		const p = open({
			html: page({ head: `<style nonce="">.shell{}</style>` }),
			routes: {
				"/b": () =>
					answer(
						part({
							head:
								`<style nonce="r1">.shell{}</style><style nonce="r2">.b{}</style><style>.plain{}</style>` +
								`<style nonce="forged">.forged{}</style><style nonce="">.bare{}</style><link rel="preload" as="font" href="/f.woff2" nonce="r1">`,
							nonces: "r1 r2",
						}),
					),
				"/c": () => answer(part({ title: "C", head: `<style nonce="r1">.c{}</style>` })),
			},
		});
		const shell = p.document.querySelector("head style");
		p.click("#to-b");
		await settle();
		let styles = [...p.document.head.querySelectorAll("style")] as W[];
		expect(styles.map((s) => s.textContent)).toEqual([".shell{}", ".b{}", ".plain{}", ".forged{}", ".bare{}"]);
		expect(styles[0]).toBe(shell);
		expect(styles.map((s) => [s.getAttribute("nonce"), s.nonce || ""])).toEqual([
			["", ""],
			["", "N0NCE"],
			[null, ""],
			[null, ""],
			[null, ""],
		]);
		const preload = p.document.querySelector('link[rel="preload"]');
		expect([preload.getAttribute("nonce"), preload.nonce]).toEqual(["", "N0NCE"]);
		// No Natsu-Nonce: nothing is vouched for, whatever the markup says.
		p.click("#to-c");
		await settle();
		styles = [...p.document.head.querySelectorAll("style")] as W[];
		expect(styles.map((s) => [s.textContent, s.getAttribute("nonce"), s.nonce || ""])).toEqual([[".c{}", null, ""]]);
	});

	test("scripts in either head are never touched", async () => {
		const p = open({
			html: page({ head: `<script src="/js/head.js" defer></script>` }),
			scripts: { "/js/head.js": (w) => w.natsu.mount("x", () => {}) },
			routes: { "/b": () => answer(part({ head: `<script src="/js/other-head.js"></script>` })) },
		});
		p.click("#to-b");
		await settle();
		const srcs = [...p.document.head.querySelectorAll("script")].map((s: W) => s.getAttribute("src"));
		expect(srcs).toEqual(["/js/head.js", "/_a/natsu.js"]);
		expect(p.loads).toEqual([]);
	});
});

describe("stylesheets", () => {
	const sheets = (p: Opened) => [...p.document.querySelectorAll('link[rel="stylesheet"]')].map((l: W) => l.getAttribute("href"));

	test("the new sheet goes in before the old one and loads before the swap; the old one goes at the swap", async () => {
		const p = open({ html: page(), routes: { "/b": () => answer(part({ sheet: "/_a/site.b.css" })) }, holdCss: ["/_a/site.b.css"] });
		p.click("#to-b");
		await settle();
		// Held: both linked, new first, and the page on screen not swapped yet.
		expect(sheets(p)).toEqual(["/_a/site.b.css", "/_a/site.a.css"]);
		expect(text(p, "main h1")).toBe("Page A");
		expect(path(p)).toBe("/a");
		p.release("/_a/site.b.css");
		await settle();
		expect(sheets(p)).toEqual(["/_a/site.b.css"]);
		expect(text(p, "main h1")).toBe("Page B");
	});

	test("a sheet already parsed as it goes in (the memory cache's) swaps without waiting for its load event", async () => {
		const p = open({ html: page(), routes: { "/b": () => answer(part({ sheet: "/_a/site.b.css" })) }, holdCss: ["/_a/site.b.css", "/_a/site.c.css"] });
		// What Chromium shows for a cached sheet: its rules readable the moment the link is in.
		// One still loading has none (or, in Firefox, rules that throw when read).
		Object.defineProperty(p.window.HTMLLinkElement.prototype, "sheet", {
			configurable: true,
			get(this: Element) {
				const href = this.getAttribute("href");
				if (href === "/_a/site.b.css") return { cssRules: [] };
				if (href === "/_a/site.c.css") return { get cssRules(): never { throw new Error("InvalidAccessError") } };
				return null;
			},
		});
		p.click("#to-b");
		await settle();
		expect(text(p, "main h1")).toBe("Page B");
		expect(sheets(p)).toEqual(["/_a/site.b.css"]);
	});

	test("a sheet whose rules cannot be read yet is waited for", async () => {
		const p = open({ html: page(), routes: { "/c": () => answer(part({ title: "C", main: "<h1>Page C</h1>", sheet: "/_a/site.c.css" })) }, holdCss: ["/_a/site.c.css"] });
		Object.defineProperty(p.window.HTMLLinkElement.prototype, "sheet", {
			configurable: true,
			get(this: Element) {
				return this.getAttribute("href") === "/_a/site.c.css" ? { get cssRules(): never { throw new Error("InvalidAccessError") } } : null;
			},
		});
		p.click("#to-c");
		await settle();
		expect(text(p, "main h1")).toBe("Page A");
		p.release("/_a/site.c.css");
		await settle();
		expect(text(p, "main h1")).toBe("Page C");
	});

	test("the same sheet on both pages: nothing changes", async () => {
		const p = open({ html: page(), routes: { "/b": () => answer(part()) } });
		const link = p.document.querySelector('link[rel="stylesheet"]');
		p.click("#to-b");
		await settle();
		expect(p.document.querySelector('link[rel="stylesheet"]')).toBe(link);
	});

	test("a sheet that fails means a real load, with the new link removed and the page untouched", async () => {
		const p = open({ html: page(), routes: { "/b": () => answer(part({ sheet: "/_a/site.b.css" })) }, failCss: ["/_a/site.b.css"] });
		p.click("#to-b");
		await settle();
		expect(p.loads).toEqual([["assign", `${ORIGIN}/b`]]);
		expect(sheets(p)).toEqual(["/_a/site.a.css"]);
		expect(text(p, "main h1")).toBe("Page A");
	});

	test(
		"a sheet that never loads is given up after 4 s: a real load",
		async () => {
			const p = open({ html: page(), routes: { "/b": () => answer(part({ sheet: "/_a/site.b.css" })) }, holdCss: ["/_a/site.b.css"] });
			p.click("#to-b");
			await settle();
			const link = p.document.querySelector('link[href="/_a/site.b.css"]');
			await tick(3800);
			expect(p.loads).toEqual([]);
			await tick(400);
			expect(p.loads).toEqual([["assign", `${ORIGIN}/b`]]);
			expect(sheets(p)).toEqual(["/_a/site.a.css"]);
			// Given up on, the link keeps no handler that would hold the visit.
			expect([link.onload, link.onerror]).toEqual([null, null]);
		},
		{ timeout: 8000 },
	);

	test("a lazy half loads with its sheet, before the swap; the old page's lazy half goes with the old sheet", async () => {
		const p = open({
			html: page({ sheet: "/_a/site.a.css" }).replace(
				`href="/_a/site.a.css">`,
				`href="/_a/site.a.css" data-natsu-later="/_a/site-later.a.css">`,
			),
			routes: {
				"/b": () => {
					const p = part({ sheet: "/_a/site.b.css" });
					return answer({ ...p, body: p.body.replace(`href="/_a/site.b.css">`, `href="/_a/site.b.css" data-natsu-later="/_a/site-later.b.css">`) });
				},
			},
			holdCss: ["/_a/site-later.b.css"],
		});
		// The page's own lazy loader linked its half after first input.
		const half = p.document.createElement("link");
		half.rel = "stylesheet";
		half.href = "/_a/site-later.a.css";
		p.document.querySelector('link[href="/_a/site.a.css"]').after(half);
		p.click("#to-b");
		await settle();
		expect(sheets(p)).toEqual(["/_a/site.b.css", "/_a/site-later.b.css", "/_a/site.a.css", "/_a/site-later.a.css"]);
		expect(text(p, "main h1")).toBe("Page A");
		p.release("/_a/site-later.b.css");
		await settle();
		expect(sheets(p)).toEqual(["/_a/site.b.css", "/_a/site-later.b.css"]);
		expect(text(p, "main h1")).toBe("Page B");
	});

	test("once the wait settles (load or error) no handler stays on the links, and the 4 s timer is cleared", async () => {
		const p = open({
			html: page(),
			routes: {
				"/b": () => answer(part({ sheet: "/_a/site.b.css" })),
				"/c": () => answer(part({ title: "C", sheet: "/_a/site.c.css" })),
			},
			failCss: ["/_a/site.c.css"],
		});
		const added: W[] = [];
		new p.window.MutationObserver((records: W[]) => {
			for (const r of records) for (const n of r.addedNodes) if (n.localName === "link") added.push(n);
		}).observe(p.document.head, { childList: true });
		const pending = new Set<unknown>();
		const set = p.window.setTimeout;
		const clear = p.window.clearTimeout;
		p.window.setTimeout = (fn: () => void, ms: number) => {
			const t = set.call(p.window, fn, ms);
			if (ms === 4e3) pending.add(t);
			return t;
		};
		p.window.clearTimeout = (t: unknown) => (pending.delete(t), clear.call(p.window, t));
		p.click("#to-b");
		await settle();
		expect(text(p, "main h1")).toBe("Page B");
		p.click("#to-c");
		await settle();
		expect(p.loads).toEqual([["assign", `${ORIGIN}/c`]]);
		expect(added.map((l) => l.getAttribute("href"))).toEqual(["/_a/site.b.css", "/_a/site.c.css"]);
		expect(added.map((l) => [l.onload, l.onerror])).toEqual([
			[null, null],
			[null, null],
		]);
		expect(pending.size).toBe(0);
	});

	test("a visit overtaken while its sheet loads leaves nothing behind", async () => {
		const p = open({
			html: page(),
			routes: { "/b": () => answer(part({ sheet: "/_a/site.b.css" })), "/c": () => answer(part({ title: "C", main: "<h1>Page C</h1>" })) },
			holdCss: ["/_a/site.b.css"],
		});
		p.click("#to-b");
		await settle();
		p.click("#to-c");
		await settle();
		p.release("/_a/site.b.css");
		await settle();
		expect(text(p, "main h1")).toBe("Page C");
		expect(sheets(p)).toEqual(["/_a/site.a.css"]);
		expect(path(p)).toBe("/c");
	});
});

describe("regions", () => {
	test("a <noscript> left in the part (the server drops them) means a real load: DOMParser reads its content as markup", async () => {
		const p = open({
			html: page(),
			routes: {
				"/b": () =>
					answer(
						part({
							main: `<h1>B</h1><div data-ad-spot></div><noscript><style>[data-ad-spot],[data-ad-wrap]{display:none}</style></noscript>`,
						}),
					),
			},
		});
		p.click("#to-b");
		await settle();
		expect(p.loads).toEqual([["assign", `${ORIGIN}/b`]]);
		expect(text(p, "main h1")).toBe("Page A");
		expect(p.document.querySelectorAll("noscript, style").length).toBe(0);
	});

	test("region ids that differ from the current ones, or in another order, mean a real load", async () => {
		const p = open({
			html: page(),
			routes: {
				"/b": () => answer(part({ regions: `<main id="main" data-natsu-region>B</main>` })),
				"/c": () => answer(part({ regions: `<footer id="foot" data-natsu-region>F</footer><main id="main" data-natsu-region>C</main>` })),
			},
		});
		p.click("#to-b");
		await settle();
		p.click("#to-c");
		await settle();
		expect(p.loads).toEqual([
			["assign", `${ORIGIN}/b`],
			["assign", `${ORIGIN}/c`],
		]);
		expect(text(p, "main h1")).toBe("Page A");
	});

	test("a part that cannot be read is a real load, never a dead click: DOMParser under Trusted Types, a bad script entry", async () => {
		const p = open({
			html: page(),
			routes: { "/b": () => answer(part()), "/c": () => answer(part({ scripts: ["src=http%3A%2F%2F%5B"] })) },
		});
		const parse = p.window.DOMParser.prototype.parseFromString;
		// What `require-trusted-types-for 'script'` does to a string handed to DOMParser.
		p.window.DOMParser.prototype.parseFromString = () => {
			throw new TypeError("This document requires 'TrustedHTML' assignment.");
		};
		expect(p.click("#to-b")).toBe(true);
		await settle();
		p.window.DOMParser.prototype.parseFromString = parse;
		p.click("#to-c");
		await settle();
		expect(p.loads).toEqual([
			["assign", `${ORIGIN}/b`],
			["assign", `${ORIGIN}/c`],
		]);
		expect(text(p, "main h1")).toBe("Page A");
		expect(path(p)).toBe("/a");
	});

	test("an inline script in a swapped-in region never runs", async () => {
		const p = open({
			html: page(),
			routes: { "/b": () => answer(part({ main: `<h1>B</h1><script>window.ran = 1</script><script type="application/ld+json">{"a":1}</script>` })) },
		});
		p.window.ran = 0;
		p.click("#to-b");
		await settle();
		expect(p.window.ran).toBe(0);
		expect(p.document.querySelector('main script[type="application/ld+json"]')).not.toBeNull();
	});
});

describe("answers", () => {
	test("every Natsu-Reload reason is a real load of the URL asked for", async () => {
		const reasons = ["route", "document", "shell", "regions", "response", "inline-script"];
		const routes: Record<string, Route> = {};
		for (const r of reasons) routes[`/${r}`] = () => control({ "natsu-reload": r });
		const p = open({ html: page(), routes });
		for (const r of reasons) {
			await p.natsu.visit(`/${r}`);
		}
		expect(p.loads).toEqual(reasons.map((r) => ["assign", `${ORIGIN}/${r}`]));
		expect(text(p, "main h1")).toBe("Page A");
	});

	test("anything that is not a part is a real load: a plain page, a JSON body, a network error", async () => {
		const p = open({
			html: page(),
			routes: {
				"/plain": () => new Response("<!doctype html><p>hi", { headers: { "content-type": "text/html" } }),
				"/json": () => new Response("{}", { headers: { "content-type": "application/json" } }),
				"/down": () => Promise.reject(new TypeError("Failed to fetch")),
			},
		});
		await p.natsu.visit("/plain");
		await p.natsu.visit("/json");
		await p.natsu.visit("/down");
		expect(p.loads.map((l) => l[1])).toEqual([`${ORIGIN}/plain`, `${ORIGIN}/json`, `${ORIGIN}/down`]);
	});

	test("a part keeps the page's own status: a 404 page swaps in", async () => {
		const p = open({ html: page(), routes: { "/gone": () => answer(part({ title: "Not found", main: "<h1>404</h1>" }), 404) } });
		await p.natsu.visit("/gone");
		expect(text(p, "main h1")).toBe("404");
		expect(p.loads).toEqual([]);
	});

	test("Natsu-Location: a same-origin target is visited, keeping the hash; the final URL is pushed", async () => {
		const p = open({
			html: page(),
			routes: {
				"/old": () => control({ "natsu-location": `${ORIGIN}/new` }),
				"/new": () => answer(part({ title: "New" })),
			},
		});
		const length = p.window.history.length;
		await p.natsu.visit("/old#top");
		expect(p.calls.map((c) => c.url)).toEqual(["/old", "/new"]);
		expect(path(p)).toBe("/new#top");
		expect(p.document.title).toBe("New");
		expect(p.window.history.length).toBe(length + 1);
	});

	test("Natsu-Location to another origin is a real load of that URL, never the first one again", async () => {
		const p = open({ html: page(), routes: { "/docs": () => control({ "natsu-location": "https://docs.test/" }) } });
		await p.natsu.visit("/docs");
		expect(p.loads).toEqual([["assign", "https://docs.test/"]]);
	});

	test("five hops at most: the sixth is a real load", async () => {
		const routes: Record<string, Route> = {};
		for (let i = 0; i < 10; i++) routes[`/r${i}`] = () => control({ "natsu-location": `${ORIGIN}/r${i + 1}` });
		const p = open({ html: page(), routes });
		await p.natsu.visit("/r0");
		expect(p.calls.map((c) => c.url)).toEqual(["/r0", "/r1", "/r2", "/r3", "/r4", "/r5"]);
		expect(p.loads).toEqual([["assign", `${ORIGIN}/r6`]]);
	});

	test("a visit to another origin is a real load", async () => {
		const p = open({ html: page() });
		await p.natsu.visit("https://else.test/x");
		expect(p.loads).toEqual([["assign", "https://else.test/x"]]);
		expect(p.calls).toEqual([]);
	});

	test("a superseded visit is ignored", async () => {
		let release!: () => void;
		const p = open({
			html: page(),
			routes: {
				"/b": () => new Promise((y) => (release = () => y(answer(part({ title: "Slow" }))))),
				"/c": () => answer(part({ title: "C", main: "<h1>Page C</h1>" })),
			},
		});
		p.click("#to-b");
		await settle();
		p.click("#to-c");
		await settle();
		release();
		await settle();
		expect(p.document.title).toBe("C");
		expect(path(p)).toBe("/c");
		expect(p.loads).toEqual([]);
	});
});

describe("mounts and scripts", () => {
	test("mount runs now, on regions swapped in, and aborts and cleans up on swap-out; the shell is mounted once", async () => {
		const log: string[] = [];
		const p = open({
			html: page({ scripts: ["/js/clock.js"], main: `<h1>A</h1><b data-clock>a</b>`, shell: LINKS + `<b data-clock>shell</b>` }),
			scripts: {
				"/js/clock.js": (w) =>
					w.natsu.mount("[data-clock]", (el: Element, signal: AbortSignal) => {
						log.push(`mount ${el.textContent}`);
						signal.addEventListener("abort", () => log.push(`abort ${el.textContent}`));
						return () => log.push(`cleanup ${el.textContent}`);
					}),
			},
			routes: { "/b": () => answer(part({ main: `<h1>B</h1><b data-clock>b</b>`, scripts: ["/js/clock.js"] })) },
		});
		expect(log).toEqual(["mount shell", "mount a"]);
		p.click("#to-b");
		await settle();
		expect(log).toEqual(["mount shell", "mount a", "abort a", "cleanup a", "mount b"]);
	});

	test("a mount whose element page code removed is stopped at the next swap, not kept forever", async () => {
		const log: string[] = [];
		const p = open({
			html: page({ scripts: ["/js/toast.js"], shell: LINKS + `<b data-toast>t</b>` }),
			scripts: {
				"/js/toast.js": (w) =>
					w.natsu.mount("[data-toast]", (_: Element, signal: AbortSignal) => {
						signal.addEventListener("abort", () => log.push("abort"));
						return () => log.push("cleanup");
					}),
			},
			routes: { "/b": () => answer(part({ scripts: ["/js/toast.js"] })), "/c": () => answer(part({ scripts: ["/js/toast.js"] })) },
		});
		p.document.querySelector("[data-toast]").remove();
		p.click("#to-b");
		await settle();
		expect(log).toEqual(["abort", "cleanup"]);
		p.click("#to-c");
		await settle();
		expect(log).toEqual(["abort", "cleanup"]);
	});

	test("mounts are scoped to the page's script list: two scripts on one selector, only the listed one binds", async () => {
		const log: string[] = [];
		const binder = (name: string) => (w: W) =>
			w.natsu.mount("form[data-media-upload]", (el: Element) => void log.push(`${name} ${el.id}`));
		const form = (id: string) => `<form id="${id}" data-media-upload></form>`;
		const p = open({
			html: page({ scripts: ["/js/media-upload.js"], main: form("vendor") }),
			scripts: { "/js/media-upload.js": binder("media"), "/js/staff-upload.js": binder("staff") },
			routes: {
				"/b": () => answer(part({ main: form("staff-ads"), scripts: ["/js/staff-upload.js"] })),
				"/c": () => answer(part({ main: form("listing"), scripts: ["/js/media-upload.js"] })),
			},
		});
		expect(log).toEqual(["media vendor"]);
		p.click("#to-b");
		await settle();
		expect(log).toEqual(["media vendor", "staff staff-ads"]);
		p.click("#to-c");
		await settle();
		expect(log).toEqual(["media vendor", "staff staff-ads", "media listing"]);
	});

	test("listed scripts not yet run are appended in order, with the boot nonce and async=false; run ones are not", async () => {
		const p = open({
			html: page({ scripts: ["/js/site.js"] }),
			scripts: { "/js/site.js": (w) => w.natsu.mount("x", () => {}), "/js/b.js": (w) => w.natsu.mount("x", () => {}), "/js/c.js": (w) => w.natsu.mount("x", () => {}) },
			routes: {
				"/b": () => answer(part({ scripts: ["/js/site.js", "src=%2Fjs%2Fb.js&data-x=1&crossorigin=anonymous&defer=&nonce=", "/js/c.js"] })),
			},
		});
		p.click("#to-b");
		await settle();
		const added = [...p.document.querySelectorAll("body > script:not([data-booted])")] as W[];
		expect(added.map((s) => s.getAttribute("src"))).toEqual(["/js/b.js", "/js/c.js"]);
		expect(added.map((s) => [s.nonce, s.async])).toEqual([
			["N0NCE", false],
			["N0NCE", false],
		]);
		expect([...added[0].attributes].map((a: W) => a.name)).toEqual(["src", "data-x", "crossorigin", "defer"]);
		expect(added[0].getAttribute("data-x")).toBe("1");
		expect(added[0].getAttribute("crossorigin")).toBe("anonymous");
		expect(added[0].getAttribute("nonce")).toBeNull();
		expect(p.document.querySelectorAll('script[src="/js/site.js"]').length).toBe(1);
	});

	test("scripts come only from Natsu-Scripts: a script in the part's markup is never created", async () => {
		const p = open({
			html: page(),
			scripts: { "/js/b.js": (w) => w.natsu.mount("x", () => {}) },
			routes: {
				"/b": () => {
					const q = part({ main: `<h1>B</h1><script src="/js/in-region.js"></script>`, scripts: ["/js/b.js"] });
					return answer({ ...q, body: q.body.replace("</body>", `<script src="/js/evil.js" defer></script></body>`) });
				},
			},
		});
		p.click("#to-b");
		await settle();
		expect(text(p, "main h1")).toBe("B");
		expect([...p.document.querySelectorAll("body > script:not([data-booted])")].map((s: W) => s.getAttribute("src"))).toEqual(["/js/b.js"]);
		expect(p.document.querySelector('script[src="/js/evil.js"]')).toBeNull();
		// The one in the region (the server refuses such a part) is inert, never calls mount: the page loads for real.
		expect(p.loads).toEqual([["reload"]]);
	});

	test("an entry without the nonce key is created without one; a src is resolved against the part's URL", async () => {
		const log: string[] = [];
		const p = open({
			html: page(),
			scripts: {
				"rel.js": (w) => w.natsu.mount("[data-rel]", (el: Element) => void log.push(el.textContent!)),
				"/js/plain.js": (w) => w.natsu.mount("x", () => {}),
			},
			routes: {
				"/shop/b": () => answer(part({ main: `<h1>B</h1><p data-rel>b</p>`, scripts: ["src=rel.js", "src=%2Fjs%2Fplain.js&async="] })),
				"/shop/c": () => answer(part({ main: `<h1>C</h1><p data-rel>c</p>`, scripts: ["src=rel.js"] })),
			},
		});
		await p.natsu.visit("/shop/b");
		const added = [...p.document.querySelectorAll("body > script:not([data-booted])")] as W[];
		expect(added.map((s) => [s.getAttribute("src"), s.nonce || "", s.hasAttribute("nonce"), s.async])).toEqual([
			["rel.js", "", false, false],
			["/js/plain.js", "", false, false],
		]);
		// Listed as /shop/rel.js: its mount runs on this page and the next, and it is never created twice.
		await p.natsu.visit("/shop/c");
		expect(log).toEqual(["b", "c"]);
		expect(p.document.querySelectorAll('script[src="rel.js"]').length).toBe(1);
		expect(p.loads).toEqual([]);
	});

	test("an unconverted script makes the next click a real load; data-natsu-once does not", async () => {
		const p = open({ html: page({ scripts: ["/js/legacy.js"] }), routes: { "/b": () => answer(part()) } });
		p.click("#to-b");
		await settle();
		expect(p.loads).toEqual([["assign", `${ORIGIN}/b`]]);
		expect(p.calls).toEqual([]);

		const q = open({
			html: page({ scripts: ["/js/legacy.js"] }).replace(`src="/js/legacy.js"`, `src="/js/legacy.js" data-natsu-once`),
			routes: { "/b": () => answer(part()) },
		});
		q.click("#to-b");
		await settle();
		expect(q.loads).toEqual([]);
		expect(path(q)).toBe("/b");
	});

	test("a script a loader added after boot counts too, from the next visit on; tagged data-natsu-once, it does not", async () => {
		for (const once of [false, true]) {
			const p = open({ html: page(), routes: { "/b": () => answer(part()) } });
			const s = p.document.createElement("script");
			s.src = "/js/chat.js";
			if (once) s.setAttribute("data-natsu-once", "");
			p.document.body.append(s);
			p.click("#to-b");
			await settle();
			expect([once, p.loads, path(p)]).toEqual(once ? [once, [], "/b"] : [once, [["assign", `${ORIGIN}/b`]], "/a"]);
		}
	});

	test("a script added at run time is never created again by a page that lists it", async () => {
		let ran = 0;
		const p = open({
			html: page(),
			scripts: { "/js/chat.js": (w) => (ran++, w.natsu.mount("x", () => {})) },
			routes: { "/b": () => answer(part({ scripts: ["/js/chat.js"] })) },
		});
		const s = p.document.createElement("script");
		s.src = "/js/chat.js";
		p.document.body.append(s);
		await p.natsu.visit("/b");
		expect([ran, p.document.querySelectorAll('script[src="/js/chat.js"]').length, p.loads]).toEqual([1, 1, []]);
	});

	test("a script that ran and that page code took out since still counts, and is never created again", async () => {
		const p = open({ html: page({ scripts: ["/js/legacy.js"] }), routes: { "/b": () => answer(part()) } });
		p.document.querySelector('script[src="/js/legacy.js"]').remove();
		p.click("#to-b");
		await settle();
		expect(p.loads).toEqual([["assign", `${ORIGIN}/b`]]);
		let ran = 0;
		const q = open({
			html: page({ scripts: ["/js/site.js"] }),
			scripts: { "/js/site.js": (w) => (ran++, w.natsu.mount("x", () => {})) },
			routes: { "/b": () => answer(part({ scripts: ["/js/site.js"] })) },
		});
		q.document.querySelector('script[src="/js/site.js"]').remove();
		await q.natsu.visit("/b");
		expect([ran, q.loads, path(q)]).toEqual([1, [], "/b"]);
	});

	/** An Error whose stack names `src` as the caller, past the runtime's own frame, as a browser's does. */
	const stackFrom = (src: string) => (w: W) => {
		// A plain function, which works with `new` and without (the minifier drops it).
		w.Error = function () {
			return { stack: `Error\n    at Object.mount (${ORIGIN}/_a/natsu.js:1:2000)\n    at ${ORIGIN}${src}:3:7` };
		};
	};

	test("a script that calls mount later (not while it runs) is known by the stack; with no stack naming it, it is unconverted", async () => {
		const late = { "/js/late.js": (w: W) => w.document.addEventListener("DOMContentLoaded", () => w.natsu.mount("x", () => {})) };
		const routes = { "/b": () => answer(part()) };
		const p = open({ html: page({ scripts: ["/js/late.js"] }), scripts: late, routes });
		await p.natsu.visit("/b");
		expect(p.loads).toEqual([["assign", `${ORIGIN}/b`]]);
		const q = open({ html: page({ scripts: ["/js/late.js"] }), scripts: late, routes, before: stackFrom("/js/late.js") });
		await q.natsu.visit("/b");
		expect(q.loads).toEqual([]);
		expect(path(q)).toBe("/b");
	});

	test("every script that runs counts: head defer and async, module, inline", async () => {
		const kinds: PageInit[] = [
			{ head: `<script src="/js/x.js" defer></script>` },
			{ head: `<script src="/js/x.js" async></script>` },
			{ head: `<script type="module">import "/js/x.js";</script>` },
			{ shell: LINKS + `<script type="module" src="/js/x.js"></script>` },
			{ shell: LINKS + `<script>document.querySelectorAll("main a").forEach(bind);</script>` },
			{ shell: LINKS + `<script type="text/javascript">bind();</script>` },
		];
		for (const kind of kinds) {
			const p = open({ html: page(kind), routes: { "/b": () => answer(part()) } });
			await p.natsu.visit("/b");
			expect([kind, p.loads]).toEqual([kind, [["assign", `${ORIGIN}/b`]]]);
		}
	});

	test("not counted: data blocks, templates, nomodule, a classic head script that blocks the parser, data-natsu-once", async () => {
		const p = open({
			html: page({
				head:
					`<script>window.config = {};</script><script src="/js/blocking.js"></script><script defer>window.inline = 1;</script>` +
					`<script type="application/ld+json">{}</script><script type="importmap">{"imports":{}}</script><script type="speculationrules">{}</script>`,
				shell:
					LINKS +
					`<script type="text/x-template"><b>{{x}}</b></script><script type="application/json">{}</script>` +
					`<script nomodule src="/js/old-browsers.js"></script><script type="module" src="/js/mod.js" data-natsu-once></script>`,
			}),
			routes: { "/b": () => answer(part()) },
		});
		await p.natsu.visit("/b");
		expect(p.loads).toEqual([]);
		expect(path(p)).toBe("/b");
	});

	test("an inline script that calls mount while it runs is swap-safe, and its mounts go everywhere", async () => {
		const log: string[] = [];
		const p = open({
			html: page({ shell: LINKS + `<script id="inline">natsu.mount("h1", …)</script>` }),
			scripts: {
				"#inline": (w) => w.natsu.mount("h1", (el: Element) => void log.push(el.textContent!)),
				"/js/b.js": (w) => w.natsu.mount("x", () => {}),
			},
			routes: { "/b": () => answer(part({ scripts: ["/js/b.js"] })) },
		});
		await p.natsu.visit("/b");
		expect(p.loads).toEqual([]);
		expect(log).toEqual(["Page A", "Page B"]);
	});

	test("a module script is known by the stack: swap-safe once it mounts, its mounts scoped to the pages that list it", async () => {
		const log: string[] = [];
		const p = open({
			html: page({ main: `<h1>A</h1><p data-m>a</p>`, shell: LINKS + `<script type="module" src="/js/mod.js"></script>` }),
			scripts: { "/js/mod.js": (w) => w.natsu.mount("[data-m]", (el: Element) => void log.push(el.textContent!)) },
			routes: {
				"/b": () => answer(part({ main: `<h1>B</h1><p data-m>b</p>`, scripts: ["src=%2Fjs%2Fmod.js&type=module&nonce="] })),
				"/c": () => answer(part({ main: `<h1>C</h1><p data-m>c</p>` })),
			},
			before: stackFrom("/js/mod.js"),
		});
		await p.natsu.visit("/b");
		await p.natsu.visit("/c");
		expect(p.loads).toEqual([]);
		expect(log).toEqual(["a", "b"]);
	});

	test("a page swapped in whose new script never called mount is loaded for real, with no natsu:load: the script may wait for DOMContentLoaded, which never comes again", async () => {
		const seen: string[] = [];
		const routes = {
			"/b": () => answer(part({ scripts: ["/js/legacy.js"] })),
			"/c": () => answer(part({ title: "C", scripts: ["src=%2Fjs%2Flegacy.js&defer=&nonce=&data-natsu-once="] })),
		};
		const scripts = { "/js/legacy.js": (w: W) => w.document.addEventListener("DOMContentLoaded", () => w.natsu.mount("x", () => {})) };
		const before = (w: W) => w.document.addEventListener("natsu:load", (e: W) => void seen.push(e.detail.url));
		const p = open({ html: page(), routes, scripts, before });
		p.click("#to-b");
		await settle();
		expect([path(p), text(p, "main h1")]).toEqual(["/b", "Page B"]);
		expect(p.loads).toEqual([["reload"]]);
		expect(seen).toEqual([`${ORIGIN}/a`]);
		// Were the reload not to happen, the next visit would be a real load all the same.
		p.click("#to-c");
		await settle();
		expect(p.loads).toEqual([["reload"], ["assign", `${ORIGIN}/c`]]);
		// Tagged data-natsu-once, it needs no mount.
		const q = open({ html: page(), routes, scripts });
		await q.natsu.visit("/c");
		expect([path(q), q.loads]).toEqual(["/c", []]);
	});

	test("a script a swap appended counts once it has run: Back while it still loads stays a swap; if it then never calls mount, the next visit is a real load", async () => {
		for (const converted of [false, true]) {
			const seen: string[] = [];
			const p = open({
				html: page(),
				holdJs: ["/js/b.js"],
				scripts: { "/js/b.js": (w) => converted && w.natsu.mount("x", () => {}) },
				routes: {
					"/a": () => answer(part({ title: "A", main: "<h1>Page A</h1>" })),
					"/b": () => answer(part({ scripts: ["/js/b.js"] })),
					"/c": () => answer(part({ title: "C", main: "<h1>Page C</h1>" })),
				},
				before: (w: W) => w.document.addEventListener("natsu:load", (e: W) => void seen.push(e.detail.url)),
			});
			p.click("#to-b");
			await settle();
			expect(text(p, "main h1")).toBe("Page B");
			// Back at once, /js/b.js still loading: a swap, not a real load; B's natsu:load never comes.
			p.window.history.back();
			await settle();
			expect([path(p), text(p, "main h1"), p.loads]).toEqual(["/a", "Page A", []]);
			expect(seen).toEqual([`${ORIGIN}/a`, `${ORIGIN}/a`]);
			// It runs now, on A. Once it has run it counts like any other.
			p.release("/js/b.js");
			await settle();
			expect(p.loads).toEqual([]);
			p.click("#to-c");
			await settle();
			expect(p.loads).toEqual(converted ? [] : [["assign", `${ORIGIN}/c`]]);
			if (converted) expect(text(p, "main h1")).toBe("Page C");
		}
	});

	test("a nomodule script, or one of a type the browser does not run (one a consent manager enables), is neither waited for nor counted", async () => {
		const seen: string[] = [];
		const p = open({
			html: page(),
			routes: {
				"/b": () => answer(part({ scripts: ["src=%2Fjs%2Fold.js&nomodule=&defer=&nonce=", "src=%2Fjs%2Fads.js&type=text%2Fplain&data-category=ads&nonce="] })),
				"/a": () => answer(part({ title: "A", main: "<h1>Page A</h1>" })),
			},
			before: (w) => w.document.addEventListener("natsu:load", (e: W) => void seen.push(e.detail.url)),
		});
		// happy-dom, as a browser, fires no load for a script of another type: waiting for it would never end.
		await p.natsu.visit("/b");
		expect(seen).toEqual([`${ORIGIN}/a`, `${ORIGIN}/b`]);
		expect(p.loads).toEqual([]);
		// Both are on the page, for the page's own code to act on.
		expect([...p.document.querySelectorAll("body > script:not([data-booted])")].map((s: W) => s.getAttribute("src"))).toEqual(["/js/old.js", "/js/ads.js"]);
		await p.natsu.visit("/a");
		expect([path(p), p.loads]).toEqual(["/a", []]);
	});

	test("a visit overtaken while its scripts load fires no natsu:load", async () => {
		const seen: string[] = [];
		const p = open({
			html: page(),
			scripts: {
				// Page code that moves on as it runs: the visit to B is over before its scripts are.
				"/js/b.js": (w) => (w.natsu.mount("x", () => {}), w.natsu.visit("/c")),
			},
			routes: { "/b": () => answer(part({ scripts: ["/js/b.js"] })), "/c": () => answer(part({ title: "C", main: "<h1>Page C</h1>" })) },
			before: (w) => w.document.addEventListener("natsu:load", (e: W) => void seen.push(e.detail.url)),
		});
		await p.natsu.visit("/b");
		await settle();
		expect([path(p), text(p, "main h1")]).toEqual(["/c", "Page C"]);
		expect(seen).toEqual([`${ORIGIN}/a`, `${ORIGIN}/c`]);
	});

	test("a mount that throws is reported and does not stop the others", async () => {
		const seen: string[] = [];
		const p = open({
			html: page({ scripts: ["/js/a.js"], main: "<i>1</i><i>2</i>" }),
			scripts: {
				"/js/a.js": (w) =>
					w.natsu.mount("i", (el: Element) => {
						if (el.textContent === "1") throw new Error("boom");
						seen.push(el.textContent!);
					}),
			},
		});
		expect(seen).toEqual(["2"]);
		expect(p.errors.map((e) => (e as Error).message)).toEqual(["boom"]);
	});

	test("a deferred script that takes its tag out before DOMContentLoaded still counts, and is never created again", async () => {
		// Unconverted: the next visit must be a real load, as for any script that never called mount.
		const p = open({
			html: page({ scripts: ["/js/legacy.js"] }),
			scripts: { "/js/legacy.js": (_w, el) => el.remove() },
			routes: { "/b": () => answer(part()) },
		});
		p.click("#to-b");
		await settle();
		// Converted: a page that lists it must not run it a second time (nor mount it twice).
		let ran = 0;
		const log: string[] = [];
		const q = open({
			html: page({ scripts: ["/js/site.js"], main: "<h1>A</h1><b data-x>a</b>" }),
			scripts: {
				"/js/site.js": (w, el) => {
					ran++;
					w.natsu.mount("[data-x]", (e: Element) => void log.push(e.textContent!));
					el.remove();
				},
			},
			routes: { "/b": () => answer(part({ main: "<h1>B</h1><b data-x>b</b>", scripts: ["/js/site.js"] })) },
		});
		await q.natsu.visit("/b");
		expect([p.loads, path(p), ran, log]).toEqual([[["assign", `${ORIGIN}/b`]], "/a", 1, ["a", "b"]]);
	});

	test("a visit that overtakes one whose script still loads, to a page listing that script: it waits for it, and reloads if it never calls mount", async () => {
		const seen: string[] = [];
		const p = open({
			html: page(),
			holdJs: ["/js/legacy.js"],
			scripts: { "/js/legacy.js": (w) => w.document.addEventListener("DOMContentLoaded", () => w.natsu.mount("x", () => {})) },
			routes: {
				"/b": () => answer(part({ scripts: ["/js/legacy.js"] })),
				"/c": () => answer(part({ title: "C", main: "<h1>Page C</h1>", scripts: ["/js/legacy.js"] })),
			},
			before: (w) => w.document.addEventListener("natsu:load", (e: W) => void seen.push(e.detail.url)),
		});
		p.click("#to-b");
		await settle();
		p.click("#to-c");
		await settle();
		expect([path(p), text(p, "main h1")]).toEqual(["/c", "Page C"]);
		const early = [...seen];
		p.release("/js/legacy.js");
		await settle();
		// natsu:load of C waits for the script C lists; it ran on C and never called mount (it waits for
		// DOMContentLoaded): C is loaded for real, as B would have been.
		expect([early, p.loads]).toEqual([[`${ORIGIN}/a`], [["reload"]]]);
	});

	test("a mount that moves its element out of the region (a portal to body) is stopped when its region goes", async () => {
		const log: string[] = [];
		const p = open({
			html: page({ scripts: ["/js/modal.js"], main: `<h1>A</h1><div data-modal>m</div>` }),
			scripts: {
				"/js/modal.js": (w) =>
					w.natsu.mount("[data-modal]", (el: Element, signal: AbortSignal) => {
						w.document.body.append(el);
						signal.addEventListener("abort", () => log.push("abort"));
						return () => (log.push("cleanup"), el.remove());
					}),
			},
			routes: {
				"/b": () => answer(part({ scripts: ["/js/modal.js"] })),
				"/a": () => answer(part({ title: "A", main: `<h1>A</h1><div data-modal>m</div>`, scripts: ["/js/modal.js"] })),
			},
		});
		expect(p.document.querySelectorAll("[data-modal]").length).toBe(1);
		await p.natsu.visit("/b");
		await p.natsu.visit("/a");
		expect([p.loads, path(p)]).toEqual([[], "/a"]);
		// A full load of A has one modal; the one A's first copy moved out must not stay, with its listeners.
		expect([p.document.querySelectorAll("[data-modal]").length, log]).toEqual([1, ["abort", "cleanup"]]);
	});

	test("a page script's mount on a shell element goes when the page shown no longer lists the script", async () => {
		const log: string[] = [];
		const p = open({
			html: page({ shell: LINKS + `<input id="q">` }),
			scripts: {
				"/js/search.js": (w) =>
					w.natsu.mount("#q", (el: Element, signal: AbortSignal) => {
						el.addEventListener("input", () => log.push("live"), { signal });
					}),
			},
			routes: {
				"/b": () => answer(part({ scripts: ["/js/search.js"] })),
				"/c": () => answer(part({ title: "C", main: "<h1>Page C</h1>" })),
			},
		});
		await p.natsu.visit("/b");
		p.document.getElementById("q").dispatchEvent(new p.window.Event("input"));
		expect(log).toEqual(["live"]);
		await p.natsu.visit("/c");
		expect([p.loads, path(p)]).toEqual([[], "/c"]);
		p.document.getElementById("q").dispatchEvent(new p.window.Event("input"));
		// A full load of C has no search.js: its input has no such listener.
		expect(log).toEqual(["live"]);
	});

	test("a script a mount on the new regions adds is not created a second time by the page's own list", async () => {
		let ran = 0;
		const p = open({
			html: page({ scripts: ["/js/site.js"] }),
			scripts: {
				"/js/site.js": (w) =>
					w.natsu.mount("[data-chart]", () => {
						if (w.document.querySelector('script[src="/js/chart.js"]')) return;
						const s = w.document.createElement("script");
						s.src = "/js/chart.js";
						w.document.body.append(s);
					}),
				"/js/chart.js": (w) => (ran++, w.natsu.mount("[data-chart]", () => {})),
			},
			routes: { "/b": () => answer(part({ main: "<h1>B</h1><div data-chart></div>", scripts: ["/js/site.js", "/js/chart.js"] })) },
		});
		await p.natsu.visit("/b");
		expect([ran, p.document.querySelectorAll('script[src="/js/chart.js"]').length]).toEqual([1, 1]);
	});
});

describe("events and attributes", () => {
	test("natsu:visit can cancel; natsu:before-swap comes before the swap; natsu:load comes once, on document, after new scripts ran", async () => {
		const order: string[] = [];
		const p = open({
			html: page(),
			scripts: { "/js/b.js": (w) => (order.push("b.js ran"), w.natsu.mount("x", () => {})) },
			routes: { "/b": () => answer(part({ scripts: ["/js/b.js"] })) },
		});
		p.document.addEventListener("natsu:visit", (e: W) => e.detail.url.endsWith("/c") && e.preventDefault());
		p.document.addEventListener("natsu:before-swap", () => order.push(`before-swap ${text(p, "main h1")}`));
		p.document.addEventListener("natsu:load", (e: W) =>
			order.push(`load ${e.target === p.document} ${e.detail.url} ${e.detail.regions.map((r: Element) => r.id).join(" ")} ${e.detail.regions[0].isConnected}`),
		);
		await p.natsu.visit("/c");
		expect(p.calls).toEqual([]);
		await p.natsu.visit("/b#x");
		expect(order).toEqual(["before-swap Page A", "b.js ran", `load true ${ORIGIN}/b#x main foot true`]);
	});

	test("a cancelled natsu:visit: a click or visit() does nothing; a back/forward, whose URL already changed, reloads", async () => {
		const p = open({ html: page(), routes: { "/a": () => answer(part({ title: "A" })), "/b": () => answer(part()) } });
		await p.natsu.visit("/b");
		p.document.addEventListener("natsu:visit", (e: Event) => e.preventDefault());
		expect(p.click("#to-c")).toBe(true);
		await settle();
		p.window.history.back();
		await settle();
		expect(p.calls.map((c) => c.url)).toEqual(["/b"]);
		expect(p.loads).toEqual([["reload"]]);
	});

	test("a redirect whose target's natsu:visit is cancelled leaves no loading mark", async () => {
		const p = open({
			html: page({ shell: LINKS + `<a id="acct" href="/account">acct</a>` }),
			routes: { "/account": () => tick(350).then(() => control({ "natsu-location": `${ORIGIN}/login` })), "/login": () => answer(part({ title: "Login" })) },
		});
		// The app opens a sign-in dialog instead of visiting /login.
		p.document.addEventListener("natsu:visit", (e: W) => new URL(e.detail.url).pathname == "/login" && e.preventDefault());
		const html = p.document.documentElement;
		expect(p.click("#acct")).toBe(true);
		await tick(500);
		expect(p.calls.map((c) => c.url)).toEqual(["/account"]);
		expect(path(p)).toBe("/a");
		expect(html.hasAttribute("data-natsu-loading")).toBe(false);

		// Fast answer: the 300 ms timer must not fire after the visit ended.
		const q = open({
			html: page({ shell: LINKS + `<a id="acct" href="/account">acct</a>` }),
			routes: { "/account": () => control({ "natsu-location": `${ORIGIN}/login` }) },
		});
		q.document.addEventListener("natsu:visit", (e: W) => new URL(e.detail.url).pathname == "/login" && e.preventDefault());
		q.click("#acct");
		await tick(400);
		expect(q.document.documentElement.hasAttribute("data-natsu-loading")).toBe(false);
	});

	test("<html data-natsu-reload> makes every visit a real load: links, forms, back/forward, visit, refresh, and no prefetch", async () => {
		const p = open({
			html: page({ shell: LINKS + `<form id="f" action="/search"><input name="q" value="1"></form>` }),
			routes: { "/a": () => answer(part({ title: "A" })), "/b": () => answer(part()), "/c": () => answer(part()) },
		});
		await p.natsu.visit("/b");
		// An ad unit just showed: this document must never be swapped again.
		p.document.documentElement.setAttribute("data-natsu-reload", "");
		expect(p.click("#to-c")).toBe(false);
		expect(p.submit("#f")).toBe(false);
		p.natsu.prefetch("/c");
		await p.natsu.visit("/c");
		await p.natsu.refresh();
		p.window.history.back();
		await settle();
		expect(p.calls.map((c) => c.url)).toEqual(["/b"]);
		// refresh() is this page again: a reload, as without the runtime.
		expect(p.loads).toEqual([["assign", `${ORIGIN}/c`], ["reload"], ["reload"]]);
		// Turned off again ("false" or "off"), the document swaps.
		p.document.documentElement.setAttribute("data-natsu-reload", "off");
		expect(p.click("#to-c")).toBe(true);
		await settle();
		expect(path(p)).toBe("/c");
	});

	test("data-natsu-reload and data-natsu-prefetch: present is on, \"false\" and \"off\" are off, the nearest wins", async () => {
		const p = open({
			html: page({
				shell:
					LINKS +
					`<div data-natsu-reload="true"><a id="r1" href="/b">x</a><p data-natsu-reload="off"><a id="r2" href="/b">x</a></p></div>` +
					`<div data-natsu-prefetch="false"><a id="p1" href="/b">x</a><p data-natsu-prefetch><a id="p2" href="/c">x</a></p></div>` +
					`<a id="p3" href="/d" data-natsu-prefetch="off">x</a>`,
			}),
			routes: { "/b": () => answer(part()), "/c": () => answer(part()), "/d": () => answer(part()) },
		});
		const hover = (sel: string) =>
			p.document.querySelector(sel).dispatchEvent(new p.window.PointerEvent("pointerover", { bubbles: true, pointerType: "mouse" }));
		for (const sel of ["#p1", "#p2", "#p3"]) {
			hover(sel);
			await tick(90);
		}
		expect(p.calls.map((c) => c.url)).toEqual(["/c"]);
		expect(p.click("#r1")).toBe(false);
		expect(p.click("#r2")).toBe(true);
	});

	test("html[data-natsu-loading] appears after 150 ms and goes at the swap; the loading bar is in the body", async () => {
		let release!: () => void;
		const p = open({ html: page(), routes: { "/b": () => new Promise((y) => (release = () => y(answer(part())))) } });
		const html = p.document.documentElement;
		// One element, after the page's own, which the page's CSS may restyle or hide.
		expect(p.document.querySelectorAll("natsu-bar").length).toBe(1);
		expect(p.document.body.lastElementChild.localName).toBe("natsu-bar");
		p.click("#to-b");
		await tick(100);
		expect(html.hasAttribute("data-natsu-loading")).toBe(false);
		await tick(100);
		expect(html.hasAttribute("data-natsu-loading")).toBe(true);
		release();
		await settle();
		expect(html.hasAttribute("data-natsu-loading")).toBe(false);
	});

	test("a real load leaves no mark and no timer: one that does not leave the page (a download, a 204) must not stay marked", async () => {
		const p = open({ html: page(), routes: { "/b": () => control({ "natsu-reload": "route" }), "/c": () => tick(400).then(() => control({ "natsu-reload": "route" })) } });
		const html = p.document.documentElement;
		// Slow: marked while it waits, unmarked by the real load.
		p.click("#to-c");
		await tick(350);
		expect(html.hasAttribute("data-natsu-loading")).toBe(true);
		await tick(100);
		expect(p.loads).toEqual([["assign", `${ORIGIN}/c`]]);
		expect(html.hasAttribute("data-natsu-loading")).toBe(false);
		// Fast: a real load before 300 ms; its timer never fires.
		p.click("#to-b");
		await settle();
		expect(p.loads.length).toBe(2);
		await tick(350);
		expect(html.hasAttribute("data-natsu-loading")).toBe(false);
	});

	test("a pageshow from the back/forward cache clears the mark, and a loading timer frozen with the page", async () => {
		// A visit still waiting when the visitor left by other means: the page was frozen with it.
		const p = open({ html: page(), routes: { "/b": () => new Promise(() => {}), "/c": () => new Promise(() => {}) } });
		const html = p.document.documentElement;
		// happy-dom's PageTransitionEvent has no `persisted`.
		const show = () => p.window.dispatchEvent(Object.assign(new p.window.Event("pageshow"), { persisted: true }));
		p.click("#to-c");
		await tick(350);
		expect(html.hasAttribute("data-natsu-loading")).toBe(true);
		show();
		expect(html.hasAttribute("data-natsu-loading")).toBe(false);
		p.click("#to-b");
		await settle();
		show();
		await tick(350);
		expect(html.hasAttribute("data-natsu-loading")).toBe(false);
	});

	test("focus goes to [autofocus], else the h1, else the region; the title is read out through role=status", async () => {
		const p = open({
			html: page(),
			routes: {
				"/b": () => answer(part({ title: "Bee", main: `<h1>B</h1><input id="q" autofocus>` })),
				"/c": () => answer(part({ title: "Sea", main: `<h1 id="h">C</h1>` })),
				"/d": () => answer(part({ title: "Dee", main: `<p>no heading</p>` })),
			},
		});
		const status = p.document.querySelector('[role="status"]');
		expect(status?.parentNode).toBe(p.document.body);
		await p.natsu.visit("/b");
		expect(p.document.activeElement?.id).toBe("q");
		expect(p.document.getElementById("q").hasAttribute("tabindex")).toBe(false);
		expect(status.textContent).toBe("Bee");
		await p.natsu.visit("/c");
		expect(p.document.activeElement?.id).toBe("h");
		expect(p.document.getElementById("h").getAttribute("tabindex")).toBe("-1");
		await p.natsu.visit("/d");
		expect(p.document.activeElement?.id).toBe("main");
		expect(status.textContent).toBe("Dee");
	});

	test("view transitions only when <html data-natsu-transition> opts in", async () => {
		const p = open({ html: page(), routes: { "/b": () => answer(part()), "/c": () => answer(part({ title: "C" })) } });
		let used = 0;
		p.document.startViewTransition = (fn: () => void) => {
			used++;
			fn();
			return { updateCallbackDone: Promise.resolve() };
		};
		await p.natsu.visit("/b");
		expect(used).toBe(0);
		p.document.documentElement.setAttribute("data-natsu-transition", "");
		await p.natsu.visit("/c");
		expect(used).toBe(1);
		expect(p.document.title).toBe("C");
	});

	test("the key's data-transition (navigate.transition) turns view transitions on for every page; never under prefers-reduced-motion", async () => {
		for (const reduce of [false, true]) {
			const p = open({
				html: page().replace(`content="k1.s1">`, `content="k1.s1" data-transition>`),
				routes: { "/b": () => answer(part()) },
				before: (w) => (w.matchMedia = (q: string) => ({ matches: reduce && /reduce/.test(q) })),
			});
			let used = 0;
			p.document.startViewTransition = (fn: () => void) => {
				used++;
				fn();
				return { updateCallbackDone: Promise.resolve() };
			};
			await p.natsu.visit("/b");
			expect([reduce, used, text(p, "main h1")]).toEqual([reduce, reduce ? 0 : 1, "Page B"]);
		}
	});

	test("a visit overtaken during the transition's first frame (a second visit, a Back) swaps nothing, mounts nothing, creates no script", async () => {
		const log: string[] = [];
		const p = open({
			html: page({ scripts: ["/js/site.js"] }),
			scripts: {
				"/js/site.js": (w) => w.natsu.mount("h1", (el: Element) => void log.push(`${el.textContent} ${el.isConnected}`)),
				"/js/b.js": (w) => w.natsu.mount("x", () => {}),
			},
			routes: {
				"/b": () => answer(part({ sheet: "/_a/site.b.css", scripts: ["/js/site.js", "/js/b.js"] })),
				"/c": () => answer(part({ title: "C", main: "<h1>Page C</h1>", scripts: ["/js/site.js"] })),
			},
		});
		p.document.documentElement.setAttribute("data-natsu-transition", "");
		// The browser calls back a frame later, once it has the old state.
		const frames: (() => void)[] = [];
		p.document.startViewTransition = (fn: () => void) => {
			let done!: () => void;
			const updateCallbackDone = new Promise<void>((y) => (done = y));
			frames.push(() => (fn(), done()));
			return { updateCallbackDone };
		};
		const added = () => [...p.document.querySelectorAll("body > script:not([data-booted])")].map((s: W) => s.getAttribute("src"));
		const sheets = () => [...p.document.querySelectorAll('link[rel="stylesheet"]')].map((l: W) => l.getAttribute("href"));
		p.click("#to-b");
		await settle();
		p.click("#to-c");
		await settle();
		for (const frame of frames.splice(0)) frame();
		await settle();
		expect([p.document.title, path(p), text(p, "main h1")]).toEqual(["C", "/c", "Page C"]);
		expect(added()).toEqual([]);
		expect(sheets()).toEqual(["/_a/site.a.css"]);
		expect(log).toEqual(["Page A true", "Page C true"]);

		// Back to this page's own entry before the frame: the visit to B is over.
		const q = open({
			html: page({ main: `<h1>Page A</h1><a id="jump" href="#x">x</a><p id="x">x</p>` }),
			routes: { "/b": () => answer(part({ scripts: ["/js/b.js"] })) },
			scripts: { "/js/b.js": (w) => w.natsu.mount("x", () => {}) },
		});
		q.document.documentElement.setAttribute("data-natsu-transition", "");
		q.document.startViewTransition = p.document.startViewTransition;
		jump(q, "#jump", 500);
		q.click("#to-b");
		await settle();
		q.window.history.back();
		await settle();
		expect(frames.length).toBe(1);
		for (const frame of frames.splice(0)) frame();
		await settle();
		expect([path(q), text(q, "main h1"), q.document.title]).toEqual(["/a", "Page A", "A"]);
		expect([...q.document.querySelectorAll("body > script:not([data-booted])")].length).toBe(0);
	});

	test("visit pushes an entry by default and with history: push, and replace replaces it", async () => {
		const p = open({ html: page(), routes: { "/b": () => answer(part({ title: "B" })), "/c": () => answer(part({ title: "C" })) } });
		const length = p.window.history.length;
		await p.natsu.visit("/b", { history: "push" });
		expect(path(p)).toBe("/b");
		expect(p.window.history.length).toBe(length + 1);
		await p.natsu.visit("/c");
		expect(p.window.history.length).toBe(length + 2);
		await p.natsu.visit("/b", { history: "replace" });
		expect(path(p)).toBe("/b");
		expect(p.window.history.length).toBe(length + 2);
	});

	test("refresh replaces the entry, keeps scroll and focus, and skips the prefetch cache", async () => {
		let n = 0;
		const p = open({ html: page(), routes: { "/a": () => answer(part({ title: `A${++n}` })) } });
		p.scroll(640);
		const length = p.window.history.length;
		const focused = p.document.querySelector("#to-b");
		focused.focus();
		await p.natsu.refresh();
		expect(p.document.title).toBe("A1");
		expect(p.window.scrollY).toBe(640);
		expect(p.window.history.length).toBe(length);
		expect(p.document.activeElement).toBe(focused);
		await p.natsu.refresh();
		expect(p.document.title).toBe("A2");
	});

	test("refresh puts focus back on the element of the same id in the new region", async () => {
		const p = open({
			html: page({ main: `<h1>A</h1><input id="qty" value="1"><button id="go">go</button>` }),
			routes: { "/a": () => answer(part({ title: "A", main: `<h1>A</h1><input id="qty" value="2"><button id="go">go</button>` })) },
		});
		const old = p.document.getElementById("qty");
		old.focus();
		let scrolled = 0;
		p.window.HTMLElement.prototype.scrollIntoView = () => scrolled++;
		await p.natsu.refresh();
		const now = p.document.activeElement;
		expect(now).not.toBe(old);
		expect([now.id, now.value, scrolled]).toEqual(["qty", "2", 0]);
	});
});

describe("history", () => {
	test("A -> B -> Back -> Forward restores scroll both ways", async () => {
		const p = open({ html: page(), routes: { "/a": () => answer(part({ title: "A", main: "<h1>Page A</h1>" })), "/b": () => answer(part()) } });
		p.scroll(1200);
		p.click("#to-b");
		await settle();
		expect(p.window.scrollY).toBe(0);
		p.scroll(2000);
		p.window.history.back();
		await settle();
		expect(path(p)).toBe("/a");
		expect(text(p, "main h1")).toBe("Page A");
		expect(p.window.scrollY).toBe(1200);
		p.window.history.forward();
		await settle();
		expect(path(p)).toBe("/b");
		expect(text(p, "main h1")).toBe("Page B");
		expect(p.window.scrollY).toBe(2000);
		expect(p.loads).toEqual([]);
	});

	test("Back and Forward to a page this document swapped in reuse its part for ten seconds; a click asks again; a live page is asked again", async () => {
		const p = open({
			html: page(),
			routes: {
				"/b": () => answer(part()),
				"/c": () => answer(part({ title: "C", main: "<h1>Page C</h1>" })),
				"/live": () => answer(part({ title: "L", main: "<h1>Live</h1>", head: `<meta name="natsu-live" content="t|sig">` })),
			},
			before: (w) =>
				(w.WebSocket = class {
					send() {}
				}),
		});
		p.click("#to-b");
		await settle();
		p.click("#to-c");
		await settle();
		expect(p.calls.map((c) => c.url)).toEqual(["/b", "/c"]);
		p.window.history.back();
		await settle();
		expect([path(p), text(p, "main h1")]).toEqual(["/b", "Page B"]);
		p.window.history.forward();
		await settle();
		expect([path(p), text(p, "main h1")]).toEqual(["/c", "Page C"]);
		expect(p.calls.map((c) => c.url)).toEqual(["/b", "/c"]);
		// A click is a new visit: asked again, whatever is kept.
		p.click("#to-b");
		await settle();
		expect(p.calls.map((c) => c.url)).toEqual(["/b", "/c", "/b"]);
		// Ten seconds after /c was asked for, Back asks again.
		const D = p.window.Date;
		const now = D.now;
		try {
			const at = now();
			D.now = () => at + 10_001;
			p.window.history.back();
			await settle();
		} finally {
			D.now = now;
		}
		expect([path(p), text(p, "main h1")]).toEqual(["/c", "Page C"]);
		expect(p.calls.map((c) => c.url)).toEqual(["/b", "/c", "/b", "/c"]);
		// A page with live data is never kept: it may have changed while it was not watched.
		await p.natsu.visit("/live");
		p.window.history.back();
		await settle();
		p.window.history.forward();
		await settle();
		expect(text(p, "main h1")).toBe("Live");
		expect(p.calls.map((c) => c.url)).toEqual(["/b", "/c", "/b", "/c", "/live", "/live"]);
		expect(p.loads).toEqual([]);
	});

	test("any submit lets go of the kept parts", async () => {
		const p = open({
			html: page({ shell: LINKS + `<form id="f" action="/c"><input name="q" value="1"></form>` }),
			routes: { "/b": () => answer(part()), "/c?q=1": () => answer(part({ title: "C" })) },
		});
		p.click("#to-b");
		await settle();
		p.submit("#f");
		await settle();
		p.window.history.back();
		await settle();
		expect(text(p, "main h1")).toBe("Page B");
		expect(p.calls.map((c) => c.url)).toEqual(["/b", "/c?q=1", "/b"]);
	});

	const anchors = `<h1>Page A</h1><a id="jump" href="#results">results</a><div class="tall"></div><div id="results">r</div>`;

	test("a hash link's entry (no state) is given an id and this page's number; Back to it from another page shows the right page", async () => {
		const p = open({
			html: page({ main: anchors }),
			routes: { "/a": () => answer(part({ title: "A", main: `<h1>Page A again</h1><div id="results">r</div>` })), "/b": () => answer(part()) },
		});
		const first = p.window.history.state.natsu;
		jump(p, "#jump", 4000);
		expect(path(p)).toBe("/a#results");
		const hashed = p.window.history.state.natsu;
		expect(hashed.id).not.toBe(first.id);
		expect(hashed.p).toBe(first.p);
		expect(p.calls).toEqual([]);
		p.click("#to-b");
		await settle();
		expect(text(p, "main h1")).toBe("Page B");
		p.window.history.back();
		await settle();
		expect(path(p)).toBe("/a#results");
		expect(text(p, "main h1")).toBe("Page A again");
		expect(p.window.scrollY).toBe(4000);
		p.window.history.forward();
		await settle();
		expect(text(p, "main h1")).toBe("Page B");
	});

	test("Back and Forward across a hash link restore each entry's scroll, whether the jump's scroll event comes before popstate or after", async () => {
		for (const eventFirst of [true, false]) {
			const p = open({ html: page({ main: anchors }) });
			// What layout would do with the target.
			p.document.getElementById("results").scrollIntoView = () => p.window.scrollTo(0, 4000);
			p.scroll(300);
			jump(p, "#jump", 4000, eventFirst);
			p.scroll(4100);
			p.window.history.back();
			await settle();
			expect([eventFirst, path(p), p.window.scrollY]).toEqual([eventFirst, "/a", 300]);
			p.window.history.forward();
			await settle();
			expect([eventFirst, path(p), p.window.scrollY]).toEqual([eventFirst, "/a#results", 4100]);
			expect(p.calls).toEqual([]);
		}
	});

	test("a new hash entry with no scroll of its own goes to its target; with no target, it stays", async () => {
		const p = open({ html: page({ main: anchors + `<a id="nowhere" href="#gone">x</a>` }) });
		let aimed = 0;
		p.document.getElementById("results").scrollIntoView = () => aimed++;
		p.scroll(200);
		jump(p, "#jump", 4000);
		expect(aimed).toBe(1);
		p.click("#nowhere", {}, true);
		p.window.dispatchEvent(new p.window.PopStateEvent("popstate", { state: null }));
		expect([aimed, p.window.scrollY]).toEqual([1, 4000]);
	});

	test("Back to this page's own entry while a visit is pending cancels the visit and its loading mark", async () => {
		let release!: () => void;
		const p = open({ html: page({ main: anchors }), routes: { "/b": () => new Promise((y) => (release = () => y(answer(part())))) } });
		jump(p, "#jump", 4000);
		p.click("#to-b");
		await tick(350);
		expect(p.document.documentElement.hasAttribute("data-natsu-loading")).toBe(true);
		p.window.history.back();
		await settle();
		expect(p.document.documentElement.hasAttribute("data-natsu-loading")).toBe(false);
		release();
		await settle();
		expect(path(p)).toBe("/a");
		expect(text(p, "main h1")).toBe("Page A");
		expect(p.loads).toEqual([]);
	});

	test("an entry a script rewrote with its state kept is still this page: its hash links, Back and Forward fetch nothing", async () => {
		const p = open({ html: page({ main: anchors }) });
		// What a tab strip does: the query changes, the page does not.
		p.window.history.replaceState(p.window.history.state, "", "/a?tab=2");
		jump(p, "#jump", 4000);
		expect(path(p)).toBe("/a?tab=2#results");
		p.window.history.back();
		await settle();
		expect(path(p)).toBe("/a?tab=2");
		p.window.history.forward();
		await settle();
		expect(p.calls).toEqual([]);
		expect(p.loads).toEqual([]);
	});

	test("an entry with no state that a script pushed is visited and given an id", async () => {
		const p = open({ html: page(), routes: { "/a?tab=2": () => answer(part({ title: "A", main: "<h1>Page A</h1>" })), "/b": () => answer(part()) } });
		p.click("#to-b");
		await settle();
		p.window.history.pushState(null, "", "/a?tab=2");
		p.window.history.pushState(null, "", "/b?x");
		p.window.history.back();
		await settle();
		expect(p.calls.map((c) => c.url)).toEqual(["/b", "/a?tab=2"]);
		expect(text(p, "main h1")).toBe("Page A");
		expect(typeof p.window.history.state.natsu.id).toBe("number");
	});

	test("scrolling during a back/forward fetch belongs to the page being left, not the one coming", async () => {
		let release: (() => void) | undefined;
		const p = open({
			html: page(),
			routes: {
				"/a": () => new Promise((y) => (release = () => y(answer(part({ title: "A", main: "<h1>Page A</h1>" }))))),
				"/b": () => answer(part()),
			},
		});
		p.scroll(100);
		p.click("#to-b");
		await settle();
		p.scroll(300);
		p.window.history.back();
		await settle();
		// Inertia: the page on screen (B) still scrolls while A is fetched.
		p.scroll(777);
		release!();
		await settle();
		expect(text(p, "main h1")).toBe("Page A");
		expect(p.window.scrollY).toBe(100);
		p.window.history.forward();
		await settle();
		expect(text(p, "main h1")).toBe("Page B");
		expect(p.window.scrollY).toBe(777);
	});

	test("on an unsafe page, back/forward reloads rather than pushing another entry", async () => {
		const p = open({ html: page(), routes: { "/b": () => answer(part()) } });
		p.click("#to-b");
		await settle();
		// A loader adds a script that never calls mount.
		const s = p.document.createElement("script");
		s.src = "/js/widget.js";
		p.document.body.append(s);
		p.window.history.back();
		await settle();
		expect(p.loads).toEqual([["reload"]]);
	});

	test("while a Back or Forward is on its way, a link or form on the page still on screen is read against that page", async () => {
		const region = `<h1>Page B</h1><a id="to-more" href="#more">more</a><form id="here"><input name="q" value="1"></form><p id="more">m</p>`;
		for (const how of ["link", "form"]) {
			let release!: () => void;
			const p = open({
				html: page(),
				routes: {
					"/a": () => new Promise((y) => (release = () => y(answer(part({ title: "A", main: "<h1>Page A</h1>" }))))),
					"/b": () => answer(part({ main: region })),
					"/b?q=1": () => answer(part({ title: "B1", main: region })),
				},
			});
			p.click("#to-b");
			await settle();
			p.window.history.back();
			await settle();
			// The address bar says /a; B is still on screen.
			expect([how, path(p), text(p, "main h1")]).toEqual([how, "/a", "Page B"]);
			// B's own hash link, not a jump within A; B's form, not one that goes to A.
			expect(how == "link" ? p.click("#to-more") : p.submit("#here")).toBe(true);
			await settle();
			release();
			await settle();
			expect([how, path(p), text(p, "main h1")]).toEqual([how, how == "link" ? "/b#more" : "/b?q=1", "Page B"]);
			expect(p.loads).toEqual([]);
		}
	});

	test("the scroll goes into the entry once it settles (200 ms) and at beforeunload, so a reload comes back to it; never into the entry a Back is on its way to", async () => {
		let release!: () => void;
		const p = open({
			html: page(),
			routes: {
				"/a": () => new Promise((y) => (release = () => y(answer(part({ title: "A", main: "<h1>Page A</h1>" }))))),
				"/b": () => answer(part()),
			},
		});
		const y = () => p.window.history.state.natsu.y;
		p.scroll(450);
		expect(y()).toBeUndefined();
		await tick(100);
		p.scroll(460);
		await tick(150);
		expect(y()).toBeUndefined();
		await tick(100);
		expect(y()).toBe(460);
		p.scroll(500);
		p.window.dispatchEvent(new p.window.Event("beforeunload"));
		expect(y()).toBe(500);
		p.click("#to-b");
		await settle();
		p.scroll(300);
		p.window.history.back();
		await settle();
		// Still B on screen, scrolled; the entry in the address bar is A's.
		p.scroll(777);
		await tick(250);
		p.window.dispatchEvent(new p.window.Event("beforeunload"));
		expect(y()).toBe(500);
		release();
		await settle();
		expect([text(p, "main h1"), p.window.scrollY]).toEqual(["Page A", 500]);
	});

	test("every scroll the runtime makes is instant: a page's scroll-behavior: smooth would animate it", async () => {
		const how: unknown[] = [];
		const p = open({
			html: page({ main: anchors }),
			routes: { "/b": () => answer(part({ main: `<h1>B</h1><p id="t">t</p>` })) },
			before: (w) => {
				const to = w.scrollTo.bind(w);
				w.scrollTo = (x: W, y?: number) => (typeof x == "object" && how.push(x.behavior), to(x, y));
				w.HTMLElement.prototype.scrollIntoView = (o: W) => void how.push(o?.behavior);
			},
		});
		// The hash entry's target, the new page's target, its top, and Back to a y.
		jump(p, "#jump", 4000);
		await p.natsu.visit("/b#t");
		await p.natsu.visit("/b");
		p.window.history.back();
		await settle();
		expect(how).toEqual(["instant", "instant", "instant", "instant"]);
	});

	test("pagehide writes the scroll into the entry on screen", () => {
		const p = open({ html: page() });
		p.scroll(450);
		p.window.dispatchEvent(new p.window.Event("pagehide"));
		expect(p.window.history.state.natsu.y).toBe(450);
	});

	test("a reload of an entry a swap made (manual) scrolls back to its y, and again at load unless the visitor scrolled", () => {
		// Before load the page is shorter than it will be: a scroll stops at 300.
		let max = 300;
		const before = (w: W) => {
			w.history.replaceState({ natsu: { id: 1, p: 2, y: 450 } }, "");
			w.history.scrollRestoration = "manual";
			const to = w.scrollTo.bind(w);
			w.scrollTo = (x: number | ScrollToOptions, y?: number) => to(0, Math.min(typeof x == "object" ? x.top! : y!, max));
		};
		const p = open({ html: page(), ready: false, before });
		expect(p.window.scrollY).toBe(300);
		max = 5000;
		p.window.dispatchEvent(new p.window.Event("load"));
		expect(p.window.scrollY).toBe(450);
		max = 300;
		const q = open({ html: page(), ready: false, before });
		q.scroll(120);
		max = 5000;
		q.window.dispatchEvent(new q.window.Event("load"));
		expect(q.window.scrollY).toBe(120);
	});

	test("a reload of an entry the browser restores (auto) is left to the browser", () => {
		const p = open({ html: page(), before: (w) => w.history.replaceState({ natsu: { id: 1, p: 2, y: 450 } }, "") });
		expect(p.window.scrollY).toBe(0);
		expect(p.window.history.state.natsu).toMatchObject({ id: 1, y: 450 });
	});

	test("refresh() answered with a real load reloads the page, on a URL with a hash too", async () => {
		for (const url of [`${ORIGIN}/a`, `${ORIGIN}/a#results`]) {
			const p = open({ html: page(), url, routes: { "/a": () => control({ "natsu-reload": "shell" }) } });
			await p.natsu.refresh();
			expect([url, p.loads]).toEqual([url, [["reload"]]]);
		}
	});

	test("refresh() that the server redirects to another page shows that page from its top, as a reload that redirects does", async () => {
		const p = open({
			html: page(),
			routes: {
				"/a": () => control({ "natsu-location": "/login" }),
				"/login": () => answer(part({ title: "Sign in", main: "<h1>Sign in</h1>" })),
			},
		});
		p.scroll(1500);
		await p.natsu.refresh();
		expect([path(p), text(p, "main h1")]).toEqual(["/login", "Sign in"]);
		expect([p.window.scrollY, text(p, '[role="status"]'), p.document.activeElement?.textContent]).toEqual([0, "Sign in", "Sign in"]);
	});

	test("a hash jump while a visit is on its way does not cancel the visit (the browser still loads the page)", async () => {
		let release!: () => void;
		const anchors = `<h1>Page A</h1><a id="jump" href="#results">results</a><div class="tall"></div><div id="results">r</div>`;
		const p = open({ html: page({ main: anchors }), routes: { "/b": () => new Promise((y) => (release = () => y(answer(part())))) } });
		p.click("#to-b");
		await tick(5);
		jump(p, "#jump", 4000);
		release();
		await settle();
		expect([path(p), text(p, "main h1")]).toEqual(["/b", "Page B"]);
	});

	test("a hash jump on the new page while its script still loads: natsu:load still fires", async () => {
		const main = `<h1>Page B</h1><a id="jump" href="#results">results</a><div id="results">r</div>`;
		const p = open({
			html: page(),
			routes: { "/b": () => answer(part({ main, scripts: ["/js/b.js"] })) },
			scripts: { "/js/b.js": (w) => w.natsu.mount("main", () => {}) },
			holdJs: ["/js/b.js"],
		});
		const loaded: string[] = [];
		p.document.addEventListener("natsu:load", (e: CustomEvent<NatsuLoadDetail>) => loaded.push(new URL(e.detail.url).pathname));
		p.click("#to-b");
		await settle();
		jump(p, "#jump", 300);
		p.release("/js/b.js");
		await settle();
		expect(loaded).toEqual(["/b"]);
	});

	test("an entry a script pushed with no state keeps its own scroll: Back to the entry before it restores that entry's", async () => {
		const p = open({
			html: page(),
			routes: {
				"/a": () => answer(part({ title: "A", main: "<h1>Page A</h1>" })),
				"/a?f=1": () => answer(part({ title: "A1", main: "<h1>Page A filtered</h1>" })),
				"/b": () => answer(part()),
			},
		});
		p.scroll(100);
		await tick(250);
		// A filter widget: a new entry for its state, with no state of natsu's.
		p.window.history.pushState(null, "", "/a?f=1");
		p.scroll(900);
		await tick(250);
		p.click("#to-b");
		await settle();
		p.window.history.back();
		await settle();
		expect([path(p), p.window.scrollY]).toEqual(["/a?f=1", 900]);
		p.window.history.back();
		await settle();
		// A browser restores each entry's own scroll: /a was left at 100.
		expect([path(p), p.window.scrollY]).toEqual(["/a", 100]);
	});

	test("while a Back is on its way, a relative link on a page with <base href> still goes where the base says", async () => {
		const head = `<base href="/shop/">`;
		const p = open({
			url: `${ORIGIN}/shop/home`,
			html: page({ head, shell: `<a id="list" href="products/list">list</a><a id="cart" href="cart">cart</a>` }),
			routes: {
				// Still on its way when the link is clicked.
				"/shop/home": () => new Promise(() => {}),
				"/shop/products/list": () => answer(part({ head, title: "List" })),
				"/shop/cart": () => answer(part({ head, title: "Cart" })),
			},
		});
		p.click("#list");
		await settle();
		expect(path(p)).toBe("/shop/products/list");
		p.window.history.back();
		await settle();
		expect(p.click("#cart")).toBe(true);
		await settle();
		// The browser resolves href="cart" against the base: /shop/cart.
		expect(p.calls.map((c) => c.url)).toEqual(["/shop/products/list", "/shop/home", "/shop/cart"]);
		expect([path(p), p.document.title]).toEqual(["/shop/cart", "Cart"]);
	});
});

describe("prefetch", () => {
	const hover = (p: Opened, sel: string) =>
		p.document.querySelector(sel).dispatchEvent(new p.window.PointerEvent("pointerover", { bubbles: true, pointerType: "mouse" }));
	const leave = (p: Opened, sel: string) =>
		p.document.querySelector(sel).dispatchEvent(new p.window.PointerEvent("pointerout", { bubbles: true, pointerType: "mouse", relatedTarget: p.document.body }));

	test("a 65 ms hover prefetches, marked Natsu-Prefetch, and the click uses it", async () => {
		const p = open({ html: page(), routes: { "/b": () => answer(part()) } });
		const from = performance.now();
		hover(p, "#to-b");
		// Timed, not slept: on a loaded machine a fixed sleep may wake after the runtime's own timer.
		await until(() => p.calls.length);
		expect(performance.now() - from).toBeGreaterThanOrEqual(60);
		expect(p.calls).toEqual([{ url: "/b", headers: { "Natsu-Nav": "k1.s1", "Natsu-Prefetch": "1" } }]);
		await p.prefetched();
		p.click("#to-b");
		await until(() => text(p, "main h1") == "Page B");
		expect(p.calls.length).toBe(1);
		expect(text(p, "main h1")).toBe("Page B");
	});

	test("with the answer in hand, the swap does not run in the click's task: it yields first (scheduler.yield, else a frame)", async () => {
		const microtasks = async () => {
			for (let i = 0; i < 50; i++) await null;
		};
		for (const yields of [false, true]) {
			const p = open({ html: page(), routes: { "/b": () => answer(part()) } });
			let used = 0;
			if (yields) p.window.scheduler = { yield: () => (used++, new Promise((y) => setTimeout(y, 5))) };
			p.natsu.prefetch("/b");
			await p.prefetched();
			p.click("#to-b");
			await microtasks();
			expect([yields, text(p, "main h1")]).toEqual([yields, "Page A"]);
			await until(() => text(p, "main h1") == "Page B");
			expect([yields, text(p, "main h1"), used]).toEqual([yields, "Page B", yields ? 1 : 0]);
		}
	});

	test("leaving the link before 65 ms cancels", async () => {
		const p = open({ html: page(), routes: { "/b": () => answer(part()) } });
		hover(p, "#to-b");
		await tick(20);
		leave(p, "#to-b");
		await tick(80);
		expect(p.calls).toEqual([]);
	});

	test("a touch prefetches after 65 ms, as a mouse does; a touch the browser takes to pan, or a scroll, cancels it", async () => {
		const routes: Record<string, Route> = {};
		for (const x of "bcd") routes[`/${x}`] = () => answer(part());
		const shell = LINKS + `<a id="to-d" href="/d">D</a>`;
		const p = open({ html: page({ shell }), routes });
		const finger = (type: string, sel: string) =>
			p.document.querySelector(sel).dispatchEvent(new p.window.PointerEvent(type, { bubbles: true, pointerType: "touch" }));
		// A tap.
		finger("pointerover", "#to-b");
		await tick(30);
		expect(p.calls).toEqual([]);
		await tick(50);
		expect(p.calls.map((c) => c.url)).toEqual(["/b"]);
		// A flick: the browser pans, and says so.
		finger("pointerover", "#to-c");
		finger("pointercancel", "#to-c");
		await tick(90);
		// Momentum: the page scrolls.
		finger("pointerover", "#to-d");
		p.window.dispatchEvent(new p.window.Event("scroll"));
		await tick(90);
		expect(p.calls.map((c) => c.url)).toEqual(["/b"]);
	});

	test("a click before the dwell is over cancels the hover's prefetch: one request, the visit's", async () => {
		// The visit is still in flight, on /a, when the dwell would have ended.
		const p = open({ html: page(), routes: { "/b": () => tick(100).then(() => answer(part())) } });
		hover(p, "#to-b");
		await tick(20);
		p.click("#to-b");
		await tick(150);
		expect(p.calls).toEqual([{ url: "/b", headers: { "Natsu-Nav": "k1.s1" } }]);
		expect(text(p, "main h1")).toBe("Page B");
	});

	test("a visit lets go of the hovered link: hovering it again on the new page prefetches again", async () => {
		const p = open({ html: page(), routes: { "/b": () => answer(part()), "/c": () => answer(part({ title: "C" })) } });
		hover(p, "#to-c");
		await tick(90);
		await p.natsu.visit("/b");
		// Empty the prefetch cache, so a second prefetch of /c shows as a request.
		p.window.dispatchEvent(new p.window.Event("pagehide"));
		hover(p, "#to-c");
		await tick(90);
		expect(p.calls.map((c) => c.url)).toEqual(["/c", "/b", "/c"]);
	});

	test("skipped: Save-Data, 2g, data-natsu-prefetch=off, the current URL, an unsafe page", async () => {
		const shell = LINKS + `<a id="off" href="/d" data-natsu-prefetch="off">d</a><a id="here" href="/a?">a</a>`;
		const p = open({ html: page({ shell }), routes: {} });
		Object.defineProperty(p.window.navigator, "connection", { value: { saveData: true }, configurable: true });
		p.natsu.prefetch("/b");
		Object.defineProperty(p.window.navigator, "connection", { value: { effectiveType: "slow-2g" }, configurable: true });
		p.natsu.prefetch("/b");
		Object.defineProperty(p.window.navigator, "connection", { value: undefined, configurable: true });
		hover(p, "#off");
		await tick(80);
		p.natsu.prefetch("/a");
		p.natsu.prefetch("/a#x");
		expect(p.calls).toEqual([]);
		const q = open({ html: page({ scripts: ["/js/legacy.js"] }) });
		q.natsu.prefetch("/b");
		hover(q, "#to-b");
		await tick(80);
		expect(q.calls).toEqual([]);
	});

	test("a skip and a 404 part are fetched again by the click; both are remembered for 10 s, so hovers stop asking", async () => {
		const p = open({
			html: page(),
			routes: {
				"/b": (h) => (h["Natsu-Prefetch"] ? control({ "natsu-prefetch": "skip" }) : answer(part())),
				"/c": (h) => answer(part({ title: h["Natsu-Prefetch"] ? "stale 404" : "C" }), h["Natsu-Prefetch"] ? 404 : 200),
			},
		});
		p.natsu.prefetch("/b");
		p.natsu.prefetch("/c");
		await settle();
		p.natsu.prefetch("/b");
		p.natsu.prefetch("/c");
		await settle();
		expect(p.calls.map((c) => c.url)).toEqual(["/b", "/c"]);
		await p.natsu.visit("/b");
		await p.natsu.visit("/c");
		expect(p.calls.map((c) => c.url)).toEqual(["/b", "/c", "/b", "/c"]);
		expect(p.document.title).toBe("C");
	});

	test("a prefetched reload or redirect is kept, and the click acts on it without asking again", async () => {
		const p = open({
			html: page(),
			routes: {
				"/r": () => control({ "natsu-reload": "shell" }),
				"/old": () => control({ "natsu-location": "/new" }),
				"/new": () => answer(part({ title: "New" })),
			},
		});
		p.natsu.prefetch("/r");
		p.natsu.prefetch("/old");
		await settle();
		await p.natsu.visit("/r");
		await p.natsu.visit("/old");
		expect(p.calls.map((c) => c.url)).toEqual(["/r", "/old", "/new"]);
		expect(p.loads).toEqual([["assign", `${ORIGIN}/r`]]);
		expect([path(p), p.document.title]).toEqual(["/new", "New"]);
	});

	test("a path that answered Natsu-Reload: route or response is a real load from then on, and never prefetched", async () => {
		const p = open({
			html: page(),
			routes: {
				"/admin?x=1": () => control({ "natsu-reload": "route" }),
				"/feed": () => control({ "natsu-reload": "response" }),
				"/shell": () => control({ "natsu-reload": "shell" }),
			},
		});
		for (const to of ["/admin?x=1", "/feed", "/shell"]) await p.natsu.visit(to);
		for (const to of ["/admin?x=2", "/feed", "/shell"]) p.natsu.prefetch(to);
		await settle();
		for (const to of ["/admin?x=3", "/feed", "/shell"]) await p.natsu.visit(to);
		// Asked once each (any query); /shell, refused for another reason, is prefetched again, and the click uses that.
		expect(p.calls.map((c) => c.url)).toEqual(["/admin?x=1", "/feed", "/shell", "/shell"]);
		expect(p.loads.length).toBe(6);
	});

	test("an answer with no natsu header (another server behind the same proxy: a blog, a 404) is a real load from then on, and never prefetched", async () => {
		const p = open({
			html: page(),
			routes: { "/blog": () => new Response("<h1>blog</h1>", { headers: { "content-type": "text/html" } }), "/b": () => answer(part()) },
		});
		p.natsu.prefetch("/blog");
		await settle();
		await p.natsu.visit("/blog");
		p.natsu.prefetch("/blog");
		await p.natsu.visit("/blog");
		await p.natsu.visit("/nowhere");
		await p.natsu.visit("/nowhere");
		expect(p.calls.map((c) => c.url)).toEqual(["/blog", "/nowhere"]);
		expect(p.loads.map((l) => l[1])).toEqual([`${ORIGIN}/blog`, `${ORIGIN}/blog`, `${ORIGIN}/nowhere`, `${ORIGIN}/nowhere`]);
		// A part, as ever, swaps.
		await p.natsu.visit("/b");
		expect(path(p)).toBe("/b");
	});

	test("<meta name=natsu data-prefetch=off> (prefetch off on the server): no prefetch at all; a click still swaps", async () => {
		const p = open({ html: page().replace(`content="k1.s1">`, `content="k1.s1" data-prefetch="off">`), routes: { "/b": () => answer(part()) } });
		p.natsu.prefetch("/b");
		p.document.querySelector("#to-b").dispatchEvent(new p.window.PointerEvent("pointerover", { bubbles: true, pointerType: "mouse" }));
		await tick(90);
		expect(p.calls).toEqual([]);
		p.click("#to-b");
		await settle();
		expect(p.calls.map((c) => [c.url, c.headers["Natsu-Prefetch"]])).toEqual([["/b", undefined]]);
		expect(text(p, "main h1")).toBe("Page B");
	});

	test("at most two in flight", async () => {
		const p = open({ html: page(), routes: { "/b": () => new Promise(() => {}), "/c": () => new Promise(() => {}), "/d": () => answer(part()) } });
		p.natsu.prefetch("/b");
		p.natsu.prefetch("/c");
		p.natsu.prefetch("/d");
		await settle();
		expect(p.calls.map((c) => c.url)).toEqual(["/b", "/c"]);
	});

	test("five entries, least recently used out first; ten seconds to live", async () => {
		const routes: Record<string, Route> = {};
		for (const x of "bcdefg") routes[`/${x}`] = () => answer(part({ title: x }));
		const p = open({ html: page(), routes });
		// Each taken in before the next: two in flight at most, and a loaded machine may take longer than a fixed sleep.
		for (const x of "bcdef") {
			p.natsu.prefetch(`/${x}`);
			await p.prefetched();
		}
		p.natsu.prefetch("/b"); // used again: now the most recent
		p.natsu.prefetch("/g"); // evicts /c
		await p.prefetched();
		const before = p.calls.length;
		await p.natsu.visit("/b");
		await p.natsu.visit("/c");
		expect(p.calls.slice(before).map((c) => c.url)).toEqual(["/c"]);
		// The runtime reads the window's Date, which happy-dom keeps apart from Bun's.
		const D = p.window.Date;
		const now = D.now;
		try {
			const at = now();
			D.now = () => at + 10_001;
			await p.natsu.visit("/d");
		} finally {
			D.now = now;
		}
		expect(p.calls.slice(before).map((c) => c.url)).toEqual(["/c", "/d"]);
	});

	test("any submit clears the cache; so does pagehide", async () => {
		const p = open({
			html: page({ shell: LINKS + `<form id="act" method="post" action="/_act/x"></form>` }),
			routes: { "/b": () => answer(part()), "/c": () => answer(part({ title: "C" })) },
		});
		p.natsu.prefetch("/b");
		await settle();
		p.submit("#act");
		await p.natsu.visit("/b");
		expect(p.calls.length).toBe(2);
		p.natsu.prefetch("/c");
		await settle();
		p.window.dispatchEvent(new p.window.Event("pagehide"));
		await p.natsu.visit("/c");
		expect(p.calls.map((c) => c.url)).toEqual(["/b", "/b", "/c", "/c"]);
	});
});

describe("prefetch in view and per link", () => {
	/** An IntersectionObserver the test drives: `show(el)` puts a link on screen, `hide(el)` takes it off. */
	class FakeIO {
		static last: FakeIO;
		observed = new Set<Element>();
		constructor(private cb: (entries: { target: Element; isIntersecting: boolean }[]) => void) {
			FakeIO.last = this;
		}
		observe(el: Element) {
			this.observed.add(el);
		}
		unobserve(el: Element) {
			this.observed.delete(el);
		}
		show(...els: Element[]) {
			this.cb(els.map((target) => ({ target, isIntersecting: true })));
		}
		hide(...els: Element[]) {
			this.cb(els.map((target) => ({ target, isIntersecting: false })));
		}
	}
	const withIO = (w: W) => (w.IntersectionObserver = FakeIO);
	const ids = () => [...FakeIO.last.observed].map((el) => el.id).sort();
	const hover = (p: Opened, sel: string) =>
		p.document.querySelector(sel).dispatchEvent(new p.window.PointerEvent("pointerover", { bubbles: true, pointerType: "mouse" }));
	const prefetches = (p: Opened) => p.calls.filter((c) => c.headers["Natsu-Prefetch"]).map((c) => c.url);
	const $ = (p: Opened, sel: string) => p.document.querySelector(sel);
	const viewport = (html: string, mode = "viewport") => html.replace(`content="k1.s1">`, `content="k1.s1" data-prefetch="${mode}">`);

	test('data-natsu-prefetch="viewport": fetched once on screen, in idle time, once; the click uses it', async () => {
		const p = open({
			html: page({ shell: LINKS + `<a id="v" href="/v" data-natsu-prefetch="viewport">v</a>` }),
			routes: { "/v": () => answer(part({ title: "V" })) },
			before: withIO,
		});
		expect(ids()).toEqual(["v"]);
		await tick(30);
		expect(p.calls).toEqual([]);
		FakeIO.last.show($(p, "#v"));
		await until(() => p.calls.length);
		await p.prefetched();
		expect(p.calls).toEqual([{ url: "/v", headers: { "Natsu-Nav": "k1.s1", "Natsu-Prefetch": "1" } }]);
		expect(ids()).toEqual([]);
		p.click("#v");
		await settle();
		expect(p.calls.length).toBe(1);
		expect(p.document.title).toBe("V");
	});

	test("a link that leaves the screen before idle time is not fetched", async () => {
		const p = open({
			html: page({ shell: LINKS + `<a id="v" href="/v" data-natsu-prefetch="viewport">v</a>` }),
			routes: { "/v": () => answer(part()) },
			before: withIO,
		});
		FakeIO.last.show($(p, "#v"));
		FakeIO.last.hide($(p, "#v"));
		await settle();
		expect(p.calls).toEqual([]);
		expect(ids()).toEqual(["v"]);
	});

	test('the site default (key data-prefetch="viewport"): every link is watched but those under data-natsu-prefetch="none"; swapped regions are watched and let go', async () => {
		const p = open({
			html: viewport(page({ shell: LINKS + `<nav data-natsu-prefetch="none"><a id="n" href="/n">n</a></nav>`, main: `<h1>A</h1><a id="m" href="/m">m</a>` })),
			routes: { "/b": () => answer(part({ main: `<h1>B</h1><a id="m2" href="/m2">m2</a>` })) },
			before: withIO,
		});
		expect(ids()).toEqual(["m", "to-b", "to-c"]);
		// Hover still prefetches a link that is not off; never one that is.
		hover(p, "#to-b");
		await until(() => p.calls.length);
		await p.prefetched();
		expect(prefetches(p)).toEqual(["/b"]);
		hover(p, "#n");
		await tick(90);
		expect(prefetches(p)).toEqual(["/b"]);
		await p.natsu.visit("/b");
		expect(text(p, "main h1")).toBe("B");
		expect(ids()).toEqual(["m2", "to-b", "to-c"]);
	});

	test("links in view: two at a time, and no more than the cache keeps (five), so a hover is never pushed out", async () => {
		const xs = "vwxyzqr".split("");
		const links = xs.map((x) => `<a id="${x}" href="/${x}" data-natsu-prefetch="viewport">${x}</a>`).join("");
		const routes: Record<string, Route> = {};
		let now = 0;
		let most = 0;
		for (const x of xs)
			routes[`/${x}`] = async () => {
				most = Math.max(most, ++now);
				await tick(5);
				now--;
				return answer(part({ title: x }));
			};
		const p = open({ html: page({ shell: LINKS + links }), routes, before: withIO });
		FakeIO.last.show(...p.document.querySelectorAll("[data-natsu-prefetch]"));
		await until(() => p.calls.length >= 5);
		await p.prefetched();
		await settle();
		expect(prefetches(p)).toEqual(["/v", "/w", "/x", "/y", "/z"]);
		expect(most).toBeLessThanOrEqual(2);
		// The two left wait in view, and are not fetched while the cache is full.
		expect(ids()).toEqual(["q", "r"]);
	});

	test("Save-Data or a 3g connection: nothing is fetched for being in view; a hover on 3g still is", async () => {
		for (const connection of [{ saveData: true }, { effectiveType: "3g" }] as { saveData?: boolean; effectiveType?: string }[]) {
			const p = open({
				html: page({ shell: LINKS + `<a id="v" href="/v" data-natsu-prefetch="viewport">v</a>` }),
				routes: { "/v": () => answer(part()) },
				before: (w) => (withIO(w), Object.defineProperty(w.navigator, "connection", { value: connection, configurable: true })),
			});
			FakeIO.last.show($(p, "#v"));
			await settle();
			expect([connection, p.calls]).toEqual([connection, []]);
			hover(p, "#v");
			await tick(90);
			await p.prefetched();
			expect([connection, prefetches(p)]).toEqual([connection, connection.saveData ? [] : ["/v"]]);
		}
	});

	test('data-natsu-prefetch="none" on a link: no hover prefetch; with the key\'s data-prefetch="none", only a link that asks is prefetched', async () => {
		const p = open({ html: page({ shell: LINKS + `<a id="x" href="/x" data-natsu-prefetch="none">x</a>` }), routes: { "/x": () => answer(part()) } });
		hover(p, "#x");
		await tick(90);
		expect(p.calls).toEqual([]);
		const q = open({
			html: viewport(page({ shell: LINKS + `<a id="h" href="/h" data-natsu-prefetch="hover">h</a>` }), "none"),
			routes: { "/b": () => answer(part()), "/h": () => answer(part()) },
		});
		hover(q, "#to-b");
		await tick(90);
		expect(q.calls).toEqual([]);
		hover(q, "#h");
		await until(() => q.calls.length);
		await q.prefetched();
		expect(prefetches(q)).toEqual(["/h"]);
		// natsu.prefetch() is the app's own call: it still fetches.
		q.natsu.prefetch("/b");
		await q.prefetched();
		expect(prefetches(q)).toEqual(["/h", "/b"]);
	});
});

describe("islands", () => {
	const isle = (body: string, headers: Record<string, string> = {}) =>
		new Response(body, { headers: { "content-type": "text/html; charset=utf-8", "natsu-island": "1", ...headers } });

	test("fetched after load into the element, mounted, fetched again by natsu.island; a non-200 leaves it be", async () => {
		let n = 0;
		let status = 200;
		const log: string[] = [];
		const p = open({
			html: page({ shell: LINKS + `<div id="bell" data-natsu-island="/api/bell">…</div>`, scripts: ["/js/site.js"] }),
			scripts: { "/js/site.js": (w) => w.natsu.mount("[data-row]", (el: Element) => void log.push(el.textContent!)) },
			routes: {
				"/api/bell": () => (status === 200 ? isle(`<p data-row>row ${++n}</p>`) : new Response("no", { status, headers: { "natsu-island": "1" } })),
			},
		});
		await settle();
		expect(p.calls).toEqual([{ url: "/api/bell", headers: { "Natsu-Island": "1" } }]);
		expect(text(p, "#bell")).toBe("row 1");
		expect(log).toEqual(["row 1"]);
		await p.natsu.island(p.document.getElementById("bell"));
		expect(text(p, "#bell")).toBe("row 2");
		expect(log).toEqual(["row 1", "row 2"]);
		status = 500;
		await p.natsu.island(p.document.getElementById("bell"));
		expect(text(p, "#bell")).toBe("row 2");
	});

	test("only an answer that says Natsu-Island: 1 is taken, and only from this origin", async () => {
		const p = open({
			html: page({
				shell:
					LINKS +
					`<div id="page" data-natsu-island="/account/delete">a</div><div id="text" data-natsu-island="/api/text">b</div>` +
					`<div id="far" data-natsu-island="https://else.test/x">c</div><div id="rel" data-natsu-island="api/rel">d</div>`,
			}),
			routes: {
				// A whole page, or a route that is not an island: no Natsu-Island back.
				"/account/delete": () => new Response("<h1>deleted</h1>", { headers: { "content-type": "text/html" } }),
				"/api/text": () => isle("plain", { "content-type": "text/plain" }),
				"/api/rel": () => isle("<b>rel</b>"),
			},
		});
		await settle();
		expect([text(p, "#page"), text(p, "#text"), text(p, "#far"), text(p, "#rel")]).toEqual(["a", "b", "c", "rel"]);
		expect(p.calls.map((c) => c.url).sort()).toEqual(["/account/delete", "/api/rel", "/api/text"]);
	});

	test("an island in a region swapped in is fetched; one swapped out is aborted", async () => {
		const signals: AbortSignal[] = [];
		const p = open({
			html: page(),
			routes: {
				"/b": () => answer(part({ main: `<h1>B</h1><div id="box" data-natsu-island="/api/box">…</div>` })),
				"/c": () => answer(part({ title: "C" })),
				"/api/box": () => isle("<b>box</b>"),
			},
		});
		const fetch = p.window.fetch;
		p.window.fetch = (u: string, init: { signal?: AbortSignal }) => {
			if (init?.signal) signals.push(init.signal);
			return fetch(u, init);
		};
		await p.natsu.visit("/b");
		await settle();
		expect(text(p, "#box")).toBe("box");
		await p.natsu.visit("/c");
		expect(signals.length).toBe(1);
		expect(signals[0]!.aborted).toBe(true);
	});

	test("natsu.island while an earlier fetch of the same island is still out: the later answer stays", async () => {
		let n = 0;
		const p = open({
			html: page({ shell: LINKS + `<div id="cart" data-natsu-island="/api/cart">…</div>` }),
			routes: {
				// The first answer (sent before the visitor's action) is slow; the one asked after the action is quick.
				"/api/cart": () => (++n == 1 ? tick(80).then(() => isle("0 items")) : isle("1 item")),
			},
		});
		await tick(5);
		// The visitor added an item; the page asks the island again.
		await p.natsu.island(p.document.getElementById("cart"));
		expect(text(p, "#cart")).toBe("1 item");
		await tick(150);
		expect(n).toBe(2);
		expect(text(p, "#cart")).toBe("1 item");
	});
});

describe("development build", () => {
	test("says why a visit became a real load", async () => {
		const said: unknown[][] = [];
		const p = open({ html: page({ scripts: ["/js/legacy.js"] }), dev: true });
		p.window.console.info = (...a: unknown[]) => void said.push(a);
		await p.natsu.visit("/b");
		const q = open({ html: page(), dev: true, routes: { "/b": () => control({ "natsu-reload": "shell" }) } });
		q.window.console.info = (...a: unknown[]) => void said.push(a);
		await q.natsu.visit("/b");
		// The scripts are logged as elements (an inline one has no src); compared here by their src.
		const [lead, bad, line] = said[0] as [string, W[], string];
		expect([lead, bad.map((s) => s.src), line]).toEqual([
			"natsu: real load,",
			[`${ORIGIN}/js/legacy.js`],
			"never called natsu.mount (call it at the top level of the script, or tag it data-natsu-once)",
		]);
		expect(said[1]).toEqual(["natsu: real load,", "shell", `${ORIGIN}/b`]);
	});

	test("the production build carries none of it", () => {
		expect(CODE).not.toContain("real load");
		expect(DEV_CODE).toContain("real load");
	});
});

describe("types", () => {
	test("natsu is a global, mount is generic, and the natsu: events are typed on document", () => {
		// Checked by tsc (`bunx tsc --noEmit -p v2`), never run: a wrong type fails the typecheck.
		const typed = () => {
			natsu.mount<HTMLFormElement>("form[data-upload]", (form, signal) => {
				form.requestSubmit();
				signal.throwIfAborted();
			});
			natsu.mount("[data-menu]", (el) => el.focus());
			// @ts-expect-error an input is not a form
			natsu.mount<HTMLInputElement>("input", (input) => input.requestSubmit());
			document.addEventListener("natsu:visit", (e) => e.detail.url.startsWith("/admin") && e.preventDefault());
			document.addEventListener("natsu:before-swap", (e) => e.detail.url);
			document.addEventListener("natsu:load", (e) => e.detail.regions.map((r) => r.id + e.detail.url));
			// @ts-expect-error regions are elements
			document.addEventListener("natsu:load", (e) => e.detail.regions[0]!.toUpperCase());
			const load: NatsuLoadDetail = { url: "/", regions: [] };
			const how: NatsuVisitOptions = { history: "replace", scroll: "keep" };
			return [load, window.natsu.visit("/b", how)];
		};
		expect(typeof typed).toBe("function");
	});
});

describe("actions", () => {
	const form = `<form id="f" method="post" data-uwu-action="add" data-uwu-event="submit" data-list="7"><input type="hidden" name="_action" value="add"><input type="hidden" name="_csrf" value="T0KEN"><input name="title" value="milk"><button id="go">Add</button></form>`;
	const button = `<button id="done" data-uwu-action="done" data-uwu-event="click" data-todo-id="3">Done</button>`;
	const back = () => control({ "natsu-location": "/a" });

	test("a submit posts the form with the page's key; the 303 back is a visit that swaps the regions", async () => {
		const p = open({
			html: page({ main: `<h1>Todos</h1>${form}` }),
			routes: { "POST /a": back, "/a": () => answer(part({ main: "<h1>Todos</h1><p>milk</p>" })) },
		});
		const header = p.document.getElementById("hdr");
		expect(p.submit("#f", "#go")).toBe(true);
		await settle();
		expect(p.calls[0]).toEqual({
			url: "/a",
			method: "POST",
			headers: { "Natsu-Action": "1", "Natsu-Nav": "k1.s1" },
			body: "_action=add&_csrf=T0KEN&title=milk&list=7",
		});
		expect(p.calls[1]).toEqual({ url: "/a", headers: { "Natsu-Nav": "k1.s1" } });
		expect(p.loads).toEqual([]);
		expect(text(p, "main p")).toBe("milk");
		expect(p.document.getElementById("hdr")).toBe(header);
		expect(path(p)).toBe("/a");
		// The page shown is the same entry, not a new one.
		expect(p.window.history.length).toBe(1);
	});

	test("a click posts the element's data and the cookie's token; a refused form comes back as a part", async () => {
		const p = open({
			html: page({ main: `<h1>Todos</h1>${button}` }),
			before: (w) => (w.document.cookie = "natsu_csrf=C00KIE"),
			routes: { "POST /a": () => answer(part({ main: "<h1>Todos</h1><p class=err>no</p>" }), 422) },
		});
		expect(p.click("#done")).toBe(true);
		await settle();
		expect(p.calls).toEqual([
			{ url: "/a", method: "POST", headers: { "Natsu-Action": "1", "Natsu-Nav": "k1.s1" }, body: "todoId=3&_action=done&_csrf=C00KIE" },
		]);
		expect(text(p, "main .err")).toBe("no");
		expect(p.loads).toEqual([]);
	});

	test("a redirect elsewhere is a visit there; one post at a time per element", async () => {
		const p = open({
			html: page({ main: `<h1>Todos</h1>${button}` }),
			routes: {
				"POST /a": async () => (await tick(5), control({ "natsu-location": "/b" })),
				"/b": () => answer(part()),
			},
		});
		p.click("#done");
		expect(p.document.getElementById("done").getAttribute("aria-busy")).toBe("true");
		p.click("#done");
		await settle();
		expect(p.calls.filter((c) => c.method === "POST").length).toBe(1);
		expect(path(p)).toBe("/b");
		expect(text(p, "main h1")).toBe("Page B");
		expect(p.window.history.length).toBe(2);
	});

	test("a reload answer is a real load of the page: the post is never sent twice", async () => {
		const p = open({ html: page({ main: button }), routes: { "POST /a": () => control({ "natsu-reload": "shell" }) } });
		p.click("#done");
		await settle();
		expect(p.calls.length).toBe(1);
		// The page again is a reload, which fetches it with GET: the post is not sent again.
		expect(p.loads).toEqual([["reload"]]);
	});

	test("without a key a form is the browser's; a click posts, then reloads", async () => {
		const p = open({ html: page({ key: "", main: `${form}${button}` }), routes: { "POST /a": () => new Response("ok") } });
		expect(p.submit("#f")).toBe(false);
		expect(p.click("#done")).toBe(true);
		await settle();
		expect(p.calls[0]!.headers).toEqual({ "Natsu-Action": "1" });
		expect(p.loads).toEqual([["reload"]]);
	});
});

describe("live data", () => {
	class FakeSocket {
		static last: FakeSocket | undefined;
		readyState = 0;
		sent: string[] = [];
		onopen?: () => void;
		onmessage?: (e: { data: string }) => void;
		onclose?: () => void;
		constructor(public url: string) {
			FakeSocket.last = this;
		}
		send(data: string) {
			this.sent.push(data);
		}
		open() {
			this.readyState = 1;
			this.onopen?.();
		}
	}
	const live = (tags: string) => `<meta name="natsu-live" content="${tags}">`;

	test("a page with live tags watches them, and refreshes its regions when one is invalidated", async () => {
		FakeSocket.last = undefined;
		let n = 0;
		const p = open({
			html: page({ head: live("todos|SIG") }),
			before: (w) => (w.WebSocket = FakeSocket),
			routes: { "/a": () => answer(part({ head: live("todos|SIG"), main: `<h1>A ${++n}</h1>` })), "/b": () => answer(part()) },
		});
		const ws = FakeSocket.last!;
		expect(ws.url).toBe("wss://shop.test/_uwu/socket");
		ws.open();
		expect(ws.sent).toEqual([JSON.stringify({ t: "watch", tags: "todos|SIG" })]);
		ws.onmessage!({ data: JSON.stringify({ t: "invalidate", tag: "todos" }) });
		ws.onmessage!({ data: JSON.stringify({ t: "invalidate", tag: "todos" }) });
		await tick(60);
		await settle();
		// Two frames, one refresh.
		expect(p.calls).toEqual([{ url: "/a", headers: { "Natsu-Nav": "k1.s1" } }]);
		expect(text(p, "main h1")).toBe("A 1");
		// A page without tags stops watching.
		p.click("#to-b");
		await settle();
		expect(ws.sent.at(-1)).toBe(JSON.stringify({ t: "watch", tags: "" }));
	});

	test("a page without tags opens no socket", () => {
		FakeSocket.last = undefined;
		open({ html: page(), before: (w) => (w.WebSocket = FakeSocket) });
		expect(FakeSocket.last).toBeUndefined();
	});
});

describe("size", () => {
	// 5 KiB until the loading bar, prefetch in view and the Back/Forward cache
	// (about 600 bytes together); raise it only with a note of what it bought.
	test("the minified runtime, actions, live data, the loading bar and prefetch in view included, stays within 5.5 KiB of brotli", () => {
		const br = brotliCompressSync(Buffer.from(CODE), { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length;
		expect(br).toBeLessThanOrEqual(5632);
	});
});
