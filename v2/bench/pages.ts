/**
 * What a page file costs against the same page written by hand.
 *
 * Both draw the same product page (the same uwu templates, compiled once:
 * a layout reading `categories` and `viewer`, a page reading `product`,
 * `reviews` and `params`) from the same two in-memory sources, with the
 * cache off, through `app.handle` (the whole natsu pipeline, no socket):
 *
 * - **page file**: `pages/p/[slug].uwu`, data found by name;
 * - **controller**: a handler that loads the three values with
 *   Promise.all, renders the page, then the layout around it;
 * - **page, kept**: the page file again with PageCache on (the default for a
 *   signed-out visitor), for scale.
 *
 * Rounds alternate between the two so neither gets a warmer machine.
 *
 *   bun run bench/pages.ts [--requests 20000] [--rounds 5]
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setConfig } from "../src/config.ts";
import type { Context } from "../src/context.ts";
import { setColorEnabled, setLogSink } from "../src/logger.ts";
import { navigable } from "../src/navigate.ts";
import { compilePageFile, evaluateServer, uwuRuntime } from "../src/pages/compile.ts";
import { source } from "../src/pages/data.ts";
import { mountPages } from "../src/pages/mount.ts";
import { Router } from "../src/router.ts";
import { Application } from "../src/server.ts";

setColorEnabled(false);
setLogSink(() => {});
setConfig({ General: { logFormat: "", logLevel: "silent" }, Session: { driver: "memory", sweepInterval: 0 }, Static: { enabled: false } });

const arg = (name: string, fallback: number): number => {
	const at = process.argv.indexOf(`--${name}`);
	return at > 0 ? Number(process.argv[at + 1]) : fallback;
};
const REQUESTS = arg("requests", 20_000);
const ROUNDS = arg("rounds", 5);

const LAYOUT = `<template><!doctype html><html lang="en"><head><meta charset="utf-8">{{{page.head}}}</head><body>
<header><nav>{{#each categories}}<a href="/c/{{slug}}">{{name}}</a>{{/each}}</nav>{{#if viewer}}<span>{{viewer.name}}</span>{{#else}}<a href="/login">Sign in</a>{{/if}}</header>
<main id="main" data-natsu-region>{{> @child}}</main><footer>footer</footer></body></html></template>`;
const PAGE = `<page cache="off"></page><template><h1>{{product.name}}</h1><p class="price">{{product.price}} EUR</p><p>{{product.summary}}</p>
<ul>{{#each reviews}}<li><b>{{author}}</b> {{body}} ({{stars}}/5)</li>{{/each}}</ul><a href="/p/{{params.slug}}/reviews">all reviews</a></template>`;

const product = { name: "Running shoe", price: 89, summary: "Light, quick, and kind to knees.", sku: "RS-1" };
const reviews = Array.from({ length: 10 }, (_, i) => ({ author: `reader ${i}`, body: "Comfortable from day one, would buy again.", stars: (i % 5) + 1 }));
const categories = Array.from({ length: 8 }, (_, i) => ({ slug: `c${i}`, name: `Category ${i}` }));
const loadProduct = async () => product;
const loadReviews = async () => reviews;
const loadCategories = async () => categories;

const dir = mkdtempSync(join(tmpdir(), "natsu-bench-pages-"));
mkdirSync(join(dir, "pages", "p"), { recursive: true });
writeFileSync(join(dir, "pages", "_layout.uwu"), LAYOUT);
writeFileSync(join(dir, "pages", "p", "[slug].uwu"), PAGE);
// The same page, kept by PageCache for signed-out visitors (the default).
mkdirSync(join(dir, "pages", "k"), { recursive: true });
writeFileSync(join(dir, "pages", "k", "[slug].uwu"), PAGE.replace(`<page cache="off"></page>`, ""));

source("product", loadProduct);
source("reviews", loadReviews);
source("categories", loadCategories);

const app = new Application();
await mountPages({ dir, app });

// The same templates, by hand.
const layout = await evaluateServer(compilePageFile(readFileSync(join(dir, "pages", "_layout.uwu"), "utf8"), "_layout.uwu").server, "layout");
const page = await evaluateServer(compilePageFile(readFileSync(join(dir, "pages", "p", "[slug].uwu"), "utf8"), "p/[slug].uwu").server, "page");
const renderToString = (await uwuRuntime()).renderToString as (fn: unknown, props: unknown, opts?: unknown) => Promise<string>;
const escape = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

new Router().get(
	"/h/:slug",
	navigable(async (ctx: Context) => {
		const [p, r, c] = await Promise.all([loadProduct(), loadReviews(), loadCategories()]);
		const body = await renderToString(page, { product: p, reviews: r, params: ctx.params });
		const head = `<title>${escape(p.name)}</title><link rel="canonical" href="http://127.0.0.1:8083${ctx.path}">`;
		ctx.response.type = "text/html; charset=utf-8";
		return renderToString(layout, { categories: c, viewer: null, page: { head } }, { child: body });
	}),
);

const BASE = "http://bench.test";
const pageRequest = () => app.handle(new Request(`${BASE}/p/:slug`), undefined, { slug: "shoe" });
const keptRequest = () => app.handle(new Request(`${BASE}/k/:slug`), undefined, { slug: "shoe" });
const handRequest = () => app.handle(new Request(`${BASE}/h/:slug`), undefined, { slug: "shoe" });

// The two answer the same page.
const a = await (await pageRequest()).text();
const b = await (await handRequest()).text();
const strip = (html: string) => html.replace(/<link rel="canonical"[^>]*>/, "");
if (strip(a) !== strip(b)) {
	console.error("the two pages differ:\n", a, "\n---\n", b);
	process.exit(1);
}

async function run(request: () => Promise<Response>, n: number): Promise<number[]> {
	const times: number[] = [];
	for (let i = 0; i < n; i++) {
		const started = Bun.nanoseconds();
		await (await request()).text();
		times.push((Bun.nanoseconds() - started) / 1000);
	}
	return times;
}

await run(pageRequest, 2000);
await run(handRequest, 2000);
await run(keptRequest, 2000);

const all = { page: [] as number[], hand: [] as number[], kept: [] as number[] };
for (let round = 0; round < ROUNDS; round++) {
	all.page.push(...(await run(pageRequest, REQUESTS / ROUNDS)));
	all.hand.push(...(await run(handRequest, REQUESTS / ROUNDS)));
	all.kept.push(...(await run(keptRequest, REQUESTS / ROUNDS)));
}

const stats = (times: number[]) => {
	const sorted = [...times].sort((x, y) => x - y);
	const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
	return { mean: times.reduce((s, t) => s + t, 0) / times.length, p50: at(0.5), p99: at(0.99) };
};
const page_ = stats(all.page);
const hand = stats(all.hand);
const row = (name: string, s: ReturnType<typeof stats>) =>
	`${name.padEnd(12)} mean ${s.mean.toFixed(1).padStart(6)} µs   p50 ${s.p50.toFixed(1).padStart(6)} µs   p99 ${s.p99.toFixed(1).padStart(6)} µs`;
console.log(`${REQUESTS} requests each, ${ROUNDS} alternating rounds, page ${a.length} bytes, Bun ${Bun.version}`);
console.log(row("page file", page_));
console.log(row("controller", hand));
console.log(row("page, kept", stats(all.kept)));
console.log(`page file / controller: mean ${(page_.mean / hand.mean).toFixed(2)}x, p50 ${(page_.p50 / hand.p50).toFixed(2)}x`);

rmSync(dir, { recursive: true, force: true });
