/**
 * `client/mount.ts` in happy-dom: a module mounted on the elements that match
 * its selector, once its stylesheet families are linked, in link order; a
 * mount ended when its element goes; and the families kept in link order when
 * something else changes the head. The real-browser half, with natsu's
 * runtime and a page visit, is `mount.e2e.ts`.
 */

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";

let CODE = "";
beforeAll(async () => {
	const out = await Bun.build({ entrypoints: [new URL("../src/client/mount.ts", import.meta.url).pathname], format: "esm" });
	CODE = (await out.outputs[0]!.text()).replace(/export\s*\{[^}]*\};?\s*$/, "window.__mount = mount;");
});

type W = any; // happy-dom's Window, used as a browser window
const windows: W[] = [];
afterEach(async () => {
	for (const w of windows.splice(0)) await w.happyDOM.close();
});

const C = ["/_a/site.c.css", "/_a/site.a.css", "/_a/site.b.css", "/_a/site.d.css"];
const MANIFEST = JSON.stringify({ c: C, m: { "[data-a]": { 1: [[]] }, "[data-ab]": { 1: [[]], 2: [[]] }, "[data-x]": { 3: [["host"]] } } });
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

function open(head: string, body: string, runtime?: (selector: string, fn: (el: Element, signal: AbortSignal) => unknown) => void): W {
	const window: W = new Window({ url: "https://shop.test/", settings: { disableCSSFileLoading: true, handleDisabledFileLoadingAsSuccess: true } } as never);
	windows.push(window);
	for (const name of ["Map", "Set", "WeakMap", "Promise", "JSON", "Array", "Object", "Number", "String", "RegExp", "Error", "Math"]) if (window[name] === undefined) window[name] = (globalThis as W)[name];
	window.fetch = async (url: string) => (String(url).endsWith("/_a/site.mounts.json") ? new Response(MANIFEST, { headers: { "content-type": "application/json" } }) : new Response("", { status: 404 }));
	window.document.write(`<!doctype html><html><head><link rel="stylesheet" href="${C[0]}" nonce="n0" data-natsu-families="/_a/site.mounts.json">${head}</head><body>${body}</body></html>`);
	if (runtime) window.natsu = { mount: runtime };
	new Function("window", "document", `with (window) {${CODE}}`)(window, window.document);
	return window;
}
const sheets = (w: W) => [...w.document.querySelectorAll("link[rel=stylesheet]")].map((l: W) => l.getAttribute("href"));

describe("mount", () => {
	test("links the families its module can need in link order, then mounts each element once, importing once", async () => {
		const w = open(`<link rel="stylesheet" href="${C[3]}">`, "<div data-ab id=x></div><div data-ab id=y></div>");
		const seen: string[] = [];
		let imports = 0;
		let linkedFirst = false;
		w.__mount("[data-ab]", async () => {
			imports++;
			return { mount: (el: Element) => void (seen.push(el.id), (linkedFirst = sheets(w).includes(C[2]!))) };
		});
		await tick(10);
		expect(sheets(w)).toEqual([C[0], C[1], C[2], C[3]]);
		expect(seen.sort()).toEqual(["x", "y"]);
		expect(imports).toBe(1);
		expect(linkedFirst).toBe(true);
		expect(w.document.querySelector(`link[href="${C[1]}"]`).getAttribute("nonce")).toBe("n0");
	});

	test("a family the module needs only inside other markup is linked only when the page has it", async () => {
		const bare = open("", "<div data-x></div>");
		bare.__mount("[data-x]", async () => ({ mount: () => {} }));
		await tick(10);
		expect(sheets(bare)).toEqual([C[0]]);
		const hosted = open("", '<div class="host"><div data-x></div></div>');
		hosted.__mount("[data-x]", async () => ({ mount: () => {} }));
		await tick(10);
		expect(sheets(hosted)).toEqual([C[0], C[3]]);
	});

	test("an element a script adds later is mounted, and ended when it goes", async () => {
		const w = open("", "<main></main>");
		const log: string[] = [];
		w.__mount("[data-a]", async () => ({
			mount: (el: Element, signal: AbortSignal) => {
				log.push(`on ${el.id}`);
				signal.addEventListener("abort", () => log.push(`abort ${el.id}`));
				return () => log.push(`off ${el.id}`);
			},
		}));
		const el = w.document.createElement("div");
		el.id = "late";
		el.setAttribute("data-a", "");
		w.document.querySelector("main").append(el);
		await tick(10);
		expect(log).toEqual(["on late"]);
		expect(sheets(w)).toEqual([C[0], C[1]]);
		el.remove();
		await tick(10);
		expect(log).toEqual(["on late", "abort late", "off late"]);
	});

	test("with natsu's runtime on the page, mounts go through it and it ends them", async () => {
		const registered: Array<[string, (el: Element, signal: AbortSignal) => unknown]> = [];
		const w = open("", "<div data-a id=r></div>", (selector, fn) => void registered.push([selector, fn]));
		const log: string[] = [];
		w.__mount("[data-a]", async () => ({ mount: (el: Element) => (log.push(`on ${el.id}`), () => log.push(`off ${el.id}`)) }));
		expect(registered.map(([selector]) => selector)).toEqual(["[data-a]"]);
		const controller = new AbortController();
		const stop = registered[0]![1](w.document.getElementById("r"), controller.signal) as () => void;
		await tick(10);
		expect(log).toEqual(["on r"]);
		expect(registered[0]![1](w.document.getElementById("r"), controller.signal)).toBeUndefined();
		controller.abort();
		stop();
		expect(log).toEqual(["on r", "off r"]);
	});

	test("a family whose last copy ends up before one linking earlier is linked again, in order", async () => {
		const w = open(`<link rel="stylesheet" href="${C[1]}"><link rel="stylesheet" href="${C[3]}">`, "<div data-none></div>");
		w.__mount("[data-none]", async () => ({ mount: () => {} }));
		await tick(10);
		const b = w.document.createElement("link");
		b.rel = "stylesheet";
		b.href = C[2];
		w.document.head.append(b);
		await tick(10);
		const order = sheets(w);
		const last = (href: string) => order.lastIndexOf(href);
		expect(last(C[0]!)).toBeLessThan(last(C[1]!));
		expect(last(C[1]!)).toBeLessThan(last(C[2]!));
		expect(last(C[2]!)).toBeLessThan(last(C[3]!));
		expect(order.slice(0, 4)).toEqual([C[0], C[1], C[3], C[2]]);
	});
});

describe("critical styles and idle prefetch", () => {
	function openRaw(html: string, chunks?: unknown): { w: W; fetched: string[]; idles: Array<() => void> } {
		const window: W = new Window({ url: "https://shop.test/", settings: { disableCSSFileLoading: true, disableJavaScriptFileLoading: true, handleDisabledFileLoadingAsSuccess: true } } as never);
		windows.push(window);
		for (const name of ["Map", "Set", "WeakMap", "Promise", "JSON", "Array", "Object", "Number", "String", "RegExp", "Error", "Math", "URL"]) if (window[name] === undefined) window[name] = (globalThis as W)[name];
		const fetched: string[] = [];
		const idles: Array<() => void> = [];
		window.fetch = async (url: string) => {
			const path = String(url).replace("https://shop.test", "");
			fetched.push(path);
			if (path == "/_a/site.mounts.json") return new Response(MANIFEST, { headers: { "content-type": "application/json" } });
			if (path == "/_a/chunks.json" && chunks) return new Response(JSON.stringify(chunks), { headers: { "content-type": "application/json" } });
			return new Response("", { status: 404 });
		};
		window.requestIdleCallback = (fn: () => void) => (idles.push(fn), 0);
		window.document.write(html);
		Object.defineProperty(window.document, "readyState", { configurable: true, value: "complete" });
		new Function("window", "document", `with (window) {${CODE}}`)(window, window.document);
		return { w: window, fetched, idles };
	}
	const all = (w: W) => [...w.document.querySelectorAll("link[rel=stylesheet],style[data-natsu-critical]")].map((e: W) => e.getAttribute("data-natsu-critical") ?? e.getAttribute("href"));
	const doc = (head: string, body: string) => `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;
	const CORE = `<style data-natsu-critical="${C[0]}" nonce="n1" data-natsu-families="/_a/site.mounts.json">.core{}</style><link rel="preload" as="style" href="${C[0]}" data-natsu-warm>`;

	test("an inlined core sheet stands in for the core link: families link after it, with its nonce", async () => {
		const { w } = openRaw(doc(CORE + `<link rel="stylesheet" href="${C[3]}">`, "<div data-ab></div>"));
		let mounted = 0;
		w.__mount("[data-ab]", async () => ({ mount: () => void mounted++ }));
		await tick(10);
		expect(all(w)).toEqual([C[0], C[1], C[2], C[3]]);
		expect(mounted).toBe(1);
		expect(sheets(w)).toEqual([C[1], C[2], C[3]]);
		expect(w.document.querySelector(`link[href="${C[1]}"]`).getAttribute("nonce")).toBe("n1");
		expect(w.document.querySelector(`link[href="${C[2]}"]`).getAttribute("nonce")).toBe("n1");
	});

	test("an inlined family counts as that family on the page: it is not linked again", async () => {
		const { w } = openRaw(doc(CORE + `<style data-natsu-critical="${C[1]}" nonce="n1">.a{}</style>`, "<div data-ab></div>"));
		w.__mount("[data-ab]", async () => ({ mount: () => {} }));
		await tick(10);
		expect(all(w)).toEqual([C[0], C[1], C[2]]);
		expect(sheets(w)).toEqual([C[2]]);
	});

	test("an inlined family that ends up out of order is put back as a copy that keeps its rules", async () => {
		const { w } = openRaw(doc(CORE + `<style data-natsu-critical="${C[1]}" nonce="n1">.a{color:red}</style><link rel="stylesheet" href="${C[3]}">`, "<div data-none></div>"));
		w.__mount("[data-none]", async () => ({ mount: () => {} }));
		await tick(10);
		const b = w.document.createElement("link");
		b.rel = "stylesheet";
		b.href = C[2];
		w.document.head.append(b);
		await tick(10);
		const order = all(w);
		const last = (href: string) => order.lastIndexOf(href);
		expect(last(C[0]!)).toBeLessThan(last(C[1]!));
		expect(last(C[1]!)).toBeLessThan(last(C[2]!));
		expect(last(C[2]!)).toBeLessThan(last(C[3]!));
		expect(order.slice(0, 4)).toEqual([C[0], C[1], C[3], C[2]]);
		for (const style of w.document.querySelectorAll("style[data-natsu-critical]")) expect(style.textContent).not.toBe("");
		expect(w.document.querySelectorAll("[data-natsu-families]")).toHaveLength(1);
	});

	test("with the chunks meta tag, the first mount starts idle prefetch once; without it nothing is fetched for it", async () => {
		const chunks = { i: {}, m: { "/_a/app.js": [["[data-late]", "/_a/chunk.late.js"], ["[data-a]", "/_a/chunk.a.js"]] } };
		const head = `<link rel="stylesheet" href="${C[0]}" data-natsu-families="/_a/site.mounts.json"><script type="module" src="/_a/app.js"></script>`;
		const on = openRaw(doc(`<meta name="natsu-chunks" content="/_a/chunks.json">` + head, "<div data-a></div>"), chunks);
		on.w.__mount("[data-a]", async () => ({ mount: () => {} }));
		on.w.__mount("[data-late]", async () => ({ mount: () => {} }));
		await tick(10);
		expect(on.idles).toHaveLength(1);
		expect(on.fetched).not.toContain("/_a/chunks.json");
		for (const fn of on.idles.splice(0)) fn();
		await tick(10);
		expect(on.fetched.filter((path) => path == "/_a/chunks.json")).toHaveLength(1);
		expect([...on.w.document.querySelectorAll("link[data-natsu-prefetch]")].map((l: W) => `${l.getAttribute("rel")} ${l.getAttribute("href")}`)).toEqual(["prefetch /_a/chunk.a.js", "prefetch /_a/chunk.late.js"]);

		const off = openRaw(doc(head, "<div data-a></div>"), chunks);
		off.w.__mount("[data-a]", async () => ({ mount: () => {} }));
		await tick(10);
		expect(off.idles).toHaveLength(0);
		expect(off.fetched).not.toContain("/_a/chunks.json");
		expect(off.w.document.querySelectorAll("link[data-natsu-prefetch]")).toHaveLength(0);
	});
});
