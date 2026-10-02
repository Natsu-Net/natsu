/**
 * The asset pipeline.
 *
 * Three claims worth proving: a page gets only the rules it can use, two
 * pages that need the same rules get one file, and a chunk's URL changes when
 * its contents do — because the cache header says `immutable` for a year, and
 * that is only safe if it is true.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Assets } from "../src/assets.ts";
import type { Context } from "../src/context.ts";
import { compress } from "../src/compress.ts";
import { PageCache } from "../src/page-cache.ts";
import { Application } from "../src/server.ts";
import { Router } from "../src/router.ts";
import { reset, startApp, type RunningApp } from "./helpers.ts";

const CSS = `
:root { --accent: hotpink; }
body { margin: 0; }
.card { border: 1px solid; }
.card__title { font-weight: 600; }
.admin-table { width: 100%; }
.admin-table th { text-align: left; }
.is-open { display: block; }
`;

let dir: string;
let out: string;
let running: RunningApp | undefined;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "natsu-assets-"));
	out = join(dir, "out");
	writeFileSync(join(dir, "site.css"), CSS);
});

afterEach(async () => {
	await running?.stop();
	running = undefined;
	rmSync(dir, { recursive: true, force: true });
});

function assets(extra: Record<string, unknown> = {}) {
	return new Assets({
		outDir: out,
		styles: { site: [join(dir, "site.css")] },
		minify: true,
		...extra,
	});
}

describe("chunking", () => {
	test("a page gets the rules it can use and not the ones it cannot", async () => {
		const pipeline = assets({ rewrite: { "/assets/css/site.css": "site" } });
		await pipeline.build();
		reset();
		new Router().get("/page", (ctx) => {
			ctx.response.body = '<html><head><link rel="stylesheet" href="/assets/css/site.css"></head>' +
				'<body><div class="card"><h3 class="card__title">x</h3></div></body></html>';
		});
		const app = new Application();
		app.use(pipeline.middleware());
		running = await startApp(app);

		const page = await (await running.fetch("/page")).text();
		const href = /href="([^"]+)"/.exec(page)?.[1] ?? "";
		expect(href).toStartWith("/_a/site.");

		const css = await (await running.fetch(href)).text();
		expect(css).toContain(".card");
		expect(css).toContain("--accent");
		// The admin table is not on this page, so it is not in its chunk.
		expect(css).not.toContain("admin-table");
	});

	test("pages that differ only in what no rule names share one chunk, cut once", async () => {
		const pipeline = assets();
		await pipeline.build();
		const shapes = () => (pipeline as unknown as { pages: Map<string, unknown> }).pages.size;
		const before = shapes();
		const one = pipeline.pageStyle("site", '<div class="card" id="review-1"><b class="extra-1">a</b></div>');
		const two = pipeline.pageStyle("site", '<section class="card" id="review-2"><i class="extra-2">b</i></section>');
		expect(two).toBe(one);
		expect(shapes()).toBe(before + 1);
		// A class a rule names is a different page.
		const admin = pipeline.pageStyle("site", '<div class="card admin-table">c</div>');
		expect(admin).not.toBe(one);
		expect(await read(pipeline, admin)).toContain("admin-table");
		expect(await read(pipeline, one)).not.toContain("admin-table");
	});

	test("one class with a comma in its name is not the two classes either side of it", async () => {
		writeFileSync(join(dir, "site.css"), String.raw`.a\,b{color:red}.a{color:green}.b{color:blue}`);
		const pipeline = assets();
		await pipeline.build();
		const one = pipeline.pageStyle("site", '<p class="a,b">x</p>');
		const two = pipeline.pageStyle("site", '<p class="a b">x</p>');
		expect(two).not.toBe(one);
		expect(await read(pipeline, two)).toContain("green");
	});

	test("a class only a script adds survives if it is safelisted", async () => {
		// A page's markup shows what the server rendered. `is-open` arrives on
		// click, so without a safelist the rule that styles it is dropped and
		// the menu silently stops opening.
		const bare = assets();
		await bare.build();
		const without = bare.pageStyle("site", "<body><p>nothing</p></body>");

		const kept = assets({ safelist: ["is-open"] });
		await kept.build();
		const with_ = kept.pageStyle("site", "<body><p>nothing</p></body>");

		expect(await read(bare, without)).not.toContain("is-open");
		expect(await read(kept, with_)).toContain("is-open");
	});
});

describe("rewriting", () => {
	test("a script src becomes its hashed chunk, and an unlisted path is left alone", async () => {
		writeFileSync(join(dir, "site.js"), 'export const hi = () => console.log("hi");\n');
		reset();
		const pipeline = new Assets({
			outDir: out,
			scripts: { site: join(dir, "site.js") },
			rewrite: { "/assets/js/site.js": "site" },
			minify: true,
		});
		await pipeline.build();
		new Router().get("/page", (ctx) => {
			ctx.response.body = '<html><body><script src="/assets/js/site.js"></script>' +
				'<script src="/assets/js/other.js"></script></body></html>';
		});
		const app = new Application();
		app.use(pipeline.middleware());
		running = await startApp(app);

		const page = await (await running.fetch("/page")).text();
		expect(page).toContain(`src="${pipeline.url("site")}"`);
		// Nothing the caller did not name is touched.
		expect(page).toContain('src="/assets/js/other.js"');
	});
});

describe("pages kept rewritten", () => {
	test("a page a PageCache kept rewritten goes out as it is, every time", async () => {
		const pipeline = assets({ rewrite: { "/assets/css/site.css": "site" } });
		await pipeline.build();
		const rewrite = pipeline.rewrite.bind(pipeline);
		let rewrites = 0;
		pipeline.rewrite = (html: string) => {
			rewrites++;
			return rewrite(html);
		};
		const pages = new PageCache({ prepare: (html) => pipeline.rewrite(html) });
		reset();
		new Router().get("/page", async (ctx) => {
			const nonce = crypto.randomUUID();
			const page = await pages.serve("/page", [nonce], async ([mark]) => ({
				body: `<html><head><link rel="stylesheet" href="/assets/css/site.css"><script nonce="${mark}"></script></head>` +
					'<body><div class="card">x</div></body></html>',
				status: 200,
			}));
			if (page?.prepared) pipeline.markRewritten(ctx);
			ctx.response.body = page?.body ?? "";
		});
		const app = new Application();
		app.use(pipeline.middleware());
		running = await startApp(app);

		const first = await (await running.fetch("/page")).text();
		const second = await (await running.fetch("/page")).text();
		expect(rewrites).toBe(1);
		for (const page of [first, second]) {
			expect(page).toContain(`href="/_a/site.`);
			expect(page).not.toContain("natsu-secret-");
		}
		expect(first.replace(/nonce="[^"]+"/, "")).toBe(second.replace(/nonce="[^"]+"/, ""));
		expect(first).not.toBe(second);
	});
});

describe("script formats", () => {
	test("modules that share an import ship it once; a classic script is never split", async () => {
		writeFileSync(join(dir, "lib.js"), "export const shared = () => 42;\n");
		writeFileSync(join(dir, "a.js"), 'import { shared } from "./lib.js"; console.log(shared());\n');
		writeFileSync(join(dir, "b.js"), 'import { shared } from "./lib.js"; console.log(shared() + 1);\n');
		writeFileSync(join(dir, "old.js"), '(function () { window.legacy = true; })();\n');

		const pipeline = new Assets({
			outDir: out,
			scripts: { a: join(dir, "a.js"), b: join(dir, "b.js") },
			classicScripts: { old: join(dir, "old.js") },
			minify: true,
		});
		const report = await pipeline.build();

		// The shared module became its own chunk rather than being copied
		// into both entry points.
		expect(report.shared.length).toBeGreaterThan(0);

		// A classic script is loaded by a bare <script src>, which cannot
		// execute an import. Its bundle has to stand alone.
		const legacy = await read(pipeline, pipeline.url("old"));
		expect(legacy).not.toContain("import");
		expect(legacy).toContain("legacy");
	});
});

describe("deduplication", () => {
	test("two pages that need the same rules share one chunk", async () => {
		const pipeline = assets();
		await pipeline.build();

		const a = pipeline.pageStyle("site", '<body><div class="card">one</div></body>');
		const b = pipeline.pageStyle("site", '<body><div class="card">two — different words, same shape</div></body>');
		expect(a).toBe(b);
	});

	test("two pages that need different rules do not", async () => {
		const pipeline = assets();
		await pipeline.build();

		const a = pipeline.pageStyle("site", '<body><div class="card">x</div></body>');
		const b = pipeline.pageStyle("site", '<body><table class="admin-table"><tr><th>x</th></tr></table></body>');
		expect(a).not.toBe(b);
	});
});

describe("the URL carries the hash", () => {
	test("so two different chunks are never the same URL", async () => {
		const pipeline = assets();
		await pipeline.build();
		const a = pipeline.pageStyle("site", '<body><div class="card">x</div></body>');
		const b = pipeline.pageStyle("site", '<body><table class="admin-table"><th>x</th></table></body>');
		expect(a).not.toBe(b);
		expect(a).toMatch(/^\/_a\/site\.[0-9a-f]{10}\.css$/);
	});

	test("and a chunk is served immutable", async () => {
		reset();
		const pipeline = assets();
		await pipeline.build();
		const app = new Application();
		app.use(pipeline.middleware());
		running = await startApp(app);

		const response = await running.fetch(pipeline.url("site"));
		expect(response.headers.get("cache-control")).toContain("immutable");
		expect(response.headers.get("content-type")).toContain("text/css");
	});

	test("a chunk that is not there is a miss, not a leak", async () => {
		reset();
		const pipeline = assets();
		await pipeline.build();
		const app = new Application();
		app.use(pipeline.middleware());
		running = await startApp(app);

		// Anything in the path that tries to climb out is reduced to a name.
		expect((await running.fetch("/_a/../../etc/passwd")).status).toBeGreaterThanOrEqual(400);
		expect((await running.fetch("/_a/nope.css")).status).toBe(404);
	});
});

/** The chunk files a pipeline holds in memory. */
const heldFiles = (pipeline: Assets) => (pipeline as unknown as { files: Map<string, unknown> }).files;

describe("after a restart", () => {
	test("a chunk the last process built is served from disk, still immutable", async () => {
		reset();
		const first = assets();
		await first.build();
		const url = first.pageStyle("site", '<body><div class="card">x</div></body>');
		await first.settled();

		const second = assets();
		await second.build();
		const app = new Application();
		app.use(second.middleware());
		running = await startApp(app);

		const response = await running.fetch(url);
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toContain("immutable");
		const body = await response.text();
		expect(body).toContain(".card");
		expect(body).not.toContain("admin-table");
	});

	test("a chunk cut short on disk is never served as that chunk", async () => {
		reset();
		const first = assets();
		await first.build();
		const url = first.pageStyle("site", '<body><div class="card">x</div></body>');
		await first.settled();
		const file = join(out, url.slice("/_a/".length));
		writeFileSync(file, ".card{bor");

		const second = assets();
		await second.build();
		const app = new Application();
		app.use(second.middleware());
		running = await startApp(app);

		const response = await running.fetch(url);
		expect(response.headers.get("cache-control")).toBe("public, max-age=300");
		expect(await response.text()).toContain("admin-table");
		// Built again here, the real chunk is served and put back on disk.
		expect(second.pageStyle("site", '<body><div class="card">x</div></body>')).toBe(url);
		await second.settled();
		const again = await running.fetch(url);
		expect(again.headers.get("cache-control")).toContain("immutable");
		expect(await again.text()).not.toBe(".card{bor");
		expect(await Bun.file(file).text()).not.toBe(".card{bor");
	});

	test("a chunk nobody has gets the whole stylesheet for a while, so the page stays styled", async () => {
		reset();
		const pipeline = assets();
		await pipeline.build();
		const app = new Application();
		app.use(pipeline.middleware());
		running = await startApp(app);

		const stand = await running.fetch("/_a/site.0123456789.css");
		expect(stand.status).toBe(200);
		expect(stand.headers.get("cache-control")).toBe("public, max-age=300");
		const body = await stand.text();
		expect(body).toContain(".card");
		expect(body).toContain("admin-table");
		const later = await running.fetch("/_a/site-later.0123456789.css");
		expect(later.status).toBe(200);
		expect(await later.text()).toBe("");
		// A name that no stylesheet was cut from is still a miss.
		expect((await running.fetch("/_a/other.0123456789.css")).status).toBe(404);
	});

	test("with renamed classes there is no stand-in: another build named them differently", async () => {
		reset();
		const views = join(dir, "views");
		mkdirSync(views);
		writeFileSync(join(views, "page.html"), '<div class="card"></div>');
		const pipeline = assets({ mangle: { scripts: [], markup: [views] } });
		await pipeline.build();
		const app = new Application();
		app.use(pipeline.middleware());
		running = await startApp(app);
		expect((await running.fetch("/_a/site.0123456789.css")).status).toBe(404);
	});
});

describe("compression", () => {
	test("a chunk goes out as brotli made off the request path", async () => {
		reset();
		const pipeline = assets();
		await pipeline.build();
		const app = new Application();
		app.use(pipeline.middleware());
		running = await startApp(app);
		await pipeline.settled();

		const response = await running.fetch(pipeline.url("site"), { headers: { "accept-encoding": "br" }, decompress: false } as RequestInit);
		expect(response.headers.get("content-encoding")).toBe("br");
		expect(response.headers.get("vary")).toBe("Accept-Encoding");
		const plain = await running.fetch(pipeline.url("site"), { headers: { "accept-encoding": "identity" } });
		expect(plain.headers.get("content-encoding")).toBeNull();
		expect(await plain.text()).toContain(".card");
	});

	test("a chunk asked for before its copies are ready waits for them", async () => {
		reset();
		const pipeline = assets();
		await pipeline.build();
		const app = new Application();
		app.use(compress());
		app.use(pipeline.middleware());
		running = await startApp(app);

		const url = pipeline.pageStyle("site", '<body><div class="card"><h3 class="card__title">x</h3></div></body>');
		const response = await running.fetch(url, { headers: { "accept-encoding": "br" }, decompress: false } as RequestInit);
		expect(response.headers.get("content-encoding")).toBe("br");
		// compress() saw an encoded body and left it, so Vary is said once.
		expect(response.headers.get("vary")).toBe("Accept-Encoding");
	});
});

describe("page shapes", () => {
	test("past the limit the oldest shape leaves memory, and is served from disk", async () => {
		reset();
		const pipeline = assets({ maxPageShapes: 1 });
		await pipeline.build();
		const a = pipeline.pageStyle("site", '<body><div class="card">x</div></body>');
		const b = pipeline.pageStyle("site", '<body><table class="admin-table"><th>x</th></table></body>');
		expect(a).not.toBe(b);
		expect(heldFiles(pipeline).has(a.slice("/_a/".length))).toBe(false);
		await pipeline.settled();
		const app = new Application();
		app.use(pipeline.middleware());
		running = await startApp(app);
		const response = await running.fetch(a);
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toContain("immutable");
		expect(await response.text()).toContain(".card");
		// The forgotten shape builds the same chunk again.
		expect(pipeline.pageStyle("site", '<body><div class="card">x</div></body>')).toBe(a);
	});

	test("a file from disk whose name carries no hash of ours is not cached for long", async () => {
		reset();
		mkdirSync(out, { recursive: true });
		writeFileSync(join(out, "module.7ethw6b4.js"), "export const a = 1;");
		const pipeline = assets();
		await pipeline.build();
		const app = new Application();
		app.use(pipeline.middleware());
		running = await startApp(app);
		const response = await running.fetch("/_a/module.7ethw6b4.js");
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("public, max-age=300");
	});

	test("chunks read back from disk count against the same limit", async () => {
		reset();
		const first = assets();
		await first.build();
		const urls = ["card", "card__title", "admin-table", "is-open"].map((name) =>
			first.pageStyle("site", `<body><div class="${name}">x</div></body>`)
		);
		await first.settled();

		const second = assets({ maxPageShapes: 2 });
		await second.build();
		const app = new Application();
		app.use(second.middleware());
		running = await startApp(app);
		const before = heldFiles(second).size;
		for (const url of urls) expect((await running.fetch(url)).status).toBe(200);
		expect(heldFiles(second).size).toBe(before + 2);
	});

	test("a lazy half two shapes share stays while either is remembered", async () => {
		reset();
		const pipeline = assets({
			maxPageShapes: 1,
			safelist: ["admin-table"],
			lazyStyles: { whenPresent: { card: ["is-open"] } },
			rewrite: { "/assets/css/site.css": "site" },
		});
		await pipeline.build();
		const page = (html: string) => pipeline.rewrite(`<link rel="stylesheet" href="/assets/css/site.css">${html}`);
		const first = page('<div class="card"></div>');
		const second = page('<div class="card__title"></div>');
		const laterOf = (html: string) => /"(\/_a\/site-later\.[^"]+)"/.exec(html)?.[1] ?? "";
		expect(laterOf(first)).toBe(laterOf(second));
		expect(laterOf(second)).not.toBe("");
		// The first shape is forgotten; the lazy half the second still links stays.
		expect(heldFiles(pipeline).has(laterOf(second).slice("/_a/".length))).toBe(true);
	});

	test("with wholeStylesheets a page links the whole sheet", async () => {
		const pipeline = assets({ wholeStylesheets: true, rewrite: { "/site.css": "site" } });
		await pipeline.build();
		const html = '<html><head><link rel="stylesheet" href="/site.css"></head><body class="card"></body></html>';
		expect(pipeline.rewrite(html)).toContain(pipeline.url("site"));
	});

	test("after another build, a shape seen before is cut from the sheet that build read", async () => {
		const pipeline = assets();
		await pipeline.build();
		const html = '<body><div class="card">x</div></body>';
		const first = pipeline.pageStyle("site", html);
		writeFileSync(join(dir, "site.css"), CSS.replace(".card { border: 1px solid; }", ".card { border: 2px dashed; }"));
		await pipeline.build();
		const second = pipeline.pageStyle("site", html);
		expect(second).not.toBe(first);
		const body = (heldFiles(pipeline).get(second.slice("/_a/".length)) as { body: string }).body;
		expect(body).toContain("dashed");
	});
});

describe("minification", () => {
	test("is on when asked and off when not", async () => {
		const small = assets({ minify: true });
		await small.build();
		const large = assets({ minify: false });
		await large.build();

		const report = await small.build();
		expect(report.sizes.site!.to).toBeLessThan(report.sizes.site!.from);
		expect(small.url("site")).not.toBe(large.url("site"));
	});
});

describe("what is left alone", () => {
	test("an API answer that mentions an asset path is not a page", async () => {
		reset();
		const pipeline = assets({ rewrite: { "/assets/css/site.css": "site" } });
		await pipeline.build();
		new Router().get("/api/thing", (ctx) => {
			ctx.response.headers.set("content-type", "application/json; charset=utf-8");
			ctx.response.body = JSON.stringify({ stylesheet: "/assets/css/site.css" });
		});
		const app = new Application();
		app.use(pipeline.middleware());
		running = await startApp(app);

		const body = await (await running.fetch("/api/thing")).text();
		expect(JSON.parse(body).stylesheet).toBe("/assets/css/site.css");
	});
});

describe("vendor files", () => {
	test("a file is served byte for byte under a name that carries its hash", async () => {
		const vendor = '/*! vendor */(function(){window.V=1})();\n';
		writeFileSync(join(dir, "vendor.js"), vendor);
		const pipeline = new Assets({ outDir: out, files: { lib: join(dir, "vendor.js") }, minify: true });
		await pipeline.build();
		const url = pipeline.url("lib");
		expect(url).toMatch(/^\/_a\/lib\.[0-9a-f]{10}\.js$/);
		expect(await read(pipeline, url)).toBe(vendor);
	});
});

describe("renaming classes", () => {
	test("markup and stylesheet get the same short names; what a script names keeps its own", async () => {
		const views = join(dir, "views");
		const js = join(dir, "js");
		for (const d of [views, js]) mkdirSync(d);
		writeFileSync(join(views, "page.uwu"), '<div class="card"><h3 class="card__title">{{t}}</h3><table class="admin-table"></table></div>');
		writeFileSync(join(js, "menu.js"), 'el.classList.toggle("is-open");');
		const pipeline = assets({ mangle: { scripts: [js], markup: [views] }, rewrite: { "/assets/css/site.css": "site" } });
		const report = await pipeline.build();
		expect(report.mangled?.renamed).toBeGreaterThan(0);

		const page = pipeline.rewrite('<link rel="stylesheet" href="/assets/css/site.css"><div class="card"><h3 class="card__title">x</h3></div>');
		expect(page).not.toContain("card__title");
		const short = /<h3 class="([^"]+)"/.exec(page)![1]!;
		const css = await read(pipeline, /href="([^"]+)"/.exec(page)![1]!);
		expect(css).toContain(`.${short}{`);
		expect(css).not.toContain("card__title");

		// Nor is a class a page's own <style> names.
		writeFileSync(join(views, "inline.uwu"), '<style>.card__title{color:red}</style>');
		const styled = assets({ mangle: { scripts: [js], markup: [views] } });
		await styled.build();
		expect(styled.rewrite('<h3 class="card__title">x</h3>')).toContain('class="card__title"');

		// The script toggles it by name, so it cannot be renamed.
		const menu = pipeline.rewrite('<link rel="stylesheet" href="/assets/css/site.css"><nav class="is-open"></nav>');
		expect(menu).toContain('class="is-open"');
	});
});

describe("lazy styles", () => {
	test("what only a script can reach is linked later, by a loader right after the first sheet", async () => {
		const pipeline = assets({ safelist: ["is-open", "admin-table"], lazyStyles: { eager: [/^is-/] }, rewrite: { "/assets/css/site.css": "site" } });
		await pipeline.build();
		const page = pipeline.rewrite('<head><link rel="stylesheet" href="/assets/css/site.css"></head><body><div class="card"></div></body>');

		const eager = /href="([^"]+)"/.exec(page)![1]!;
		const loader = /<link[^>]+><script>([^<]+)<\/script>/.exec(page)?.[1] ?? "";
		const later = /"(\/_a\/site-later\.[^"]+)"/.exec(loader)?.[1];
		expect(later).toBeTruthy();
		expect(loader).toContain(".admin-table");

		const first = await read(pipeline, eager);
		expect(first).toContain(".card");
		expect(first).toContain(".is-open");
		expect(first).not.toContain("admin-table");
		expect(await read(pipeline, later!)).toContain(".admin-table");
	});

	test("the loader follows the stylesheet link, not a preload of the same file", async () => {
		const pipeline = assets({ safelist: ["admin-table"], lazyStyles: true, rewrite: { "/assets/css/site.css": "site" } });
		await pipeline.build();
		const page = pipeline.rewrite(
			'<link rel="preload" href="/assets/css/site.css" as="style"><link rel="stylesheet" href="/assets/css/site.css"><div class="card"></div>',
		);
		expect(page).toMatch(/<link rel="preload"[^>]+><link rel="stylesheet"[^>]+><script>/);
	});

	test("what a script draws on load goes in the first sheet, on the pages that have it", async () => {
		const pipeline = assets({
			safelist: ["admin-table"],
			lazyStyles: { whenPresent: { card: ["admin-table"] } },
			rewrite: { "/assets/css/site.css": "site" },
		});
		await pipeline.build();
		const withCard = pipeline.pageStyle("site", '<div class="card"></div>');
		const without = pipeline.pageStyle("site", "<p>nothing</p>");
		expect(await read(pipeline, withCard)).toContain("admin-table");
		expect(await read(pipeline, without)).not.toContain("admin-table");
	});

	test("a page with nothing to defer gets no loader", async () => {
		const pipeline = assets({ lazyStyles: true, rewrite: { "/assets/css/site.css": "site" } });
		await pipeline.build();
		expect(pipeline.rewrite('<link rel="stylesheet" href="/assets/css/site.css"><div class="card"></div>')).not.toContain("<script>");
	});
});

describe("the lazy loader under a CSP", () => {
	/** A script of the page's own that starts as the loader does, right after a stylesheet link. */
	const lookalike = '<script>(()=>{let d=0,a=document.currentScript.previousElementSibling,E=["pointerover","pointerdown","touchstart","keydown","focusin","scroll"],S="";alert(1)})()</script>';
	const page = '<html><head><link rel="stylesheet" href="/assets/css/site.css"><script nonce="NONCE" src="/s.js"></script></head>' +
		`<body><div class="card">x</div><link rel="stylesheet" href="/assets/css/site.css">${lookalike}<script>own()</script></body></html>`;
	const get = async (app: Application, path: string) => await (await app.handle(new Request(`http://natsu.test${path}`))).text();

	test("carries the nonce the answer's own CSP allows scripts by", async () => {
		const pipeline = assets({ safelist: ["admin-table"], lazyStyles: true, rewrite: { "/assets/css/site.css": "site" } });
		await pipeline.build();
		reset();
		const answer = (csp: string | null) => (ctx: Context) => {
			if (csp) ctx.response.headers.set("content-security-policy", csp);
			ctx.response.headers.set("content-type", "text/html; charset=utf-8");
			ctx.response.body = page;
		};
		new Router().get("/nonce", answer("default-src 'self'; script-src 'nonce-dGVzdA==' 'strict-dynamic'"));
		new Router().get("/none", answer(null));
		new Router().get("/hashes", answer("script-src 'sha256-abc' 'self'"));
		new Router().get("/odd", answer(`script-src 'nonce-a"b' 'nonce-<i>'`));
		const app = new Application();
		app.use(pipeline.middleware());

		const nonced = await get(app, "/nonce");
		expect(nonced).toMatch(/<link rel="stylesheet" href="\/_a\/site\.[0-9a-f]{10}\.css"><script nonce="dGVzdA==">\(\(\)=>\{let d=0,/);
		expect(nonced.split('nonce="dGVzdA=="').length).toBe(2);
		// Scripts of the page's own are left as they are.
		expect(nonced).toContain(`.css">${lookalike}<script>own()</script>`);
		expect(nonced).toContain('<script nonce="NONCE" src="/s.js">');
		// No CSP, a CSP without a nonce, or a nonce that is not base64: no nonce.
		for (const path of ["/none", "/hashes", "/odd"]) {
			const plain = await get(app, path);
			expect(plain).toMatch(/\.css"><script>\(\(\)=>\{let d=0,/);
			expect(plain.split("nonce=").length).toBe(2);
		}
	});

	test("on a page kept rewritten, each answer's loader carries that answer's nonce, and nothing else gets it", async () => {
		const pipeline = assets({ safelist: ["admin-table"], lazyStyles: true, rewrite: { "/assets/css/site.css": "site" } });
		await pipeline.build();
		const pages = new PageCache({ prepare: (html) => pipeline.rewrite(html) });
		reset();
		new Router().get("/page", async (ctx) => {
			const nonce = crypto.randomUUID().replaceAll("-", "");
			ctx.response.headers.set("content-security-policy", `script-src 'nonce-${nonce}'`);
			const kept = await pages.serve("/page", [nonce], async ([mark]) => ({ body: page.replace("NONCE", mark!), status: 200 }));
			if (kept?.prepared) pipeline.markRewritten(ctx);
			ctx.response.body = kept?.body ?? "";
		});
		const app = new Application();
		app.use(pipeline.middleware());

		const answers = [await get(app, "/page"), await get(app, "/page")];
		const nonces = answers.map((answer) => /<script nonce="([0-9a-f]{32})" src="\/s\.js">/.exec(answer)?.[1] ?? "");
		expect(nonces[0]).toMatch(/^[0-9a-f]{32}$/);
		expect(nonces[1]).not.toBe(nonces[0]);
		answers.forEach((answer, i) => {
			expect(answer).toMatch(new RegExp(`\\.css"><script nonce="${nonces[i]}">\\(\\(\\)=>\\{let d=0,`));
			// The page's own lookalike, after the same chunk link, is not the loader: no nonce.
			expect(answer).toContain(`.css">${lookalike}<script>own()</script>`);
			expect(answer.split(`nonce="${nonces[i]}"`).length).toBe(3);
		});
		// Rewritten once for everyone: the answers differ by their nonces alone.
		expect(answers[0]!.replaceAll(nonces[0]!, "N")).toBe(answers[1]!.replaceAll(nonces[1]!, "N"));
	});
});

/** Read a chunk back out of the pipeline through its own middleware. */
async function read(pipeline: Assets, url: string): Promise<string> {
	reset();
	const app = new Application();
	app.use(pipeline.middleware());
	const started = await startApp(app);
	try {
		return await (await started.fetch(url)).text();
	} finally {
		await started.stop();
	}
}
