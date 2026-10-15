import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Assets, type AssetsOptions } from "../src/assets.ts";
import type { Context } from "../src/context.ts";
import { navigable } from "../src/navigate.ts";
import { workerSource } from "../src/pwa.ts";
import { Router } from "../src/router.ts";
import { Application } from "../src/server.ts";
import { reset } from "./helpers.ts";

const BASE = "http://natsu.test";
let dir: string;

beforeEach(() => {
	reset();
	dir = mkdtempSync(join(tmpdir(), "natsu-pwa-"));
	writeFileSync(join(dir, "site.css"), "body{margin:0}.card{border:1px solid}");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

const PWA: NonNullable<AssetsOptions["pwa"]> = {
	manifest: { name: "Shop", short_name: "Shop", theme_color: "#0b1020", background_color: "#09090b", icons: [{ src: "/icon.png", sizes: "512x512" }] },
	offline: ["/", /^\/legal\//],
	offlineWhen: (ctx: Context) => !ctx.request.headers.get("cookie")?.includes("sid="),
};

const page = (nonce = "n0") =>
	`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Page</title><link rel="stylesheet" href="/assets/site.css"></head>` +
	`<body><header>Site</header><main id="main" data-natsu-region><h1 class="card">Hello</h1></main>` +
	`<script src="/assets/site.js" nonce="${nonce}" defer></script></body></html>`;

async function pipeline(pwa: AssetsOptions["pwa"] | null = PWA) {
	for (const path of ["/", "/legal/terms", "/account"]) {
		new Router().get(path, navigable((ctx) => {
			ctx.response.headers.set("content-security-policy", "script-src 'nonce-n0' 'strict-dynamic'");
			return page();
		}));
	}
	new Router().post("/", navigable(() => page()));
	const assets = new Assets({
		outDir: join(dir, "out"),
		styles: { site: [join(dir, "site.css")] },
		rewrite: { "/assets/site.css": "site" },
		minify: true,
		navigate: true,
		pwa: pwa ?? undefined,
	});
	await assets.build();
	const app = new Application();
	app.use(assets.middleware());
	return { assets, app };
}

const get = (app: Application, path: string, headers: Record<string, string> = {}, method = "GET") =>
	app.handle(new Request(`${BASE}${path}`, { method, headers }));

describe("pwa", () => {
	test("the manifest is served with natsu's defaults under the app's fields", async () => {
		const { app } = await pipeline();
		const answer = await get(app, "/manifest.webmanifest");
		expect(answer.headers.get("content-type")).toBe("application/manifest+json; charset=utf-8");
		expect(answer.headers.get("cache-control")).toBe("no-cache");
		expect(await answer.json()).toEqual({
			id: "/",
			start_url: "/",
			scope: "/",
			display: "standalone",
			name: "Shop",
			short_name: "Shop",
			theme_color: "#0b1020",
			background_color: "#09090b",
			icons: [{ src: "/icon.png", sizes: "512x512" }],
		});
	});

	test("the worker is served fresh, names this build's cache and precaches the scripts", async () => {
		const { app, assets } = await pipeline();
		const answer = await get(app, "/sw.js");
		expect(answer.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
		expect(answer.headers.get("cache-control")).toBe("no-cache");
		expect(answer.headers.get("service-worker-allowed")).toBe("/");
		const code = await answer.text();
		expect(code).toContain(JSON.stringify(assets.url("natsu-navigate")));
		expect(code).toContain(JSON.stringify(assets.url("natsu-pwa")));
		expect(code).toContain('"/_a/"');
		expect(() => new Function(code)).not.toThrow();
	});

	test("a page links the manifest and theme colour, and carries the pwa script after the runtime with the page's nonce", async () => {
		const { app, assets } = await pipeline();
		const html = await (await get(app, "/")).text();
		expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest"><meta name="theme-color" content="#0b1020">');
		const runtime = html.indexOf(assets.url("natsu-navigate"));
		const script = new RegExp(`<script src="${assets.url("natsu-pwa")}" nonce="n0" defer data-natsu-once data-sw="/sw.js" data-offline="[^"]+" data-retry="Retry" data-update="[^"]+" data-reload="Reload"></script>`);
		expect(html).toMatch(script);
		expect(html.search(script)).toBeGreaterThan(runtime);
	});

	test("a part carries the same head tags, so a swap keeps the manifest", async () => {
		const { app } = await pipeline();
		const key = /<meta name="natsu" content="([^"]+)"/.exec(await (await get(app, "/")).text())![1]!;
		const part = await get(app, "/legal/terms", { "natsu-nav": key });
		expect(part.headers.get("natsu-part")).toBe("1");
		const html = await part.text();
		expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest"><meta name="theme-color" content="#0b1020">');
		expect(part.headers.get("natsu-scripts") ?? "").not.toContain("natsu-pwa");
		expect(part.headers.get("natsu-offline")).toBe("1");
		expect((await get(app, "/account", { "natsu-nav": key })).headers.get("natsu-offline")).toBeNull();
	});

	test("only a listed page, answered 200 to a GET the app allows, may be kept offline", async () => {
		const { app } = await pipeline();
		expect((await get(app, "/")).headers.get("natsu-offline")).toBe("1");
		expect((await get(app, "/legal/terms")).headers.get("natsu-offline")).toBe("1");
		expect((await get(app, "/account")).headers.get("natsu-offline")).toBeNull();
		expect((await get(app, "/", { cookie: "sid=abc" })).headers.get("natsu-offline")).toBeNull();
		expect((await get(app, "/", {}, "POST")).headers.get("natsu-offline")).toBeNull();
		expect((await get(app, "/nowhere")).headers.get("natsu-offline")).toBeNull();
	});

	test("without pwa nothing changes", async () => {
		const { app } = await pipeline(null);
		const html = await (await get(app, "/")).text();
		expect(html).not.toContain("manifest");
		expect(html).not.toContain("natsu-pwa");
		expect((await get(app, "/sw.js")).status).toBe(404);
	});

	test("pwa needs navigate", () => {
		expect(() => new Assets({ outDir: join(dir, "out"), pwa: PWA })).toThrow("pwa needs navigate");
	});
});

describe("the worker", () => {
	type Handler = (e: Record<string, unknown>) => void;

	function worker(network: (url: string, init: { mode: string }) => Promise<Response>) {
		const stores = new Map<string, Map<string, Response>>();
		const store = (name: string) => {
			if (!stores.has(name)) stores.set(name, new Map());
			const m = stores.get(name)!;
			const key = (r: string | Request) => (typeof r === "string" ? r : r.url);
			return {
				match: async (r: string | Request) => m.get(key(r))?.clone(),
				put: async (r: string | Request, res: Response) => void m.set(key(r), res),
				delete: async (r: string | Request) => m.delete(key(r)),
				add: async (u: string) => void m.set(new URL(u, BASE).href, new Response(`cached ${u}`)),
			};
		};
		const on: Record<string, Handler> = {};
		const self = { addEventListener: (t: string, fn: Handler) => (on[t] = fn), skipWaiting: () => {}, clients: { claim: async () => {} } };
		const caches = {
			open: async (n: string) => store(n),
			keys: async () => [...stores.keys()],
			delete: async (n: string) => stores.delete(n),
		};
		const code = workerSource("b1", ["/_a/natsu-navigate.x.js"], ["/_a/"], "<p>offline</p>");
		new Function("self", "caches", "fetch", "location", "Response", "URL", code)(
			self,
			caches,
			(r: Request | string) => network(typeof r === "string" ? r : r.url, { mode: typeof r === "string" ? "fetch" : (r as Request & { mode: string }).mode }),
			{ origin: BASE },
			Response,
			URL,
		);
		const run = async (url: string, mode = "navigate", method = "GET", headers: Record<string, string> = {}) => {
			let answer: Promise<Response> | undefined;
			const waits: Promise<unknown>[] = [];
			const request = { url, mode, method, headers: new Headers(headers) } as unknown as Request;
			on.fetch!({ request, respondWith: (p: Promise<Response>) => (answer = p), waitUntil: (p: Promise<unknown>) => waits.push(p) });
			const res = answer && (await answer);
			await Promise.all(waits);
			return res;
		};
		return { on, run, stores };
	}

	test("a page marked natsu-offline is kept and served when the network is gone; any other gets the offline document", async () => {
		let up = true;
		const w = worker(async (url) => {
			if (!up) throw new TypeError("offline");
			return new Response(`page ${url}`, { headers: url.endsWith("/") ? { "natsu-offline": "1" } : {} });
		});
		expect(await (await w.run(`${BASE}/`))!.text()).toBe(`page ${BASE}/`);
		await w.run(`${BASE}/account`);
		up = false;
		expect(await (await w.run(`${BASE}/#top`))!.text()).toBe(`page ${BASE}/`);
		const away = (await w.run(`${BASE}/account`))!;
		expect(away.status).toBe(503);
		expect(await away.text()).toBe("<p>offline</p>");
	});

	test("a page that stops being marked is dropped", async () => {
		let mark = true;
		const w = worker(async () => new Response("p", { headers: mark ? { "natsu-offline": "1" } : {} }));
		await w.run(`${BASE}/`);
		expect(w.stores.get("natsu-b1")!.has(`${BASE}/`)).toBe(true);
		mark = false;
		await w.run(`${BASE}/`);
		expect(w.stores.get("natsu-b1")!.has(`${BASE}/`)).toBe(false);
	});

	test("assets are cache-first; parts, posts and other origins are left to the network", async () => {
		const seen: string[] = [];
		const w = worker(async (url) => (seen.push(url), new Response("x", { headers: { "cache-control": "public, max-age=31536000, immutable" } })));
		await w.run(`${BASE}/_a/site.1.css`, "no-cors");
		await w.run(`${BASE}/_a/site.1.css`, "no-cors");
		expect(seen).toEqual([`${BASE}/_a/site.1.css`]);
		expect(await w.run(`${BASE}/b`, "cors")).toBeUndefined();
		expect(await w.run(`${BASE}/b`, "navigate", "POST")).toBeUndefined();
		expect(await w.run("https://elsewhere.test/", "navigate")).toBeUndefined();
	});

	test("a part of a listed page has the worker keep its full page; any other part is passed through", async () => {
		const seen: string[] = [];
		const w = worker(async (url, init) => (seen.push(`${init.mode} ${url}`), new Response("x", { headers: url.endsWith("/about") ? { "natsu-offline": "1" } : {} })));
		await w.run(`${BASE}/about`, "cors", "GET", { "natsu-nav": "k.s" });
		await w.run(`${BASE}/account`, "cors", "GET", { "natsu-nav": "k.s" });
		expect(seen).toEqual([`cors ${BASE}/about`, `fetch ${BASE}/about`, `cors ${BASE}/account`]);
		expect(w.stores.get("natsu-b1")!.has(`${BASE}/about`)).toBe(true);
		expect(w.stores.get("natsu-b1")!.has(`${BASE}/account`)).toBe(false);
	});

	test("only an immutable answer under an asset prefix is kept: a fallback page for a missing chunk never is", async () => {
		const seen: string[] = [];
		const w = worker(async (url) => (seen.push(url), url.includes("gone") ? new Response("<p>not found</p>", { headers: { "cache-control": "private, no-store" } }) : new Response("x", { headers: { "cache-control": "public, max-age=31536000, immutable" } })));
		await w.run(`${BASE}/_a/gone.1.css`, "no-cors");
		await w.run(`${BASE}/_a/gone.1.css`, "no-cors");
		await w.run(`${BASE}/_a/site.1.css`, "no-cors");
		await w.run(`${BASE}/_a/site.1.css`, "no-cors");
		expect(seen).toEqual([`${BASE}/_a/gone.1.css`, `${BASE}/_a/gone.1.css`, `${BASE}/_a/site.1.css`]);
	});

	test("activate drops older builds' caches", async () => {
		const w = worker(async () => new Response("x"));
		w.stores.set("natsu-old", new Map());
		w.stores.set("other", new Map());
		let done: Promise<unknown> | undefined;
		w.on.activate!({ waitUntil: (p: Promise<unknown>) => (done = p) });
		await done;
		expect([...w.stores.keys()].sort()).toEqual(["other"]);
	});
});
