import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { clearActions } from "../src/pages/actions.ts";
import { clearSources, source } from "../src/pages/data.ts";
import { type PagesOptions, type PageSite, mountPages } from "../src/pages/mount.ts";
import { Application } from "../src/server.ts";
import { type RunningApp, reset, startApp } from "./helpers.ts";

let dir: string;
let running: RunningApp | undefined;
let site: PageSite | undefined;

beforeEach(() => {
	reset({ General: { logFormat: "", logLevel: "silent", url: "https://shop.test" } });
	clearSources();
	clearActions();
	dir = mkdtempSync(join(tmpdir(), "natsu-await-"));
});

afterEach(async () => {
	site?.close();
	site = undefined;
	await running?.stop();
	running = undefined;
	rmSync(dir, { recursive: true, force: true });
});

async function serve(files: Record<string, string>, options: Omit<PagesOptions, "dir"> = {}, setup?: (app: Application) => void) {
	for (const [file, text] of Object.entries(files)) {
		const full = join(dir, "pages", file);
		mkdirSync(dirname(full), { recursive: true });
		writeFileSync(full, text);
	}
	const app = new Application();
	setup?.(app);
	site = await mountPages({ dir, app, ...options });
	running = await startApp(app);
	return { get: (path: string, init?: RequestInit) => running!.fetch(path, init) };
}

const SWAP = /<script( nonce="[^"]*")?>\(window\.__uwuSwap/g;
const nonceOfSwap = (html: string): (string | undefined)[] => [...html.matchAll(SWAP)].map((m) => m[1]?.slice(8, -1));
const AWAIT = `<template><p>{{#await box.later as v}}{{v}}{{#loading}}wait{{/await}}</p></template>`;
const cspWith = (nonce: string) => (app: Application) => {
	app.use(async (ctx, next) => {
		ctx.response.headers.set("content-security-policy", `script-src 'nonce-${nonce}${ctx.headers.get("x-n") ?? ""}'`);
		return next();
	});
};

describe("the {{#await}} swap script under a CSP nonce", () => {
	test("carries the answer's own nonce", async () => {
		source("box", () => ({ later: Promise.resolve("done") }), { live: false });
		const { get } = await serve({ "index.uwu": AWAIT }, { cache: false }, cspWith("aaa"));
		const html = await (await get("/", { headers: { "x-n": "1" } })).text();
		expect(html).toContain("done");
		expect(nonceOfSwap(html)).toEqual(["aaa1"]);
		const next = await (await get("/", { headers: { "x-n": "2" } })).text();
		expect(nonceOfSwap(next)).toEqual(["aaa2"]);
	});

	test("without a CSP nonce the script is left as it is", async () => {
		source("box", () => ({ later: Promise.resolve("done") }), { live: false });
		const { get } = await serve({ "index.uwu": AWAIT }, { cache: false });
		expect(nonceOfSwap(await (await get("/")).text())).toEqual([undefined]);
	});

	test("a page kept for many visitors gives each its own nonce and keeps none", async () => {
		let draws = 0;
		source("box", () => ({ later: Promise.resolve(`done${++draws}`) }), { live: false });
		const { get } = await serve({ "index.uwu": AWAIT }, { cache: { fresh: 60 } }, cspWith("bbb"));
		const first = await (await get("/", { headers: { "x-n": "1" } })).text();
		const second = await (await get("/", { headers: { "x-n": "2" } })).text();
		const third = await (await get("/", { headers: { "x-n": "3" } })).text();
		expect(draws).toBe(1);
		expect(nonceOfSwap(first)).toEqual(["bbb1"]);
		expect(nonceOfSwap(second)).toEqual(["bbb2"]);
		expect(nonceOfSwap(third)).toEqual(["bbb3"]);
		expect(second).not.toContain("bbb1");
		expect(third).not.toContain("bbb2");
	});

	test("an app that hands the nonce in as a secret gets it on the script", async () => {
		source("box", () => ({ later: Promise.resolve("done") }), { live: false });
		const { get } = await serve(
			{ "index.uwu": AWAIT },
			{ cache: { fresh: 60 }, secrets: (ctx) => ({ nonce: ctx.headers.get("x-nonce") ?? "n0" }) },
		);
		expect(nonceOfSwap(await (await get("/", { headers: { "x-nonce": "abc" } })).text())).toEqual(["abc"]);
		expect(nonceOfSwap(await (await get("/", { headers: { "x-nonce": "xyz" } })).text())).toEqual(["xyz"]);
	});

	test("a script the data wrote that only looks like the swap gets no nonce", async () => {
		source("box", () => ({ later: Promise.resolve("done") }), { live: false });
		source("raw", () => `<script>(window.__uwuSwap||alert(1))("a","b");</script>`, { live: false });
		const { get } = await serve({ "index.uwu": `<template>{{{raw}}}${AWAIT.slice("<template>".length)}` }, { cache: false }, cspWith("ccc"));
		const html = await (await get("/")).text();
		expect(html).toContain(`<script>(window.__uwuSwap||alert(1))("a","b");</script>`);
		expect(nonceOfSwap(html)).toEqual([undefined, "ccc"]);
	});
});
