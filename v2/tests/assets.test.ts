/**
 * The asset pipeline.
 *
 * Three claims worth proving: a page gets only the rules it can use, two
 * pages that need the same rules get one file, and a chunk's URL changes when
 * its contents do — because the cache header says `immutable` for a year, and
 * that is only safe if it is true.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Assets } from "../src/assets.ts";
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
