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
const MANIFEST = JSON.stringify({ c: C, m: { "[data-a]": [1], "[data-ab]": [1, 2] } });
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

function open(head: string, body: string, runtime?: (selector: string, fn: (el: Element, signal: AbortSignal) => unknown) => void): W {
	const window: W = new Window({ url: "https://shop.test/", settings: { disableCSSFileLoading: true, handleDisabledFileLoadingAsSuccess: true } } as never);
	windows.push(window);
	for (const name of ["Map", "Set", "WeakMap", "Promise", "JSON", "Array", "Object", "Number", "String", "RegExp", "Error", "Math"]) if (window[name] === undefined) window[name] = (globalThis as W)[name];
	window.document.write(`<!doctype html><html><head><link rel="stylesheet" href="${C[0]}" nonce="n0" data-natsu-families='${MANIFEST}'>${head}</head><body>${body}</body></html>`);
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
		const w = open(`<link rel="stylesheet" href="${C[1]}"><link rel="stylesheet" href="${C[3]}">`, "");
		w.__mount("[data-none]", async () => ({ mount: () => {} }));
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
