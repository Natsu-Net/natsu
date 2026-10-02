/**
 * Page navigation, the server half.
 *
 * What has to hold: a handler never sees the navigation headers and never
 * runs for a route that did not opt in; a part links the same CSS chunk as
 * its whole page, from a fresh render and from PageCache alike; nothing that
 * a swap cannot change (document headers, the shell, the build) slips through
 * the key; a script reaches the list only with this response's nonce; and
 * every answer that is not a part tells the runtime why, with its cookies.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliCompressSync, brotliDecompressSync } from "node:zlib";
import { Assets, type AssetsOptions } from "../src/assets.ts";
import { compress } from "../src/compress.ts";
import { setConfig } from "../src/config.ts";
import type { Context, Handler } from "../src/context.ts";
import { setLogLevel, setLogSink } from "../src/logger.ts";
import { Controller } from "../src/controller.ts";
import { inertNav, island, navigable, partOf, scanPage, shellOf } from "../src/navigate.ts";
import { PageCache } from "../src/page-cache.ts";
import { Get, Island, Navigable, Router } from "../src/router.ts";
import { Application } from "../src/server.ts";
import * as natsu from "../index.ts";
import { reset } from "./helpers.ts";

const CSS = `
body { margin: 0; }
.hdr { position: sticky; }
.card { border: 1px solid; }
.big { font-size: 2em; }
.foot { opacity: .8; }
.hidden { display: none; }
@media (min-width: 768px) { .md\\:flex { display: flex; } }
`;

const BASE = "http://natsu.test";

let dir: string;

beforeEach(() => {
	reset();
	dir = mkdtempSync(join(tmpdir(), "natsu-navigate-"));
	writeFileSync(join(dir, "site.css"), CSS);
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

interface PageParts {
	nonce?: string;
	csrf?: string;
	title?: string;
	head?: string;
	header?: string;
	main?: string;
	mainTag?: string;
	footer?: string;
	scripts?: string;
}

/** A page shaped like the hub's: a header with a form, a main and a footer region, scripts at the end. */
function page(parts: PageParts = {}): string {
	const nonce = parts.nonce ?? "n0";
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${parts.title ?? "Page"}</title>` +
		`<link rel="stylesheet" href="/assets/site.css">${parts.head ?? ""}<script nonce="${nonce}">window.boot = 1;</script></head>` +
		`<body><header class="hdr"><nav class="hidden md:flex">${parts.header ?? "Site"}</nav>` +
		`<form method="post" action="/logout"><input type="hidden" name="csrf" value="${parts.csrf ?? "c0"}"></form></header>` +
		`${parts.mainTag ?? '<main id="main" data-natsu-region>'}${parts.main ?? '<h1 class="card">Hello</h1>'}</main>` +
		`<footer id="site-footer" data-natsu-region class="foot">${parts.footer ?? "(c)"}</footer>` +
		`${parts.scripts ?? `<script src="/assets/site.js" nonce="${nonce}" defer></script>`}</body></html>`;
}

function csp(ctx: Context, nonce: string, extra = ""): void {
	ctx.response.headers.set("content-security-policy", `script-src 'nonce-${nonce}' 'strict-dynamic'${extra}; object-src 'none'`);
}

async function pipeline(options: { navigate?: AssetsOptions["navigate"]; compress?: boolean; assets?: Partial<AssetsOptions> } = {}) {
	const assets = new Assets({
		outDir: join(dir, "out"),
		styles: { site: [join(dir, "site.css")] },
		rewrite: { "/assets/site.css": "site" },
		minify: true,
		navigate: options.navigate ?? true,
		...options.assets,
	});
	await assets.build();
	const app = new Application();
	if (options.compress) app.use(compress());
	app.use(assets.middleware());
	return { assets, app };
}

function get(app: Application, path: string, headers: Record<string, string> = {}, method = "GET"): Promise<Response> {
	return app.handle(new Request(`${BASE}${path}`, { method, headers }));
}

const metaKey = (html: string): string => /<meta name="natsu" content="([^"]+)"/.exec(html)?.[1] ?? "";
const stylesheet = (html: string): string => /<link rel="stylesheet" href="([^"]+)"/.exec(html)?.[1] ?? "";

/** The key a visitor's runtime would send from `path`. */
async function keyOf(app: Application, path: string, headers: Record<string, string> = {}): Promise<string> {
	return metaKey(await (await get(app, path, headers)).text());
}

function nav(app: Application, path: string, key: string, headers: Record<string, string> = {}): Promise<Response> {
	return get(app, path, { "natsu-nav": key, ...headers });
}

/** A route that draws `page(parts)` under a nonce CSP, counting its calls. */
function route(path: string, parts: PageParts | ((ctx: Context) => PageParts) = {}, options?: { prefetch?: boolean } | false) {
	const calls = { count: 0 };
	const handler: Handler = (ctx) => {
		calls.count++;
		const nonce = crypto.randomUUID().replaceAll("-", "");
		csp(ctx, nonce);
		return page({ nonce, ...(typeof parts === "function" ? parts(ctx) : parts) });
	};
	new Router().get(path, options === false ? handler : navigable(handler, options));
	return calls;
}

describe("the request", () => {
	test("navigable and addVary are part of the public surface", () => {
		expect(natsu.navigable).toBe(navigable);
		expect(typeof natsu.addVary).toBe("function");
	});

	test("the headers are gone before the handler runs, and ctx.nav says what was asked", async () => {
		let seen: { nav: string | null; prefetch: string | null; requested: boolean; isPrefetch: boolean } | undefined;
		new Router().get("/p", navigable((ctx) => {
			seen = {
				nav: ctx.request.headers.get("natsu-nav"),
				prefetch: ctx.request.headers.get("natsu-prefetch"),
				requested: ctx.nav.requested,
				isPrefetch: ctx.nav.prefetch,
			};
			return page();
		}));
		const { app } = await pipeline();
		const key = await keyOf(app, "/p");
		expect(seen).toEqual({ nav: null, prefetch: null, requested: false, isPrefetch: false });

		await nav(app, "/p", key, { "natsu-prefetch": "1" });
		expect(seen).toEqual({ nav: null, prefetch: null, requested: true, isPrefetch: true });
	});

	test("it is ignored, and still stripped, on POST, HEAD, browser navigations and malformed keys", async () => {
		const seen: Array<{ header: string | null; requested: boolean }> = [];
		const handler: Handler = (ctx) => {
			seen.push({ header: ctx.request.headers.get("natsu-nav"), requested: ctx.nav.requested });
			return page();
		};
		new Router().get("/p", navigable(handler));
		new Router().post("/p", navigable(handler));
		const { app } = await pipeline();
		const key = await keyOf(app, "/p");
		seen.length = 0;

		const answers = [
			await get(app, "/p", { "natsu-nav": key }, "POST"),
			await get(app, "/p", { "natsu-nav": key }, "HEAD"),
			await nav(app, "/p", key, { "sec-fetch-mode": "navigate" }),
			await nav(app, "/p", key, { "sec-fetch-dest": "document" }),
			await nav(app, "/p", "NOT.A-KEY"),
			await nav(app, "/p", "abc"),
			await nav(app, "/p", `${key}.x`),
			await nav(app, "/p", "a".repeat(14) + ".b"),
		];
		for (const answer of answers) {
			expect(answer.status).toBe(200);
			expect(answer.headers.get("natsu-part")).toBeNull();
		}
		expect(seen).toHaveLength(answers.length);
		for (const one of seen) expect(one).toEqual({ header: null, requested: false });

		// A prefetch header without a key is no navigation, and no handler sees it either.
		let stray: string | null = "unset";
		new Router().get("/stray", (ctx) => {
			stray = ctx.request.headers.get("natsu-prefetch");
			return page();
		});
		expect((await get(app, "/stray", { "natsu-prefetch": "1" })).status).toBe(200);
		expect(stray).toBeNull();
	});

	test("a route that is not navigable answers a full load, and its handler never runs", async () => {
		const calls = route("/plain", {}, false);
		route("/from");
		const { app } = await pipeline();
		const key = await keyOf(app, "/from");

		const answer = await nav(app, "/plain", key);
		expect(answer.status).toBe(204);
		expect(answer.headers.get("natsu-reload")).toBe("route");
		expect(calls.count).toBe(0);
		expect(await answer.text()).toBe("");
	});

	test("guards keep the navigable flag, and run only for navigable routes", async () => {
		let guarded = 0;
		const draw: Handler = (ctx) => {
			csp(ctx, "n0");
			return page();
		};
		new Router().Prefix("/area", (sub) => {
			sub.get("/in", navigable(draw));
			sub.get("/out", draw);
		}, () => {
			guarded++;
			return true;
		});
		route("/from");
		const { app } = await pipeline();
		const key = await keyOf(app, "/from");

		const inside = await nav(app, "/area/in", key);
		expect(inside.status).toBe(200);
		expect(inside.headers.get("natsu-part")).toBe("1");
		expect(guarded).toBe(1);

		const outside = await nav(app, "/area/out", key);
		expect(outside.headers.get("natsu-reload")).toBe("route");
		expect(guarded).toBe(1);
	});

	test("a prefetch on a route with prefetch: false is refused before the handler; a click is not", async () => {
		const calls = route("/costly", {}, { prefetch: false });
		const { app } = await pipeline();
		const key = await keyOf(app, "/costly");
		calls.count = 0;

		const prefetch = await nav(app, "/costly", key, { "natsu-prefetch": "1" });
		expect(prefetch.status).toBe(204);
		expect(prefetch.headers.get("natsu-prefetch")).toBe("skip");
		expect(calls.count).toBe(0);

		const click = await nav(app, "/costly", key);
		expect(click.headers.get("natsu-part")).toBe("1");
		expect(calls.count).toBe(1);
	});

	test("with prefetch off in the options, no prefetch reaches a route", async () => {
		const calls = route("/p");
		const { app } = await pipeline({ navigate: { prefetch: false } });
		const key = await keyOf(app, "/p");
		calls.count = 0;
		const answer = await nav(app, "/p", key, { "natsu-prefetch": "1" });
		expect(answer.status).toBe(204);
		expect(answer.headers.get("natsu-prefetch")).toBe("skip");
		expect(answer.headers.get("vary")).toContain("Natsu-Nav");
		expect(calls.count).toBe(0);
	});

	test("ctx.nav.skip() refuses a prefetch and nothing else", async () => {
		let skipped: boolean[] = [];
		new Router().get("/p", navigable((ctx) => {
			skipped.push(ctx.nav.skip());
			return page();
		}));
		const { app } = await pipeline();
		const key = await keyOf(app, "/p");
		const prefetch = await nav(app, "/p", key, { "natsu-prefetch": "1" });
		const click = await nav(app, "/p", key);
		expect(skipped).toEqual([false, true, false]);
		expect(prefetch.headers.get("natsu-prefetch")).toBe("skip");
		expect(click.headers.get("natsu-part")).toBe("1");
		skipped = [];
	});

	test("no route, or a static file, is a full load", async () => {
		writeFileSync(join(dir, "robots.txt"), "User-agent: *");
		writeFileSync(join(dir, "shadow"), "a file in front of a route");
		reset({ Static: { enabled: true, root: dir, beforeRoutes: true } });
		route("/from");
		const shadowed = route("/shadow");
		const { app } = await pipeline();
		const key = await keyOf(app, "/from");

		for (const path of ["/robots.txt", "/nothing-here", "/shadow"]) {
			const answer = await nav(app, path, key);
			expect(answer.status).toBe(204);
			expect(answer.headers.get("natsu-reload")).toBe("response");
		}
		expect(shadowed.count).toBe(0);
	});

	test("without navigation ctx.nav is inert, and shown() runs at once", async () => {
		let ran = false;
		let nav: unknown;
		new Router().get("/p", (ctx) => {
			nav = ctx.nav;
			expect(ctx.nav.skip()).toBe(false);
			expect(ctx.nav.reload()).toBe(false);
			expect(ctx.nav.stale(new Headers())).toBe(false);
			ctx.nav.shown(() => {
				ran = true;
			});
			return page();
		});
		const { app } = await pipeline({ navigate: false });
		const answer = await get(app, "/p", { "natsu-nav": "a.b" });
		expect(nav).toBe(inertNav);
		expect(ran).toBe(true);
		const html = await answer.text();
		expect(html).not.toContain('name="natsu"');
		expect(answer.headers.get("vary")).toBeNull();
	});
});

describe("the part", () => {
	test("holds the head less its scripts, the key, the regions and the script list", async () => {
		route("/a", { main: '<h1 class="card">A</h1>' });
		route("/b", { title: "B page", main: '<p class="big">B</p>', head: '<meta name="description" content="b">' });
		const { app } = await pipeline();
		const key = await keyOf(app, "/a");

		const answer = await nav(app, "/b", key);
		expect(answer.status).toBe(200);
		expect(answer.headers.get("natsu-part")).toBe("1");
		expect(answer.headers.get("content-type")).toBe("text/html; charset=utf-8");
		const part = await answer.text();
		expect(part).toStartWith("<!doctype html><html><head>");
		expect(part).toContain("<title>B page</title>");
		expect(part).toContain('<meta name="description" content="b">');
		expect(part).toContain(`<meta name="natsu" content="${key}">`);
		// Head scripts stay in the document the visitor has; the runtime is not listed.
		expect(part).not.toContain("window.boot");
		expect(part).not.toContain("natsu-navigate");
		expect(part).toContain('<main id="main" data-natsu-region><p class="big">B</p></main>');
		expect(part).toContain('<footer id="site-footer" data-natsu-region class="foot">(c)</footer>');
		expect(part).toEndWith('<footer id="site-footer" data-natsu-region class="foot">(c)</footer></body></html>');
		// The script list travels in a header that only the server writes.
		expect(part).not.toContain("<script");
		expect(answer.headers.get("natsu-scripts")).toBe("src=%2Fassets%2Fsite.js&defer=&nonce=");
		// The shell is not sent.
		expect(part).not.toContain("<header");
		expect(part).not.toContain('name="csrf"');
	});

	test("links the same CSS chunk as its whole page, rendered fresh", async () => {
		route("/a", { main: '<h1 class="card">A</h1>' });
		route("/b", { main: '<p class="big">B</p>' });
		const { assets, app } = await pipeline();
		const key = await keyOf(app, "/a");
		const wholeB = stylesheet(await (await get(app, "/b")).text());
		const part = await (await nav(app, "/b", key)).text();
		const partB = stylesheet(part);
		expect(partB).toStartWith("/_a/site.");
		expect(partB).toBe(wholeB);
		// Cut before the rewrite, the regions alone would get another chunk, one
		// without the header's rules (`.hidden`, `md:flex`): a desktop header
		// would vanish once the old chunk is gone.
		const regions = part.slice(part.indexOf("<body>"), part.indexOf("<script"));
		expect(assets.pageStyle("site", regions)).not.toBe(partB);
	});

	test("links the same CSS chunk from a page PageCache kept rewritten, without rewriting it again", async () => {
		const { assets, app } = await pipeline();
		const rewrite = assets.rewrite.bind(assets);
		let rewrites = 0;
		assets.rewrite = (html: string) => {
			rewrites++;
			return rewrite(html);
		};
		const pages = new PageCache({ prepare: (html) => assets.rewrite(html) });
		const shared = (main: string): Handler => async (ctx) => {
			const nonce = crypto.randomUUID().replaceAll("-", "");
			const token = ctx.request.headers.get("x-visitor") ?? "t0";
			csp(ctx, nonce);
			const kept = await pages.serve(ctx.path, [nonce, token], async ([n, t]) => ({
				body: page({ nonce: n, csrf: t, main }),
				status: 200,
			}));
			if (kept?.prepared) assets.markRewritten(ctx, kept);
			return kept?.body;
		};
		new Router().get("/a", navigable(shared('<h1 class="card">A</h1>')));
		new Router().get("/b", navigable(shared('<p class="big">B</p>')));

		const wholeB = stylesheet(await (await get(app, "/b")).text());
		const key = await keyOf(app, "/a");
		expect(rewrites).toBe(2);
		const answer = await nav(app, "/b", key);
		expect(answer.headers.get("natsu-part")).toBe("1");
		const part = await answer.text();
		expect(stylesheet(part)).toBe(wholeB);
		expect(part).not.toContain("natsu-secret-");
		// The kept page was cut as it was kept: no second rewrite.
		expect(rewrites).toBe(2);
		expect(pages.counts.fresh).toBe(1);
	});

	test("keeps the page's own status: a 404 or a 500 page is drawn in the shell", async () => {
		new Router().get("/from", navigable(() => page()));
		new Router().get("/missing", navigable((ctx) => {
			ctx.response.status = 404;
			return page({ main: "<h1>Not found</h1>" });
		}));
		const app = new Application();
		const { assets } = await pipeline();
		app.onError((_error, ctx) => {
			ctx.response.status = 500;
			ctx.response.body = page({ main: "<h1>Broken</h1>" });
		});
		app.use(assets.middleware());
		new Router().get("/broken", navigable(() => {
			throw new Error("boom");
		}));
		const key = await keyOf(app, "/from");

		const missing = await nav(app, "/missing", key);
		expect(missing.status).toBe(404);
		expect(missing.headers.get("natsu-part")).toBe("1");
		expect(await missing.text()).toContain("<h1>Not found</h1>");

		const broken = await nav(app, "/broken", key);
		expect(broken.status).toBe(500);
		expect(broken.headers.get("natsu-part")).toBe("1");
		expect(await broken.text()).toContain("<h1>Broken</h1>");
	});

	test("parts and 204s are private and no-store; every answer varies on Natsu-Nav", async () => {
		new Router().get("/a", navigable((ctx) => {
			ctx.response.headers.set("cache-control", "public, max-age=600");
			ctx.response.headers.set("etag", '"v1"');
			return page();
		}));
		route("/plain", {}, false);
		const { app } = await pipeline();
		const whole = await get(app, "/a");
		const key = metaKey(await whole.text());
		const part = await nav(app, "/a", key);
		const refused = await nav(app, "/plain", key);

		expect(whole.headers.get("cache-control")).toBe("public, max-age=600");
		expect(whole.headers.get("vary")).toBe("Natsu-Nav");
		for (const answer of [part, refused]) {
			expect(answer.headers.get("cache-control")).toBe("private, no-store");
			expect(answer.headers.get("vary")).toBe("Natsu-Nav");
		}
		expect(part.headers.get("etag")).toBeNull();
		expect(refused.headers.get("content-type")).toBeNull();
	});

	test("parts and 204s carry no document headers: they are never a document, and the key proved them equal", async () => {
		const headers = (ctx: Context) => {
			ctx.response.headers.set("referrer-policy", "same-origin");
			ctx.response.headers.set("permissions-policy", "camera=()");
			ctx.response.headers.set("x-frame-options", "DENY");
			ctx.response.headers.set("x-app", "kept");
		};
		new Router().get("/a", navigable((ctx) => {
			headers(ctx);
			const nonce = crypto.randomUUID().replaceAll("-", "");
			csp(ctx, nonce);
			return page({ nonce });
		}));
		new Router().get("/other", navigable((ctx) => {
			headers(ctx);
			csp(ctx, crypto.randomUUID().replaceAll("-", ""), " https://ads.test");
			return page();
		}));
		const { app } = await pipeline({ navigate: { documentHeaders: ["X-Frame-Options"] } });
		const whole = await get(app, "/a");
		const key = metaKey(await whole.text());
		const part = await nav(app, "/a", key);
		const stale = await nav(app, "/other", key);
		expect(whole.headers.get("content-security-policy")).toContain("'nonce-");
		expect([part.headers.get("natsu-part"), stale.headers.get("natsu-reload")]).toEqual(["1", "document"]);
		for (const answer of [part, stale]) {
			for (const name of ["content-security-policy", "referrer-policy", "permissions-policy", "x-frame-options"]) {
				expect(answer.headers.get(name)).toBeNull();
			}
			expect(answer.headers.get("x-app")).toBe("kept");
		}
		// The part still lists the scripts this response's nonce vouched for.
		expect(part.headers.get("natsu-scripts")).toBe("src=%2Fassets%2Fsite.js&defer=&nonce=");
	});

	test("an answer that is not a page is a full load, cookies kept", async () => {
		route("/from");
		new Router().get("/json", navigable(() => ({ ok: true })));
		new Router().get("/text", navigable((ctx) => {
			ctx.response.type = "text/plain";
			return "<not a page>";
		}));
		new Router().get("/download", navigable(() => new Response("bytes", { headers: { "content-disposition": "attachment", "set-cookie": "got=1" } })));
		new Router().get("/stream", navigable(() => new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("x")); } })));
		new Router().get("/flat", navigable((ctx) => {
			csp(ctx, "other");
			return "<!doctype html><html><head></head><body><main id=\"main\">no region</main></body></html>";
		}));
		const { app } = await pipeline();
		const key = await keyOf(app, "/from");

		for (const path of ["/json", "/text", "/download", "/stream"]) {
			const answer = await nav(app, path, key);
			expect(answer.status).toBe(204);
			expect(answer.headers.get("natsu-reload")).toBe("response");
		}
		expect((await nav(app, "/download", key)).headers.get("set-cookie")).toBe("got=1");
		expect((await nav(app, "/flat", key)).headers.get("natsu-reload")).toBe("regions");
	});
});

describe("regions", () => {
	test("a </main> inside JSON-LD, a comment, a style or a textarea does not end the region", async () => {
		const tricky = '<script type="application/ld+json">{"name":"tricky </main> text"}</script>' +
			"<!-- </main> in a comment -->" +
			"<style>.x::after { content: '</main>'; }</style>" +
			"<textarea></main></textarea><main class=\"inner\">nested main</main>" +
			'<p class="card">end</p>';
		route("/from");
		route("/tricky", { main: tricky });
		const { app } = await pipeline();
		const key = await keyOf(app, "/from");
		const part = await (await nav(app, "/tricky", key)).text();
		expect(part).toContain(`<main id="main" data-natsu-region>${tricky}</main><footer`);
	});

	test("an inline script in a region is a full load; a data block is not", async () => {
		route("/from");
		route("/inline", { main: "<script>alert(1)</script>" });
		route("/module", { main: '<script type="module">import "/x.js"</script>' });
		route("/src", { main: '<script src="/in-region.js"></script>' });
		route("/data", { main: '<script type="application/ld+json">{}</script><script type="application/json" id="state">{}</script><script type="text/template"><b>x</b></script>' });
		const { app } = await pipeline();
		const key = await keyOf(app, "/from");
		for (const path of ["/inline", "/module", "/src"]) {
			expect((await nav(app, path, key)).headers.get("natsu-reload")).toBe("inline-script");
		}
		expect((await nav(app, "/data", key)).headers.get("natsu-part")).toBe("1");
	});

	test("a region must have an id, an end tag, and no region inside it", () => {
		const shell = (body: string) => `<!doctype html><html><head><title>x</title></head><body>${body}</body></html>`;
		expect(scanPage(shell('<main data-natsu-region>x</main>'))).toMatchObject({ reason: "regions" });
		expect(scanPage(shell('<main id="m" data-natsu-region>x'))).toMatchObject({ reason: "regions" });
		expect(scanPage(shell('<main id="m" data-natsu-region><div id="d" data-natsu-region>x</div></main>'))).toMatchObject({ reason: "regions" });
		expect(scanPage(shell('<main id="m" data-natsu-region>x</main><div id="m" data-natsu-region>y</div>'))).toMatchObject({ reason: "regions" });
		expect(scanPage(shell('<img id="m" data-natsu-region>'))).toMatchObject({ reason: "regions" });
		expect(scanPage(shell('<tr id="m" data-natsu-region><td>x</td></tr>'))).toMatchObject({ reason: "regions" });
		expect(scanPage('<body><main id="m" data-natsu-region>x</main></body>')).toMatchObject({ reason: "response" });
		// Text and attribute values that merely mention the name are not regions.
		expect(scanPage(shell('<p>use data-natsu-region on main</p><a title="x data-natsu-region y" href="/">z</a>'))).toBeNull();
		// Upper-case markup is not read: no regions, so a full load.
		expect(scanPage(shell('<MAIN ID="m" DATA-NATSU-REGION>x</MAIN>'))).toBeNull();
	});

	test("a declarative shadow root in a region is a full load: a part would leave it inert", () => {
		const shell = (body: string) => `<!doctype html><html><head><title>x</title></head><body>${body}</body></html>`;
		for (const spelling of ['shadowrootmode="open"', "shadowRootMode=closed"]) {
			expect(scanPage(shell(`<main id="m" data-natsu-region><div><template ${spelling}><p>x</p></template></div></main>`))).toMatchObject({ reason: "regions" });
		}
		// Outside the regions, or only mentioned, it is no reason.
		const outside = scanPage(shell('<header><template shadowrootmode="open">x</template></header><main id="m" data-natsu-region><p>use shadowrootmode="open"</p><code title="a shadowrootmode b">x</code></main>'));
		expect(outside === null || "reason" in outside).toBe(false);
	});

	test("nested elements of the region's own tag and attribute values with > are read right", () => {
		const html = '<!doctype html><html><head></head><body><div id="r" title="a > b" data-natsu-region=""><div><div>x</div></div><divider>y</divider></div><p>after</p></body></html>';
		const scan = scanPage(html);
		if (scan === null || "reason" in scan) throw new Error(JSON.stringify(scan));
		expect(html.slice(scan.regions[0]!.start, scan.regions[0]!.end)).toBe('<div id="r" title="a > b" data-natsu-region=""><div><div>x</div></div><divider>y</divider></div>');
		// `<div/>` opens a div, as the HTML parser reads it, so this region never ends.
		expect(scanPage('<html><head></head><body><div id="r" data-natsu-region><div/>y</div></body></html>')).toMatchObject({ reason: "regions" });
	});
});

describe("the scanner, as a browser reads the page", () => {
	test("a script in a region is found in any case", () => {
		const shell = (body: string) => `<!doctype html><html><head></head><body>${body}</body></html>`;
		expect(scanPage(shell('<main id="m" data-natsu-region><SCRIPT>go()</SCRIPT></main>'))).toMatchObject({ reason: "inline-script" });
		expect(scanPage(shell('<main id="m" data-natsu-region><Script src="/x.js"></Script></main>'))).toMatchObject({ reason: "inline-script" });
		// Raw text ends at its end tag in any case: the region after it is found.
		const html = shell('<style>.a{}</STYLE><main id="m" data-natsu-region>x</main>');
		expect(scanPage(html)).toMatchObject({ regions: [{ id: "m" }] });
	});

	test("a comment ends at --!> as well as -->", () => {
		const html = '<!doctype html><html><head></head><body><!-- a --!><main id="m" data-natsu-region><script>go()</script></main><!-- b --></body></html>';
		// Read as the browser reads it, the region holds a live script.
		expect(scanPage(html)).toMatchObject({ reason: "inline-script" });
	});

	test("text that mentions the attribute many times costs one walk over it", () => {
		const mentions = " data-natsu-region".repeat(20_000);
		const html = `<!doctype html><html><head></head><body><p title="${mentions}">${mentions}</p><main id="m" data-natsu-region>x</main></body></html>`;
		const started = performance.now();
		const scan = scanPage(html);
		const took = performance.now() - started;
		expect(scan).toMatchObject({ regions: [{ id: "m" }] });
		// Quadratic, this was seconds; linear it is a few milliseconds.
		expect(took).toBeLessThan(200);
	});
});

describe("the script list", () => {
	test("under 'strict-dynamic' a script without this response's nonce is dropped; with no nonce in the CSP all are kept", async () => {
		route("/from");
		route("/b", (ctx) => {
			const nonce = /'nonce-([^']+)'/.exec(ctx.response.headers.get("content-security-policy") ?? "")?.[1] ?? "";
			return {
				scripts: `<script src="/assets/site.js" nonce="${nonce}" defer></script>` +
					'<script src="https://evil.test/x.js"></script>' +
					`<script src="/assets/old.js" nonce="stale-nonce"></script><script src="/assets/page.js" nonce="${nonce}"></script>`,
			};
		});
		const { app } = await pipeline();
		const key = await keyOf(app, "/from");
		const answer = await nav(app, "/b", key);
		expect(answer.headers.get("natsu-scripts")).toBe("src=%2Fassets%2Fsite.js&defer=&nonce= src=%2Fassets%2Fpage.js&nonce=");
		expect(await answer.text()).not.toContain("<script");

		const html = page({ scripts: '<script src="/a.js?x=1&amp;y=2"></script><script src="/b.js" nonce="x" data-natsu-once></script>' });
		const scan = scanPage(html);
		if (scan === null || "reason" in scan) throw new Error("no scan");
		// Values as the browser reads them; no nonce key without a nonce in the CSP.
		expect(partOf(html, scan, "k.k", []).scripts).toBe("src=%2Fa.js%3Fx%3D1%26y%3D2 src=%2Fb.js&data-natsu-once=");
	});

	test("without 'strict-dynamic' a script without this response's nonce is listed without the nonce key: the CSP's host list decides, as on a full load", () => {
		const html = page({ scripts: '<script src="/a.js" nonce="n1"></script><script src="/b.js"></script><script src="/c.js" nonce="old"></script>' });
		const scan = scanPage(html);
		if (scan === null || "reason" in scan) throw new Error("no scan");
		expect(partOf(html, scan, "k.k", ["n1"], "", false).scripts).toBe("src=%2Fa.js&nonce= src=%2Fb.js src=%2Fc.js");
		expect(partOf(html, scan, "k.k", ["n1"], "", true).scripts).toBe("src=%2Fa.js&nonce=");
		// The runtime's own tag is never listed.
		expect(partOf(html, scan, "k.k", ["n1"], "/a.js", true).scripts).toBe("");
	});

	test("a nonce elsewhere in the head keeps its value when it is this response's (named in Natsu-Nonce), and is dropped when not", async () => {
		route("/from");
		route("/b", (ctx) => {
			const nonce = /'nonce-([^']+)'/.exec(ctx.response.headers.get("content-security-policy") ?? "")?.[1] ?? "";
			return { head: `<style nonce="${nonce}">.b{}</style><link rel="preload" href="/f.woff2" as="font" nonce='stale'><style nonce=${nonce}>.c{}</style>` };
		});
		const { app } = await pipeline();
		const key = await keyOf(app, "/from");
		const answer = await nav(app, "/b", key);
		const nonce = answer.headers.get("natsu-nonce") ?? "";
		expect(nonce).toMatch(/^[0-9a-f]{32}$/);
		const part = await answer.text();
		expect(part).toContain(`<style nonce="${nonce}">.b{}</style><link rel="preload" href="/f.woff2" as="font"><style nonce=${nonce}>.c{}</style>`);
		expect(part).not.toContain("stale");
	});

	test("a bare nonce, or one in the title's text, never passes for this response's", () => {
		const html = page({
			title: 'Say nonce="n1" here',
			head: '<style nonce>.a{}</style><style NONCE="">.b{}</style><!-- <style nonce="n1"> --><meta name="x" content=\'nonce="n1"\'>',
		});
		const scan = scanPage(html);
		if (scan === null || "reason" in scan) throw new Error("no scan");
		const part = partOf(html, scan, "k.k", ["n1"]).html;
		expect(part).toContain('<style>.a{}</style><style>.b{}</style>');
		// Text is text: the title, a comment and an attribute value are left as written.
		expect(part).toContain('<title>Say nonce="n1" here</title>');
		expect(part).toContain('<!-- <style nonce="n1"> -->');
		expect(part).toContain(`<meta name="x" content='nonce="n1"'>`);
	});
});

describe("the key", () => {
	/** Keys for the same route under different conditions, as a visitor's runtime would hold them. */
	async function keys(variants: Array<{ parts?: PageParts; headers?: Record<string, string> }>, build?: string): Promise<Array<[string, string]>> {
		let current = variants[0]!;
		new Router().get("/k", navigable((ctx) => {
			const nonce = crypto.randomUUID().replaceAll("-", "");
			csp(ctx, nonce);
			for (const [name, value] of Object.entries(current.headers ?? {})) ctx.response.headers.set(name, value);
			return page({ nonce, ...current.parts });
		}));
		if (build) writeFileSync(join(dir, "site.css"), build);
		const { app } = await pipeline({ navigate: { documentHeaders: ["X-Document"] } });
		const out: Array<[string, string]> = [];
		for (const variant of variants) {
			current = variant;
			const [doc = "", shell = ""] = (await keyOf(app, "/k")).split(".");
			out.push([doc, shell]);
		}
		return out;
	}

	test("is the same across nonces, region contents and script lists", async () => {
		const [a, b, c] = await keys([
			{},
			{ parts: { main: "<h1>Another page entirely</h1>", footer: "other footer", title: "Other" } },
			{ parts: { scripts: '<script src="/assets/other.js" defer></script>' } },
		]);
		expect(b).toEqual(a!);
		expect(c).toEqual(a!);
	});

	test("the document half changes with a CSP host, a referrer policy, a listed header and the build", async () => {
		const [base, host, referrer, listed, reportOnly] = await keys([
			{},
			{ headers: { "content-security-policy": "script-src 'nonce-abc' https://ads.test" } },
			{ headers: { "referrer-policy": "no-referrer" } },
			{ headers: { "x-document": "1" } },
			{ headers: { "content-security-policy-report-only": "default-src 'self'" } },
		]);
		for (const other of [host, referrer, listed, reportOnly]) {
			expect(other![0]).not.toBe(base![0]);
			expect(other![1]).toBe(base![1]);
		}
		reset();
		const [rebuilt] = await keys([{}], `${CSS}\n.new-rule { color: red; }`);
		expect(rebuilt![0]).not.toBe(base![0]);
		expect(rebuilt![1]).toBe(base![1]);
	});

	test("the shell half changes with the CSRF token, the region ids and any byte outside the regions", async () => {
		const [base, csrf, ids, header, script] = await keys([
			{},
			{ parts: { csrf: "re-minted" } },
			{ parts: { mainTag: '<main id="content" data-natsu-region>' } },
			{ parts: { header: "Site (signed in)" } },
			{ parts: { scripts: '<script src="/assets/site.js" defer></script><script>window.shellInline = 1</script>' } },
		]);
		for (const other of [csrf, ids, header, script]) {
			expect(other![1]).not.toBe(base![1]);
			expect(other![0]).toBe(base![0]);
		}
	});

	test("a stale key is a full load: document first, then shell", async () => {
		let variant: PageParts = {};
		let policy = "";
		new Router().get("/p", navigable((ctx) => {
			csp(ctx, "abc", policy);
			return page({ nonce: "abc", ...variant });
		}));
		const { app } = await pipeline();
		const key = await keyOf(app, "/p");
		variant = { header: "changed" };
		expect((await nav(app, "/p", key)).headers.get("natsu-reload")).toBe("shell");
		policy = " https://ads.test";
		expect((await nav(app, "/p", key)).headers.get("natsu-reload")).toBe("document");
	});

	test("a different script in the head is a different shell: it would never run after a swap", async () => {
		route("/a");
		route("/b", { head: '<script src="/assets/charts.js" defer></script>' });
		route("/c", { head: '<script src="/assets/charts.js" nonce="other" defer></script>' });
		const { app } = await pipeline();
		const key = await keyOf(app, "/a");
		expect((await nav(app, "/b", key)).headers.get("natsu-reload")).toBe("shell");
		// The same head scripts with other nonces are the same shell.
		expect(await keyOf(app, "/b")).toBe(await keyOf(app, "/c"));
	});

	test("markup moved from one side of a region to the other is a different shell", () => {
		const before = '<!doctype html><html><head></head><body><div id="a" data-natsu-region>1</div><aside>x</aside><div id="b" data-natsu-region>2</div></body></html>';
		const after = '<!doctype html><html><head></head><body><div id="a" data-natsu-region>1</div><div id="b" data-natsu-region>2</div><aside>x</aside></body></html>';
		const one = scanPage(before);
		const two = scanPage(after);
		if (!one || "reason" in one || !two || "reason" in two) throw new Error("no scan");
		expect(shellOf(before, one)).not.toBe(shellOf(after, two));
	});

	test("shellOf leaves out the head, the regions, the script list and nonces", () => {
		const one = page({ nonce: "a", main: "one", title: "One", scripts: '<script src="/x.js" nonce="a"></script>' });
		const two = page({ nonce: "b", main: "two", title: "Two", scripts: '<script src="/y.js" nonce="b"></script>' });
		const scanOne = scanPage(one);
		const scanTwo = scanPage(two);
		if (!scanOne || "reason" in scanOne || !scanTwo || "reason" in scanTwo) throw new Error("no scan");
		expect(shellOf(one, scanOne)).toBe(shellOf(two, scanTwo));
		expect(shellOf(one, scanOne)).not.toContain("<head>");
		expect(shellOf(one, scanOne)).toContain("\0main\0");
		expect(shellOf(one, scanOne)).toContain("\0site-footer\0");
	});
});

describe("answers", () => {
	test("ctx.nav.stale() lets a handler leave before drawing anything", async () => {
		let drawn = 0;
		let policy = "script-src 'nonce-n0'";
		new Router().get("/p", navigable((ctx) => {
			if (ctx.nav.stale(new Headers({ "content-security-policy": policy }))) return;
			drawn++;
			ctx.response.headers.set("content-security-policy", policy);
			return page();
		}));
		const { app } = await pipeline();
		const key = await keyOf(app, "/p");
		expect(drawn).toBe(1);

		expect((await nav(app, "/p", key)).headers.get("natsu-part")).toBe("1");
		expect(drawn).toBe(2);

		policy = "script-src 'nonce-other' https://ads.test";
		const stale = await nav(app, "/p", key);
		expect(stale.status).toBe(204);
		expect(stale.headers.get("natsu-reload")).toBe("document");
		expect(drawn).toBe(2);
	});

	test("shown() runs at once on a page, on a part, and never on a refusal; other cookies always go out", async () => {
		let shellText = "Site";
		new Router().get("/p", navigable((ctx) => {
			ctx.setCookie("seen", "1");
			ctx.nav.shown(() => ctx.deleteCookie("flash"));
			return page({ header: shellText });
		}));
		const { app } = await pipeline();
		const cookies = (answer: Response) => answer.headers.getSetCookie().map((c) => c.split("=")[0]);

		const whole = await get(app, "/p");
		expect(cookies(whole)).toEqual(["seen", "flash"]);
		const key = metaKey(await whole.text());

		const part = await nav(app, "/p", key);
		expect(part.headers.get("natsu-part")).toBe("1");
		expect(cookies(part)).toEqual(["seen", "flash"]);

		shellText = "Changed";
		const refused = await nav(app, "/p", key);
		expect(refused.headers.get("natsu-reload")).toBe("shell");
		expect(cookies(refused)).toEqual(["seen"]);

		const prefetch = await nav(app, "/p", key, { "natsu-prefetch": "1" });
		expect(cookies(prefetch)).toEqual(["seen"]);
	});

	test("a redirect becomes Natsu-Location, with its cookies; the handler ran once", async () => {
		route("/from");
		let ran = 0;
		new Router().get("/go", navigable((ctx) => {
			ran++;
			ctx.setCookie("signed", "in");
			ctx.response.redirect("/account?tab=1#top", 303);
		}));
		new Router().get("/away", navigable(() => new Response(null, {
			status: 302,
			headers: { location: "https://pay.example/checkout", "set-cookie": "cart=1" },
		})));
		new Router().get("/full", navigable(() => new Response(null, { status: 301, headers: { location: `${BASE}/moved` } })));
		const { app } = await pipeline();
		const key = await keyOf(app, "/from");

		const go = await nav(app, "/go", key);
		expect(go.status).toBe(204);
		expect(go.headers.get("natsu-location")).toBe("/account?tab=1#top");
		expect(go.headers.get("location")).toBeNull();
		expect(go.headers.getSetCookie()).toEqual(["signed=in; Path=/; HttpOnly; SameSite=Lax"]);
		expect(go.headers.get("cache-control")).toBe("private, no-store");
		expect(ran).toBe(1);

		const away = await nav(app, "/away", key);
		expect(away.headers.get("natsu-location")).toBe("https://pay.example/checkout");
		expect(away.headers.getSetCookie()).toEqual(["cart=1"]);

		expect((await nav(app, "/full", key)).headers.get("natsu-location")).toBe("/moved");
	});

	test("a redirect to anything but http(s) is a full load, never a location for the runtime to assign", async () => {
		route("/from");
		let target = "javascript:alert(document.cookie)";
		new Router().get("/next", navigable((ctx) => ctx.response.redirect(target)));
		const { app } = await pipeline();
		const key = await keyOf(app, "/from");
		for (const bad of ["javascript:alert(document.cookie)", "data:text/html,<script>alert(1)</script>", "http://[bad"]) {
			target = bad;
			const answer = await nav(app, "/next", key);
			expect(answer.status).toBe(204);
			expect(answer.headers.get("natsu-location")).toBeNull();
			expect(answer.headers.get("natsu-reload")).toBe("response");
		}
	});

	test("a same-site redirect whose path starts with // stays a path on this site, never another host", async () => {
		route("/from");
		let target = "";
		new Router().get("/next", navigable((ctx) => ctx.response.redirect(target)));
		const { app } = await pipeline();
		const key = await keyOf(app, "/from");
		for (const [to, sent] of [
			[`${BASE}//evil.test/x?y=1`, "/.//evil.test/x?y=1"],
			[`${BASE}/\\evil.test/x`, "/.//evil.test/x"],
			["/ok/path", "/ok/path"],
		] as const) {
			target = to;
			const answer = await nav(app, "/next", key);
			const location = answer.headers.get("natsu-location") ?? "";
			expect(location).toBe(sent);
			// What the runtime does with it: resolve against the page, then compare origins.
			expect(new URL(location, `${BASE}/from`).origin).toBe(BASE);
		}
	});

	test("ctx.nav.reload() is a full load whatever the handler then draws", async () => {
		route("/from");
		new Router().get("/p", navigable((ctx) => {
			ctx.nav.reload("needs a fresh document");
			return page();
		}));
		const { app } = await pipeline();
		const key = await keyOf(app, "/from");
		const answer = await nav(app, "/p", key);
		expect(answer.status).toBe(204);
		expect(answer.headers.get("natsu-reload")).toBe("route");
	});
});

describe("delivery", () => {
	test("a page whose regions cannot be swapped still gets the runtime, without a key: mounts and islands work, visits are real loads", async () => {
		route("/inline", { main: "<script>go()</script>" });
		const { app } = await pipeline();
		const html = await (await get(app, "/inline")).text();
		expect(html).not.toContain('<meta name="natsu"');
		expect(html).toContain("natsu-navigate");
		expect(html.indexOf("natsu-navigate")).toBeLessThan(html.indexOf("</head>"));
	});

	test("a page with a region gets the key and the runtime, with this response's script nonce, before the head's first deferred script", async () => {
		route("/p");
		route("/deferred", { head: '<script src="/assets/head.js" defer></script><script type="module">import "/m.js";</script>' });
		route("/module", { head: '<script type="module">import "/m.js";</script>' });
		const { assets, app } = await pipeline();
		const answer = await get(app, "/p");
		const html = await answer.text();
		const nonce = /'nonce-([^']+)'/.exec(answer.headers.get("content-security-policy") ?? "")?.[1];
		const runtime = assets.url("natsu-navigate");
		expect(runtime).toMatch(/^\/_a\/natsu-navigate\.[0-9a-f]{10}\.js$/);
		const tags = `<meta name="natsu" content="${metaKey(html)}"><script src="${runtime}" nonce="${nonce}" defer></script>`;
		// An inline script runs where it stands, before any deferred one.
		expect(html).toContain(`<script nonce="${nonce}">window.boot = 1;</script>${tags}</head>`);
		expect(metaKey(html)).toMatch(/^[a-z0-9]{1,13}\.[a-z0-9]{1,13}$/);
		// First among the deferred ones, so a page script deferred like it runs after it and finds `natsu`.
		const deferred = await (await get(app, "/deferred")).text();
		expect(deferred.indexOf(runtime)).toBeLessThan(deferred.indexOf('<script src="/assets/head.js" defer>'));
		const module = await (await get(app, "/module")).text();
		expect(module.indexOf(runtime)).toBeLessThan(module.indexOf('<script type="module">'));
	});

	test("the runtime's nonce is the one the CSP lets scripts run by", async () => {
		new Router().get("/two", navigable((ctx) => {
			ctx.response.headers.set("content-security-policy", "style-src 'nonce-styles1'; script-src 'nonce-scripts1' 'strict-dynamic'");
			return page({ nonce: "scripts1" });
		}));
		const { assets, app } = await pipeline();
		const html = await (await get(app, "/two")).text();
		expect(html).toContain(`<script src="${assets.url("natsu-navigate")}" nonce="scripts1" defer></script>`);
	});

	test("a page without a region gets the runtime and no key, so its mounts and islands work", async () => {
		const head = '<head><title>x</title><!-- <script src="/old.js"></script> --><style>p{} /* <script> */</style><script src="/page.js" defer></script></head>';
		new Router().get("/flat", navigable(() => `<!doctype html><html>${head}<body>no regions</body></html>`));
		new Router().get("/bare", navigable(() => "<!doctype html><html><head><title>x</title></head><body></body></html>"));
		new Router().get("/headless", navigable(() => "<p>a fragment</p>"));
		const { assets, app } = await pipeline();
		const tag = `<script src="${assets.url("natsu-navigate")}" defer></script>`;
		const flat = await (await get(app, "/flat")).text();
		expect(flat).not.toContain('name="natsu"');
		expect(flat).toContain(`</style>${tag}<script src="/page.js" defer></script></head>`);
		expect(await (await get(app, "/bare")).text()).toContain(`<title>x</title>${tag}</head>`);
		expect(await (await get(app, "/headless")).text()).toBe("<p>a fragment</p>");
	});

	test("with prefetches off the key says so, so the runtime never sends one", async () => {
		route("/p");
		const { app } = await pipeline({ navigate: { prefetch: false } });
		const html = await (await get(app, "/p")).text();
		expect(html).toContain(`<meta name="natsu" content="${metaKey(html)}" data-prefetch="off">`);
	});

	test("the runtime is a classic script served from the chunk path, immutable", async () => {
		const { assets, app } = await pipeline();
		const answer = await get(app, assets.url("natsu-navigate"));
		expect(answer.status).toBe(200);
		expect(answer.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
		expect(answer.headers.get("cache-control")).toContain("immutable");
		const code = await answer.text();
		expect(code).not.toMatch(/\bexport\b|\bimport\b/);
		// The client runtime itself, speaking this wire format, minified and without its console lines.
		for (const word of ["Natsu-Nav", "Natsu-Prefetch", "natsu-part", "natsu-location", 'meta[name="natsu"]', "data-natsu-region", "data-natsu-later"]) {
			expect(code).toContain(word);
		}
		expect(code).not.toContain("real load");
		expect(code.split("\n").length).toBeLessThan(5);
		expect(brotliCompressSync(new TextEncoder().encode(code)).byteLength).toBeLessThanOrEqual(4000);
	});

	test("in development the runtime is built readable, with the console lines that say why a visit was a full load", async () => {
		setConfig({ General: { development: true, logLevel: "silent" } });
		const { assets, app } = await pipeline();
		const code = await (await get(app, assets.url("natsu-navigate"))).text();
		expect(code).toContain("natsu: real load,");
		expect(code.split("\n").length).toBeGreaterThan(100);
	});

	test("with inject off a page carries the key and no runtime, and a page without a region is left alone", async () => {
		route("/p");
		const flat = "<!doctype html><html><head><title>x</title></head><body>no regions</body></html>";
		new Router().get("/flat", navigable(() => flat));
		const { app } = await pipeline({ navigate: { inject: false } });
		const html = await (await get(app, "/p")).text();
		expect(metaKey(html)).not.toBe("");
		expect(html).not.toContain("natsu-navigate");
		expect(await (await get(app, "/flat")).text()).toBe(flat);
	});

	test("the key and runtime are filled in after PageCache, with each visitor's nonce", async () => {
		const { assets, app } = await pipeline();
		const pages = new PageCache({ prepare: (html) => assets.rewrite(html) });
		new Router().get("/p", navigable(async (ctx) => {
			const nonce = crypto.randomUUID().replaceAll("-", "");
			csp(ctx, nonce);
			const kept = await pages.serve("/p", [nonce], async ([mark]) => ({ body: page({ nonce: mark }), status: 200 }));
			if (kept?.prepared) assets.markRewritten(ctx, kept);
			return kept?.body;
		}));
		for (let i = 0; i < 2; i++) {
			const answer = await get(app, "/p");
			const nonce = /'nonce-([^']+)'/.exec(answer.headers.get("content-security-policy") ?? "")?.[1];
			const html = await answer.text();
			expect(html).toContain(`<script src="${assets.url("natsu-navigate")}" nonce="${nonce}" defer></script>`);
			expect(html).not.toContain("natsu-secret-");
		}
		expect(pages.counts.fresh).toBe(1);
	});

	test.each<[string, Partial<AssetsOptions>]>([
		["", {}],
		[", lazy stylesheet loaders included", { safelist: ["big"], lazyStyles: true }],
	])("a kept page's answers are the fresh render's, byte for byte, secrets in the shell included%s", async (_, options) => {
		const { assets, app } = await pipeline({ assets: options });
		const pages = new PageCache({ prepare: (html) => assets.rewrite(html) });
		const secrets = (ctx: Context) => [ctx.request.headers.get("x-nonce") ?? "", ctx.request.headers.get("x-visitor") ?? ""];
		const draw = ([nonce, csrf]: readonly string[]) => page({ nonce, csrf, main: `<p class="card" data-n="${nonce}">${csrf}</p>` });
		new Router().get("/fresh", navigable((ctx) => {
			csp(ctx, secrets(ctx)[0]!);
			return draw(secrets(ctx));
		}));
		new Router().get("/kept", navigable(async (ctx) => {
			csp(ctx, secrets(ctx)[0]!);
			const kept = await pages.serve("/kept", secrets(ctx), async (marks) => ({ body: draw(marks), status: 200 }));
			if (kept?.prepared) assets.markRewritten(ctx, kept);
			return kept?.body;
		}));
		// Changed after PageCache: the answer is read as it is.
		new Router().get("/changed", navigable(async (ctx) => {
			csp(ctx, secrets(ctx)[0]!);
			const kept = await pages.serve("/kept", secrets(ctx), async (marks) => ({ body: draw(marks), status: 200 }));
			if (kept?.prepared) assets.markRewritten(ctx, kept);
			return kept?.body.replace("<h1", "<h1 data-changed");
		}));
		for (const visitor of ["alice-token", "bob-token", "alice-token"]) {
			const headers = { "x-nonce": crypto.randomUUID().replaceAll("-", ""), "x-visitor": visitor };
			const fresh = await (await get(app, "/fresh", headers)).text();
			const kept = await (await get(app, "/kept", headers)).text();
			expect(kept).toBe(fresh);
			expect(metaKey(kept)).not.toBe("");
			expect(kept).toContain(`nonce="${headers["x-nonce"]}" defer></script>`);
			const changed = await (await get(app, "/changed", headers)).text();
			expect(changed).toBe(fresh.replace("<h1", "<h1 data-changed"));
			if (options.lazyStyles) expect(kept).toContain(`<script nonce="${headers["x-nonce"]}">(()=>{`);
		}
		expect(pages.counts.rendered).toBe(1);
	});

	test("parts are compressed like pages; 204s are left alone", async () => {
		route("/from");
		route("/big", { main: `<section class="card">${"<p>lorem ipsum dolor sit amet</p>".repeat(200)}</section>` });
		route("/plain", {}, false);
		const { app } = await pipeline({ compress: true });
		const key = await keyOf(app, "/from");
		const part = await nav(app, "/big", key, { "accept-encoding": "br" });
		expect(part.headers.get("content-encoding")).toBe("br");
		expect(part.headers.get("vary")).toBe("Natsu-Nav, Accept-Encoding");
		const text = new TextDecoder().decode(brotliDecompressSync(new Uint8Array(await part.arrayBuffer())));
		expect(text).toContain("lorem ipsum");
		expect(text).toStartWith("<!doctype html><html><head>");

		const refused = await nav(app, "/plain", key, { "accept-encoding": "br" });
		expect(refused.status).toBe(204);
		expect(refused.headers.get("content-encoding")).toBeNull();
	});

	test("two visitors' secrets never cross through a kept page's parts", async () => {
		const { assets, app } = await pipeline();
		const pages = new PageCache({ prepare: (html) => assets.rewrite(html) });
		let lastNonce = "";
		const visitorPage: Handler = async (ctx) => {
			const nonce = crypto.randomUUID().replaceAll("-", "");
			lastNonce = nonce;
			const token = ctx.request.headers.get("x-visitor") ?? "";
			csp(ctx, nonce);
			const kept = await pages.serve(ctx.path, [nonce, token], async ([n, t]) => ({
				body: page({ nonce: n, csrf: t, main: `<form><input name="csrf" value="${t}"></form><script type="application/ld+json" nonce="${n}">{}</script>` }),
				status: 200,
			}));
			if (kept?.prepared) assets.markRewritten(ctx);
			return kept?.body;
		};
		new Router().get("/one", navigable(visitorPage));
		new Router().get("/two", navigable(visitorPage));
		const as = (visitor: string) => ({ "x-visitor": visitor });
		const alice = await keyOf(app, "/one", as("alice-token"));
		const bob = await keyOf(app, "/one", as("bob-token"));
		expect(alice.split(".")[1]).not.toBe(bob.split(".")[1]);

		// Alice drew /two first, so Bob's part comes from the kept page.
		await get(app, "/two", as("alice-token"));
		const forBob = await nav(app, "/two", bob, as("bob-token"));
		const bobPart = await forBob.text();
		expect(forBob.headers.get("natsu-part")).toBe("1");
		expect(bobPart).toContain('value="bob-token"');
		expect(bobPart).not.toContain("alice-token");
		expect(bobPart).not.toContain("natsu-secret-");
		// The region's data block carries Bob's own nonce (the part itself carries no CSP).
		expect(bobPart).toContain(`nonce="${lastNonce}"`);

		// Alice's key does not open Bob's shell.
		const crossed = await nav(app, "/two", alice, as("bob-token"));
		expect(crossed.headers.get("natsu-reload")).toBe("shell");
	});

	test("with lazy styles the stylesheet link names its later half for the runtime", async () => {
		route("/p", { main: '<p class="card">x</p>' });
		const { app } = await pipeline({ assets: { safelist: ["big"], lazyStyles: true } });
		const html = await (await get(app, "/p")).text();
		expect(html).toMatch(/<link rel="stylesheet" href="\/_a\/site\.[0-9a-f]+\.css" data-natsu-later="\/_a\/site-later\.[0-9a-f]+\.css">/);
	});
});

describe("islands", () => {
	test("island() is public; a fetch it answers says Natsu-Island and runs once, with no key and no runtime", async () => {
		expect(natsu.island).toBe(island);
		let ran = 0;
		let seen: string | null = "unset";
		new Router().get("/bell", island((ctx) => {
			ran++;
			seen = ctx.request.headers.get("natsu-island");
			ctx.response.headers.set("cache-control", "private, no-store");
			return '<div class="card">3 new</div>';
		}));
		const { app } = await pipeline();
		const answer = await get(app, "/bell", { "natsu-island": "1" });
		expect(answer.status).toBe(200);
		expect(answer.headers.get("natsu-island")).toBe("1");
		expect(answer.headers.get("vary")).toContain("Natsu-Island");
		expect(ran).toBe(1);
		expect(seen).toBeNull();
		const text = await answer.text();
		expect(text).not.toContain("natsu-navigate");
		expect(text).not.toContain('name="natsu"');
	});

	test("any other route is refused before its handler runs: an island named in user content cannot pull in a page", async () => {
		let ran = 0;
		new Router().get("/account/delete", navigable(() => {
			ran++;
			return page({ main: '<form method="post"><input name="csrf" value="secret"></form>' });
		}));
		new Router().get("/plain", () => {
			ran++;
			return "<p>plain</p>";
		});
		const { app } = await pipeline();
		for (const path of ["/account/delete", "/plain", "/no-such-path"]) {
			const answer = await get(app, path, { "natsu-island": "1" });
			expect(answer.status).toBe(204);
			expect(answer.headers.get("natsu-island")).toBeNull();
			expect(answer.headers.get("cache-control")).toBe("private, no-store");
			expect(await answer.text()).toBe("");
		}
		expect(ran).toBe(0);
		// Without the header the page is the page.
		expect((await get(app, "/account/delete")).status).toBe(200);
		expect(ran).toBe(1);
	});

	test("the header is ignored on anything but a GET fetch", async () => {
		let ran = 0;
		new Router().get("/plain", () => {
			ran++;
			return "<p>plain</p>";
		});
		const { app } = await pipeline();
		const answer = await get(app, "/plain", { "natsu-island": "1", "sec-fetch-mode": "navigate" });
		expect(answer.status).toBe(200);
		expect(ran).toBe(1);
	});
});

describe("decorated routes", () => {
	test("@Navigable() and @Island() mark a method in either order with its @Get", async () => {
		@Controller("/deco")
		class Deco {
			@Navigable()
			@Get("/page")
			page(): string {
				return page({ main: "<p>deco</p>" });
			}

			@Get("/quiet")
			@Navigable({ prefetch: false })
			quiet(): string {
				return page({ main: "<p>quiet</p>" });
			}

			@Island()
			@Get("/bell")
			bell(): string {
				return "<b>1</b>";
			}

			@Get("/plain")
			plain(): string {
				return page();
			}
		}
		void Deco;
		const { app } = await pipeline();
		const key = await keyOf(app, "/deco/page");
		expect((await nav(app, "/deco/page", key)).headers.get("natsu-part")).toBe("1");
		expect((await nav(app, "/deco/quiet", key)).headers.get("natsu-part")).toBe("1");
		expect((await nav(app, "/deco/quiet", key, { "natsu-prefetch": "1" })).headers.get("natsu-prefetch")).toBe("skip");
		expect((await nav(app, "/deco/plain", key)).headers.get("natsu-reload")).toBe("route");
		expect((await get(app, "/deco/bell", { "natsu-island": "1" })).headers.get("natsu-island")).toBe("1");
		expect((await get(app, "/deco/page", { "natsu-island": "1" })).status).toBe(204);
	});

	test("routes that name a controller (\"Shop@index\") opt in by name, the controller added before or after", async () => {
		new Router().get("/shop", navigable("Shop@index"));
		new Router().get("/shop/bell", island("Shop@bell"));
		const shop = new Controller("Shop");
		shop.Add("index", () => page({ main: "<p>shop</p>" }));
		shop.Add("bell", () => "<b>2</b>");
		const { app } = await pipeline();
		const key = await keyOf(app, "/shop");
		const part = await nav(app, "/shop", key);
		expect(part.headers.get("natsu-part")).toBe("1");
		expect(await part.text()).toContain("<p>shop</p>");
		const bell = await get(app, "/shop/bell", { "natsu-island": "1" });
		expect(bell.headers.get("natsu-island")).toBe("1");
		expect(await bell.text()).toBe("<b>2</b>");
	});
});

describe("development", () => {
	test("every full load says why, and a shell change shows what changed", async () => {
		const lines: string[] = [];
		// The Application sets the log level from config when it is built.
		setConfig({ General: { development: true, logLevel: "info" } });
		setLogSink((line) => lines.push(line));
		try {
			let banner = "";
			new Router().get("/p", navigable(() => page({ header: `Site${banner}` })));
			const { app } = await pipeline();
			const key = await keyOf(app, "/p");
			banner = " — maintenance at noon";
			await nav(app, "/p", key);
			const line = lines.find((l) => l.includes("full load (shell)")) ?? "";
			expect(line).toContain("GET /p");
			expect(line).toContain("maintenance at noon");
			expect(line).toMatch(/line 1, column \d+/);
		} finally {
			setLogSink(() => {});
			setLogLevel("silent");
		}
	});

	test("a CSP set after Assets ran is named: the runtime's tag could not get its nonce", async () => {
		const lines: string[] = [];
		setConfig({ General: { development: true, logLevel: "info" } });
		setLogSink((line) => lines.push(line));
		try {
			new Router().get("/late", navigable(() => page({ nonce: "abc" })));
			const { app } = await pipeline();
			await get(app, "/late");
			await get(app, "/late");
			const said = lines.filter((l) => l.includes("no Content-Security-Policy when Assets ran"));
			expect(said).toHaveLength(1);
			expect(said[0]).toContain("/late");
		} finally {
			setLogSink(() => {});
			setLogLevel("silent");
		}
	});
});

describe("cost", () => {
	test("cutting a part from a 19, 72 and 282 KB page stays well under a millisecond or so", () => {
		const filler = '<section class="grid gap-4"><a href="/p/x/y" class="flex items-center gap-3 rounded border px-3 py-2"><p class="text-sm">lorem ipsum dolor</p></a></section>';
		const timings: string[] = [];
		for (const copies of [60, 320, 1300]) {
			const html = page({ main: `<script type="application/ld+json">{"x":"</main>"}</script>${filler.repeat(copies)}` });
			const runs = 50;
			const started = Bun.nanoseconds();
			for (let i = 0; i < runs; i++) {
				const scan = scanPage(html);
				if (!scan || "reason" in scan) throw new Error("no scan");
				const shell = Bun.hash(shellOf(html, scan)).toString(36);
				partOf(html, scan, `a.${shell}`, ["n0"]);
			}
			const ms = (Bun.nanoseconds() - started) / 1e6 / runs;
			timings.push(`${Math.round(html.length / 1024)} KB ${ms.toFixed(3)} ms`);
			// A generous bound: the point is linear and small, not a benchmark in CI.
			expect(ms).toBeLessThan(25);
		}
		expect(timings).toHaveLength(3);
	});
});
