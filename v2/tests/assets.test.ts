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
		const pipeline = assets();
		await pipeline.build();
		reset();
		new Router().get("/page", (ctx) => {
			ctx.response.body = '<html><head><link rel="stylesheet" data-chunk="site" href="/site.css"></head>' +
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
