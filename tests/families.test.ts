/**
 * `"families"` chunking: each stylesheet cut once into a core and families
 * every page shares (uwu-template's `partitionCSS`).
 *
 * What matters here is the wiring: a page links the core and the families
 * its classes or its scripts need, in one fixed order whatever the page, so
 * two pages that need the same families send the same links; an island's
 * answer says which families it needs; and the default stays per-page
 * slicing. The cascade itself is proven in uwu-template's browser suite.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Assets, type AssetsOptions } from "../src/assets.ts";
import { island } from "../src/navigate.ts";
import { Router } from "../src/router.ts";
import { Application } from "../src/server.ts";
import { reset } from "./helpers.ts";

const BASE = "http://localhost";
const BASE_CSS = "body { margin: 0 } .btn { padding: 4px } .muted { opacity: .6 }";
const MU_CSS = Array.from({ length: 30 }, (_, i) => `.mu-card__part${i} { margin-left: ${i}px }`).join("\n");
const PM_CSS = Array.from({ length: 30 }, (_, i) => `.pm-row__cell${i} { padding-left: ${i}px }`).join("\n");

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "natsu-families-"));
	writeFileSync(join(dir, "site.css"), BASE_CSS);
	writeFileSync(join(dir, "music.css"), MU_CSS);
	writeFileSync(join(dir, "permissions.css"), PM_CSS);
	reset();
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

async function pipeline(extra: Partial<AssetsOptions> = {}) {
	const assets = new Assets({
		outDir: join(dir, "out"),
		styles: { site: [join(dir, "site.css"), join(dir, "music.css"), join(dir, "permissions.css")] },
		rewrite: { "/css/site.css": "site", "/js/app.js": "app" },
		minify: true,
		chunking: { mode: "families", minBytes: 100 },
		...extra,
	});
	const report = await assets.build();
	const app = new Application();
	app.use(assets.middleware());
	return { assets, app, report };
}

const get = (app: Application, path: string, headers: Record<string, string> = {}) => app.handle(new Request(`${BASE}${path}`, { headers }));
const page = (body: string, head = "") => `<!doctype html><html><head><link rel="stylesheet" href="/css/site.css" media="all">${head}</head><body>${body}</body></html>`;
const sheets = (html: string) => [...html.matchAll(/<link rel="stylesheet" href="([^"]+)" media="all">/g)].map((m) => m[1]!);

describe("families chunking", () => {
	test("is cut once at build and reported", async () => {
		const { report } = await pipeline();
		const site = report.families!.site!;
		expect(site.chunks.map((chunk) => chunk.name)).toEqual(["core", "mu", "pm"]);
		expect(site.chunks.every((chunk) => /^\/_a\/site\.([\w-]+\.)?[0-9a-f]{10}\.css$/.test(chunk.url))).toBe(true);
		expect(site.core.bytes).toBeLessThan(BASE_CSS.length);
	});

	test("a page links the core and the families its classes need, each a copy of its link, in one order", async () => {
		new Router().get("/plain", () => page('<p class="btn">x</p>'));
		new Router().get("/music", () => page('<div class="mu-card__part3 btn">x</div>'));
		new Router().get("/both", () => page('<div class="pm-row__cell1"></div><div class="mu-card__part3"></div>'));
		const { app, report } = await pipeline();
		const urls = report.families!.site!.chunks.map((chunk) => chunk.url);
		expect(sheets(await (await get(app, "/plain")).text())).toEqual([urls[0]!]);
		expect(sheets(await (await get(app, "/music")).text())).toEqual([urls[0]!, urls[1]!]);
		expect(sheets(await (await get(app, "/both")).text())).toEqual(urls);
	});

	test("two pages with the same families send the same links", async () => {
		new Router().get("/a", () => page('<div class="mu-card__part3">a</div>'));
		new Router().get("/b", () => page('<section class="mu-card__part9 muted">b</section>'));
		const { app } = await pipeline();
		const links = async (path: string) => /<head>([\s\S]*?)<\/head>/.exec(await (await get(app, path)).text())![1];
		expect(await links("/a")).toBe(await links("/b"));
	});

	test("every chunk is served immutable, and a family chunk nobody has is empty for a while", async () => {
		const { app, report } = await pipeline();
		for (const chunk of report.families!.site!.chunks) {
			const answer = await get(app, chunk.url);
			expect(answer.headers.get("cache-control")).toContain("immutable");
		}
		const missing = await get(app, "/_a/site.mu.0123456789.css");
		expect(missing.headers.get("cache-control")).toBe("public, max-age=300");
		expect(await missing.text()).toBe("");
		expect(await (await get(app, "/_a/site.0123456789.css")).text()).toContain(".pm-row__cell1");
	});

	test("a page gets the families a script it links can write: built, imported later, inline, or named", async () => {
		writeFileSync(join(dir, "app.js"), 'document.body.addEventListener("click", () => import("./later.js"));\n');
		writeFileSync(join(dir, "later.js"), 'export const draw = (el) => el.classList.add("pm-row__cell2");\n');
		writeFileSync(join(dir, "static.js"), 'el.className = "mu-" + "card__part" + n;\n');
		new Router().get("/built", () => page("<p>x</p>", '<script type="module" src="/js/app.js"></script>'));
		new Router().get("/inline", () => page('<p>x</p><script>el.className = "mu-card__part4"</script>'));
		new Router().get("/named", () => page("<p>x</p>", '<script src="/js/static.js?v=2" defer></script>'));
		new Router().get("/selector", () => page('<p>x</p><script>document.querySelector(".pm-row__cell2")</script>'));
		const { app, report } = await pipeline({
			scripts: { app: join(dir, "app.js") },
			chunking: { mode: "families", minBytes: 100, scripts: { "/js/static.js": join(dir, "static.js") } },
		});
		const names = async (path: string) => sheets(await (await get(app, path)).text()).map((url) => report.families!.site!.chunks.find((chunk) => chunk.url === url)!.name);
		expect(await names("/built")).toEqual(["core", "pm"]);
		expect(await names("/inline")).toEqual(["core", "mu"]);
		expect(await names("/named")).toEqual(["core", "mu"]);
		expect(await names("/selector")).toEqual(["core"]);
	});

	test("an island's answer links the families it needs, and every one after them, at its start", async () => {
		new Router().get("/bell", island(() => '<p class="mu-card__part3">3 new</p>'));
		new Router().get("/plain-bell", island(() => '<p class="btn">0</p>'));
		const { app, report } = await pipeline({ navigate: true });
		const urls = report.families!.site!.chunks.map((chunk) => chunk.url);
		const answer = await (await get(app, "/bell", { "natsu-island": "1" })).text();
		expect(answer).toBe(`<link rel="stylesheet" href="${urls[1]}"><link rel="stylesheet" href="${urls[2]}"><p class="mu-card__part3">3 new</p>`);
		expect(await (await get(app, "/plain-bell", { "natsu-island": "1" })).text()).toBe('<p class="btn">0</p>');
	});

	test("prefetch links the other families, never for a visitor saving data", async () => {
		new Router().get("/music", () => page('<div class="mu-card__part3">x</div>'));
		const { app, report } = await pipeline({ chunking: { mode: "families", minBytes: 100, prefetch: true } });
		const pm = report.families!.site!.chunks[2]!.url;
		expect(await (await get(app, "/music")).text()).toContain(`<link rel="prefetch" href="${pm}" data-natsu-prefetch>`);
		expect(await (await get(app, "/music", { "save-data": "on" })).text()).not.toContain("prefetch");
	});

	test("the safelist counts as classes every page has", async () => {
		new Router().get("/plain", () => page("<p>x</p>"));
		const { app } = await pipeline({ safelist: ["pm-row__cell7"] });
		expect(sheets(await (await get(app, "/plain")).text()).length).toBe(2);
	});

	test("the default is still one slice per page", async () => {
		new Router().get("/music", () => page('<div class="mu-card__part3">x</div>'));
		const { app, report } = await pipeline({ chunking: undefined });
		expect(report.families).toBeUndefined();
		const linked = sheets(await (await get(app, "/music")).text());
		expect(linked.length).toBe(1);
		const css = await (await get(app, linked[0]!)).text();
		expect(css).toContain(".mu-card__part3");
		expect(css).not.toContain(".mu-card__part4");
	});
});

describe("mount()", () => {
	const MOUNT = join(import.meta.dir, "..", "src", "client", "mount.ts");
	async function mounts() {
		writeFileSync(join(dir, "app.js"), `import { mount } from ${JSON.stringify(MOUNT)};\nmount("[data-editor]", () => import("./editor.js"));\nconst which = location.hash;\nmount(which, () => import("./other.js"));\nif (window.later) import("./late.js");\n`);
		writeFileSync(join(dir, "editor.js"), 'export function mount(el) { el.className = "pm-row__cell2"; }\n');
		writeFileSync(join(dir, "other.js"), 'export function mount(el) { el.className = "mu-card__part5"; }\n');
		writeFileSync(join(dir, "late.js"), "export const late = 1;\n");
		new Router().get("/with", () => page('<div data-editor></div>', '<script type="module" src="/js/app.js"></script>'));
		new Router().get("/without", () => page("<p>x</p>", '<script type="module" src="/js/app.js"></script>'));
		return pipeline({ scripts: { app: join(dir, "app.js") } });
	}
	const names = (report: Awaited<ReturnType<typeof pipeline>>["report"], html: string) =>
		sheets(html.replace(/ data-natsu-families="[^"]*"/, "")).map((url) => report.families!.site!.chunks.find((chunk) => chunk.url === url)!.name);

	test("a module loaded through mount counts only for pages its selector may match", async () => {
		const { app, report } = await mounts();
		expect(names(report, await (await get(app, "/with")).text())).toEqual(["core", "mu", "pm"]);
		expect(names(report, await (await get(app, "/without")).text())).toEqual(["core", "mu"]);
	});

	test("the report lists each mount and what else the entry imports later", async () => {
		const { report } = await mounts();
		const app = report.mounts!.app!;
		expect(app.sites.map((site) => [site.selector, site.families])).toEqual([["[data-editor]", ["site.pm"]]]);
		expect(app.dynamic.length).toBe(2);
	});

	test("the core link names the manifest the client reads, an immutable file", async () => {
		const { app, report } = await mounts();
		const html = await (await get(app, "/without")).text();
		const urls = report.families!.site!.chunks.map((chunk) => chunk.url);
		const manifest = /data-natsu-families="([^"]*)"/.exec(html)![1]!;
		const answer = await get(app, manifest);
		expect(answer.headers.get("cache-control")).toContain("immutable");
		expect(await answer.json()).toEqual({ c: urls, m: { "[data-editor]": { 2: [[]] } } });
		expect(sheets(html.replace(/ data-natsu-families="[^"]*"/, ""))).toEqual([urls[0]!, urls[1]!]);
	});
});
