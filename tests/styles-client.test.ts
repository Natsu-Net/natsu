import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";

let CODE = "";
beforeAll(async () => {
	const out = await Bun.build({ entrypoints: [new URL("../src/client/styles.ts", import.meta.url).pathname], format: "esm" });
	CODE = (await out.outputs[0]!.text()).replace(/export\s*\{[^}]*\};?\s*$/, "window.__watch = watchStyles;");
});

type W = any;
const windows: W[] = [];
afterEach(async () => {
	for (const w of windows.splice(0)) await w.happyDOM.close();
});

const C = ["/_a/site.core.css", "/_a/site.card.css", "/_a/site.forum.css", "/_a/site.tray.css"];
const NEEDS = JSON.stringify({ c: C, m: {}, r: { 1: [["card"]], 2: [["forum-post"]], 3: [["tray", "is-open"]] } });
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

function open(head: string, body: string): W {
	const window: W = new Window({ url: "https://shop.test/", settings: { disableCSSFileLoading: true, handleDisabledFileLoadingAsSuccess: true } } as never);
	windows.push(window);
	for (const name of ["Map", "Set", "WeakMap", "Promise", "JSON", "Array", "Object", "Number", "String", "RegExp", "Error", "Math"]) if (window[name] === undefined) window[name] = (globalThis as W)[name];
	window.fetch = async (url: string) => (String(url).endsWith("/_a/site.needs.json") ? new Response(NEEDS, { headers: { "content-type": "application/json" } }) : new Response("", { status: 404 }));
	window.document.write(`<!doctype html><html><head><link rel="stylesheet" href="${C[0]}" nonce="n0" data-natsu-families="/_a/site.needs.json">${head}</head><body>${body}</body></html>`);
	new Function("window", "document", `with (window) {${CODE}}`)(window, window.document);
	window.__watch();
	return window;
}
const sheets = (w: W) => [...w.document.querySelectorAll("link[rel=stylesheet]")].map((l: W) => l.getAttribute("href"));

describe("watchStyles", () => {
	test("links a segment the markup needs but the page lacks, in its place, with the core's nonce", async () => {
		const w = open(`<link rel="stylesheet" href="${C[2]}">`, '<div class="card"></div>');
		await tick(10);
		expect(sheets(w)).toEqual([C[0], C[1], C[2]]);
		expect(w.document.querySelector(`link[href="${C[1]}"]`).getAttribute("nonce")).toBe("n0");
	});

	test("links a segment when a script adds an element that needs it, once", async () => {
		const w = open("", "<main></main>");
		await tick(10);
		expect(sheets(w)).toEqual([C[0]]);
		w.document.querySelector("main").innerHTML = '<article class="forum-post"><p class="forum-post">x</p></article>';
		await tick(10);
		w.document.querySelector("main").insertAdjacentHTML("beforeend", '<p class="forum-post">y</p>');
		await tick(10);
		expect(sheets(w)).toEqual([C[0], C[2]]);
	});

	test("waits for every class of a list, read from class changes too", async () => {
		const w = open("", '<aside class="tray"></aside>');
		await tick(10);
		expect(sheets(w)).toEqual([C[0]]);
		w.document.querySelector("aside").classList.add("is-open");
		await tick(10);
		expect(sheets(w)).toEqual([C[0], C[3]]);
	});

	test("ignores classes no segment needs", async () => {
		const w = open("", "<main></main>");
		await tick(10);
		w.document.querySelector("main").innerHTML = '<p class="other">x</p>';
		await tick(10);
		expect(sheets(w)).toEqual([C[0]]);
	});
});
