/**
 * Page files: routes from `pages/**\/*.uwu`, data found by name, the
 * `<page>` block, head tags, PageCache and page switching.
 *
 * Every test writes a small app directory, mounts it on a fresh router and
 * talks to it over a real socket, since `/p/:slug` is matched by Bun.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as natsu from "../index.ts";
import { Assets } from "../src/assets.ts";
import { splitPageBlock } from "../src/pages/block.ts";
import { compilePageFile, compilePages, routeOf } from "../src/pages/compile.ts";
import { clearSources, defaultKind, registerModelResolver, source } from "../src/pages/data.ts";
import { Forbidden, NotFound, PageCompileError } from "../src/pages/errors.ts";
import { type PagesOptions, type PageSite, mountPages } from "../src/pages/mount.ts";
import { Application } from "../src/server.ts";
import { type RunningApp, reset, startApp } from "./helpers.ts";

let dir: string;
let running: RunningApp | undefined;
let site: PageSite | undefined;

beforeEach(() => {
	reset({ General: { logFormat: "", logLevel: "silent", url: "https://shop.test" } });
	clearSources();
	dir = mkdtempSync(join(tmpdir(), "natsu-pages-"));
});

afterEach(async () => {
	site?.close();
	site = undefined;
	await running?.stop();
	running = undefined;
	rmSync(dir, { recursive: true, force: true });
});

function write(files: Record<string, string>): void {
	for (const [file, text] of Object.entries(files)) {
		const full = join(dir, "pages", file);
		mkdirSync(dirname(full), { recursive: true });
		writeFileSync(full, text);
	}
}

/** Write the files, mount them, start a server. */
async function serve(files: Record<string, string>, options: Omit<PagesOptions, "dir"> = {}, setup?: (app: Application) => void) {
	write(files);
	const app = new Application();
	setup?.(app);
	site = await mountPages({ dir, app, ...options });
	running = await startApp(app);
	return { app, site, get: (path: string, init?: RequestInit) => running!.fetch(path, init) };
}

const LAYOUT = `<template><!doctype html><html><head>{{{page.head}}}</head><body><main id="main" data-natsu-region>{{> @child}}</main></body></html></template>`;

/** The text of `<main>`, tags dropped. */
const mainText = (html: string): string =>
	(/<main[^>]*>([\s\S]*)<\/main>/.exec(html)?.[1] ?? html).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("routes from files", () => {
	test("file paths map to routes, [param] to :param", () => {
		expect(routeOf("index.uwu")).toEqual({ route: "/", params: [] });
		expect(routeOf("about.uwu")).toEqual({ route: "/about", params: [] });
		expect(routeOf("jobs/index.uwu")).toEqual({ route: "/jobs", params: [] });
		expect(routeOf("p/[slug].uwu")).toEqual({ route: "/p/:slug", params: ["slug"] });
		expect(routeOf("shop/[shop]/items/[id].uwu")).toEqual({ route: "/shop/:shop/items/:id", params: ["shop", "id"] });
		expect(() => routeOf("a b.uwu")).toThrow(PageCompileError);
		expect(() => routeOf("[...rest].uwu")).toThrow(/cannot be part of a route/);
	});

	test("pages answer with params; _ files and directories are not routes", async () => {
		const { get } = await serve({
			"index.uwu": `<template><h1>Home</h1></template>`,
			"jobs/index.uwu": `<template><h1>Jobs</h1></template>`,
			"p/[slug].uwu": `<template><h1>Product {{params.slug}}</h1></template>`,
			"_partials/card.uwu": `<template><b>card</b></template>`,
		});
		expect(site!.routes.map((route) => route.path).sort()).toEqual(["/", "/jobs", "/p/:slug"]);
		expect(await (await get("/")).text()).toContain("<h1>Home</h1>");
		expect(await (await get("/jobs/")).text()).toContain("<h1>Jobs</h1>");
		const product = await get("/p/blue%20shoe");
		expect(product.status).toBe(200);
		expect(product.headers.get("content-type")).toBe("text/html; charset=utf-8");
		expect(await product.text()).toContain("<h1>Product blue shoe</h1>");
		expect((await get("/_partials/card")).status).toBe(404);
	});

	test("nested layouts wrap innermost first; layout=none and a named layout replace the chain", async () => {
		const { get } = await serve({
			"_layout.uwu": `<template><div class="outer">{{> @child}}</div></template>`,
			"jobs/_layout.uwu": `<template><div class="inner">{{> @child}}</div></template>`,
			"jobs/[id].uwu": `<template><p>job {{params.id}}</p></template>`,
			"jobs/raw.uwu": `<page layout="none"></page><template><p>raw</p></template>`,
			"jobs/bare.uwu": `<page layout="_bare"></page><template><p>bare</p></template>`,
			"_bare.uwu": `<template><section>{{> @child}}</section></template>`,
		});
		expect(await (await get("/jobs/7")).text()).toBe(`<div class="outer"><div class="inner"><p>job 7</p></div></div>`);
		expect(await (await get("/jobs/raw")).text()).toBe(`<p>raw</p>`);
		expect(await (await get("/jobs/bare")).text()).toBe(`<section><p>bare</p></section>`);
	});

	test("two files for one route, or a missing named layout, fail at mount", async () => {
		write({ "a.uwu": `<template>a</template>`, "a/index.uwu": `<template>a</template>` });
		await expect(mountPages({ dir })).rejects.toThrow(/answers \/a, as pages\/a.uwu already does/);
		rmSync(join(dir, "pages"), { recursive: true });
		write({ "b.uwu": `<page layout="_nope"></page><template>b</template>` });
		await expect(mountPages({ dir })).rejects.toThrow(/pages\/b.uwu:1: .*no layout pages\/_nope.uwu/);
	});

	test("compilePages writes modules and a manifest that mount the same pages", async () => {
		write({
			"_layout.uwu": LAYOUT,
			"p/[slug].uwu": `<template><h1>{{product.name}}</h1></template><style>h1 { color: red; }</style>`,
		});
		source("product", ({ params }) => ({ name: `P-${params.slug}` }));
		const out = join(dir, "build");
		const manifest = compilePages(dir, out);
		expect(manifest.files.map((file) => file.module).sort()).toEqual(["pages/_layout.js", "pages/p/[slug].js"]);
		expect(await Bun.file(join(out, "pages.css")).text()).toContain("color:");
		// The build answers on its own: the sources are gone from disk.
		rmSync(join(dir, "pages"), { recursive: true });
		const app = new Application();
		site = await mountPages({ built: out, app });
		running = await startApp(app);
		const html = await (await running.fetch("/p/x")).text();
		expect(html).toContain("<title>P-x</title>");
		expect(html).toMatch(/<h1 data-uwu-c-[0-9a-f]+="">P-x<\/h1>/);
		expect(html).toMatch(/<style>h1\[data-uwu-c-/);
	});
});

describe("automatic data", () => {
	test("request names first, then <data>, then a source, then the model resolver", async () => {
		const called: string[] = [];
		// A source named like a request name never shadows the request.
		source("params", () => {
			called.push("params source");
			return { slug: "wrong" };
		});
		source("byDecl", () => "from <data>");
		source("title", () => "from the source named title");
		source("shadowed", () => "the source");
		registerModelResolver({
			one: () => {
				called.push("one");
				return { name: "from the resolver" };
			},
			many: () => [{ name: "listed" }],
		});
		const { get } = await serve({
			"p/[slug].uwu": `<page><data shadowed="byDecl"></data></page>
<template><i>{{params.slug}}</i><i>{{shadowed}}</i><i>{{title}}</i><i>{{product.name}}</i>{{#each products}}<i>{{name}}</i>{{/each}}<i>{{query.q}}</i></template>`,
		});
		const html = await (await get("/p/shoe?q=red")).text();
		expect(html).toBe("<i>shoe</i><i>from &lt;data&gt;</i><i>from the source named title</i><i>from the resolver</i><i>listed</i><i>red</i>");
		expect(called).toEqual(["one"]);
		const plan = site!.routes[0]!.data;
		expect(plan).toEqual([
			{ name: "params", kind: "request", from: "params" },
			{ name: "shadowed", kind: "source", from: "byDecl" },
			{ name: "title", kind: "source", from: "title" },
			{ name: "product", kind: "one", from: "product" },
			{ name: "products", kind: "many", from: "products" },
			{ name: "query", kind: "request", from: "query" },
		]);
	});

	test("a name nothing provides fails at mount, naming the file, the line and the name", async () => {
		write({ "p/[slug].uwu": `<template>\n<h1>{{params.slug}}</h1>\n<p>{{stock.count}}</p>\n</template>` });
		const failure = await mountPages({ dir }).catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(PageCompileError);
		expect((failure as Error).message).toBe(
			`pages/p/[slug].uwu:3: 'stock' is read, and nothing provides it: register source("stock", …), add <data stock="…"> to <page>, or a model resolver that knows it`,
		);
		// The layout's reads count too, at the layout's line.
		rmSync(join(dir, "pages"), { recursive: true });
		write({ "_layout.uwu": `<template>\n\n{{menu}}{{> @child}}</template>`, "index.uwu": `<template>x</template>` });
		await expect(mountPages({ dir })).rejects.toThrow("pages/_layout.uwu:3: 'menu' is read");
	});

	test("model kinds: a singular name takes its matching parameter, a plural name is a list", () => {
		expect(defaultKind("product", ["product"])).toEqual({ kind: "one", param: "product" });
		expect(defaultKind("product", ["productId"])).toEqual({ kind: "one", param: "productId" });
		expect(defaultKind("product", ["slug"])).toEqual({ kind: "one", param: "slug" });
		expect(defaultKind("products", [])).toEqual({ kind: "many" });
		expect(defaultKind("address", [])).toBeNull();
		expect(defaultKind("product", [])).toBeNull();
	});

	test("a resolver's own kind() decides; many gets ?sort= and ?page=", async () => {
		let seen: unknown;
		registerModelResolver({
			kind: (name) => (name === "people" ? { kind: "many" } : null),
			one: () => null,
			many: (_name, input) => {
				seen = { sort: input.sort, page: input.page, fields: input.fields };
				return [{ name: "Ann" }];
			},
		});
		const { get } = await serve({ "index.uwu": `<template>{{#each people}}{{name}}{{/each}}</template>` });
		expect(await (await get("/?sort=-name&page=3")).text()).toBe("Ann");
		expect(seen).toEqual({ sort: "-name", page: 3, fields: ["name"] });
		expect(await (await get("/?page=-1")).text()).toBe("Ann");
		expect((seen as { page: number }).page).toBe(1);
	});

	test("loads run in parallel; needs wait for what they name", async () => {
		const log: string[] = [];
		const slow = (name: string, value: unknown) => async () => {
			log.push(`${name} start`);
			await wait(60);
			log.push(`${name} end`);
			return value;
		};
		source("a", slow("a", "A"));
		source("b", slow("b", "B"));
		source("product", slow("product", { id: 7 }));
		source("related", async ({ need }) => {
			const product = (await need("product")) as { id: number };
			log.push(`related sees ${product.id}`);
			return [`r${product.id}`];
		}, { needs: ["product"] });
		source("reviews.forProduct", ({ args }) => {
			log.push(`reviews for ${args.id}`);
			return [`v${args.id}`];
		});
		const { get } = await serve({
			"index.uwu": `<page><data reviews="reviews.forProduct id=product.id"></data></page>
<template>{{a}}{{b}}{{#each related}}{{this}}{{/each}}{{#each reviews}}{{this}}{{/each}}</template>`,
		});
		const started = performance.now();
		expect(await (await get("/")).text()).toBe("ABr7v7");
		const took = performance.now() - started;
		// Three 60 ms loads in parallel, and two that wait for one of them: not 180 ms.
		expect(took).toBeLessThan(150);
		expect(log.slice(0, 3).sort()).toEqual(["a start", "b start", "product start"]);
		expect(log.indexOf("related sees 7")).toBeGreaterThan(log.indexOf("product end"));
		expect(log.indexOf("reviews for 7")).toBeGreaterThan(log.indexOf("product end"));
	});

	test("a need on itself, around a loop, fails at mount", async () => {
		source("x", () => 1, { needs: ["y"] });
		source("y", () => 1, { needs: ["x"] });
		write({ "index.uwu": `<template>{{x}}</template>` });
		await expect(mountPages({ dir })).rejects.toThrow(/'x' needs itself: x -> y -> x/);
	});

	test("each source gets the fields the templates read of its name", async () => {
		const fields: Record<string, string[]> = {};
		const record = (name: string, value: unknown) => (input: { fields: string[] }) => {
			fields[name] = input.fields;
			return value;
		};
		source("product", record("product", { name: "Shoe", brand: { name: "B" }, tags: [{ label: "t" }] }));
		source("reviews", record("reviews", [{ body: "ok", author: { name: "Ann" } }]));
		source("whole", record("whole", { a: 1 }));
		source("flag", record("flag", true));
		source("cats", record("cats", []));
		const { get } = await serve({
			"_layout.uwu": `<template>{{product.brand.name}}{{> @child}}</template>`,
			"index.uwu": `<template>
{{product.name}}{{#each product.tags}}{{label}}{{/each}}
{{#each reviews}}{{body}} {{author.name}} {{../product.sku}}{{/each}}
{{component "card" item=whole}}{{#if flag}}y{{/if}}{{#if cats.length}}c{{/if}}
</template>`,
		});
		expect((await get("/")).status).toBe(200);
		expect(fields).toEqual({
			product: ["brand.name", "name", "sku", "tags.label"],
			reviews: ["author.name", "body"],
			whole: ["*"],
			flag: [],
			cats: [],
		});
	});
});

describe("missing and refused", () => {
	const ERROR = `<template><h1>{{error.status}}</h1><p>{{error.message}}</p></template>`;

	test("a required value that is missing is a real 404, drawn by _error.uwu in the layouts", async () => {
		source("products.bySlug", ({ args }) => (args.slug === "shoe" ? { name: "Shoe" } : null));
		const { get } = await serve({
			"_layout.uwu": LAYOUT,
			"_error.uwu": ERROR,
			"p/[slug].uwu": `<page><data product="products.bySlug slug=params.slug" required></data></page><template><h1>{{product.name}}</h1></template>`,
		});
		const found = await get("/p/shoe");
		expect(found.status).toBe(200);
		const missing = await get("/p/hat");
		expect(missing.status).toBe(404);
		const html = await missing.text();
		expect(mainText(html)).toBe("404 product not found");
		expect(html).toContain(`<meta name="robots" content="noindex">`);
	});

	test("the model resolver's missing row, a thrown NotFound and a returned Forbidden", async () => {
		registerModelResolver({ one: (_name, input) => (input.value === "1" ? { title: "Job" } : undefined), many: () => [] });
		source("secret", () => new Forbidden("not yours"));
		source("gone", () => {
			throw new NotFound("gone for good");
		});
		const { get } = await serve({
			"_error.uwu": ERROR,
			"jobs/[id].uwu": `<template>{{job.title}}</template>`,
			"secret.uwu": `<template>{{secret}}</template>`,
			"gone.uwu": `<template>{{gone}}</template>`,
		});
		expect(await (await get("/jobs/1")).text()).toBe("Job");
		const job = await get("/jobs/2");
		expect(job.status).toBe(404);
		expect(await job.text()).toBe("<h1>404</h1><p>job not found</p>");
		const secret = await get("/secret");
		expect(secret.status).toBe(403);
		expect(await secret.text()).toBe("<h1>403</h1><p>not yours</p>");
		expect((await get("/gone")).status).toBe(404);
	});

	test("without _error.uwu the status still goes out; a source that breaks is a 500", async () => {
		source("boom", () => {
			throw new Error("db down");
		});
		source("maybe", () => null);
		const { get } = await serve({
			"boom.uwu": `<template>{{boom}}</template>`,
			"maybe.uwu": `<page><data value="maybe" required></data></page><template>{{value}}</template>`,
		});
		const boom = await get("/boom");
		expect(boom.status).toBe(500);
		expect(await boom.text()).toBe("Internal Server Error");
		const maybe = await get("/maybe");
		expect(maybe.status).toBe(404);
		expect(maybe.headers.get("content-type")).toBe("text/plain; charset=utf-8");
	});

	test("fallback stands in for a failed or empty load; when=session skips signed-out visitors", async () => {
		let cartLoads = 0;
		source("broken", () => {
			throw new Error("down");
		});
		source("cart", () => {
			cartLoads++;
			return { items: 2 };
		});
		const { app, get } = await serve({
			"index.uwu": `<page cache="off"><data stats="broken" fallback='{"n":0}'></data><data cart="cart" when="session" fallback="null"></data></page>
<template>{{stats.n}}|{{#if cart}}{{cart.items}}{{#else}}none{{/if}}</template>`,
		});
		expect(await (await get("/")).text()).toBe("0|none");
		expect(cartLoads).toBe(0);
		const session = app.sessions!.create();
		expect(await (await get("/", { headers: { cookie: `${app.sessions!.cookieName}=${session.id}` } })).text()).toBe("0|2");
		expect(cartLoads).toBe(1);
	});
});

describe("the <page> block", () => {
	const fail = (text: string): string => {
		try {
			splitPageBlock(text, "pages/x.uwu");
		} catch (error) {
			expect(error).toBeInstanceOf(PageCompileError);
			return (error as Error).message;
		}
		throw new Error("no error");
	};

	test("parses attributes and <data> lines, and blanks itself out line for line", () => {
		const text = `<!-- product -->
<page title="{{product.name}} | Shop" description="Buy {{product.name}}" cache="60" layout="_bare">
  <data product="products.bySlug slug=params.slug kind='new' limit=10 live=true none=null" required>
  <data stock="inventory:GET /stock/{{params.slug}}?full=1" fallback="null"/>
  <data cart="cart" when="session"></data>
</page>
<template><h1>{{product.name}}</h1></template>`;
		const { rest, block } = splitPageBlock(text, "pages/x.uwu");
		expect(rest).toBe("\n\n\n\n\n\n<template><h1>{{product.name}}</h1></template>");
		expect(block).toEqual({
			line: 2,
			title: [["product", "name"], " | Shop"],
			description: ["Buy ", ["product", "name"]],
			cache: 60,
			layout: "_bare",
			data: [
				{
					name: "product",
					line: 3,
					required: true,
					when: undefined,
					fallback: undefined,
					from: {
						t: "source",
						source: "products.bySlug",
						args: {
							slug: { t: "path", segments: ["params", "slug"] },
							kind: { t: "literal", v: "new" },
							limit: { t: "literal", v: 10 },
							live: { t: "literal", v: true },
							none: { t: "literal", v: null },
						},
					},
				},
				{
					name: "stock",
					line: 4,
					required: false,
					when: undefined,
					fallback: { v: null },
					from: { t: "api", service: "inventory", method: "GET", path: ["/stock/", ["params", "slug"], "?full=1"] },
				},
				{ name: "cart", line: 5, required: false, when: "session", fallback: undefined, from: { t: "source", source: "cart", args: {} } },
			],
			actions: [],
		});
		expect(splitPageBlock(`<template>x</template>`, "x").block).toBeNull();
		expect(splitPageBlock(`<page cache="off"/><template>x</template>`, "x").block).toEqual({ line: 1, cache: "off", data: [], actions: [] });
	});

	test("refuses expressions, calls and what it does not know, with the line", () => {
		expect(fail(`<page>\n<data p="products.get id=load(params.id)"></page>`)).toBe(
			"pages/x.uwu:2: <data p>: 'load(params.id)' is neither a dotted path nor a literal; no calls or expressions here (compute it in the source)",
		);
		expect(fail(`<page><data p="products.get id=a+b"></page>`)).toContain("'a+b' is neither a dotted path nor a literal");
		expect(fail(`<page><data p="products.get id=a[0]"></page>`)).toContain("'a[0]' is neither");
		expect(fail(`<page title="{{ product.name | upper }}"></page>`)).toContain("is not a dotted path");
		expect(fail(`<page title="{{ fn() }}"></page>`)).toContain("is not a dotted path");
		expect(fail(`<page><data p="api:POST /buy"></page>`)).toContain("a page loads with GET only, not POST");
		expect(fail(`<page><data p="api:GET https://evil.test/x"></page>`)).toContain("starts with one '/'");
		expect(fail(`<page><data p="api:GET //evil.test/x"></page>`)).toContain("starts with one '/'");
		expect(fail(`<page><data p="api:GET /x/{{params.id + 1}}"></page>`)).toContain("is not a dotted path");
		expect(fail(`<page lang="en"></page>`)).toContain("<page> has no 'lang' attribute");
		expect(fail(`<page cache="soon"></page>`)).toContain(`<page cache="soon">: "off" or a number of seconds`);
		expect(fail(`<page><data p="x" q="y"></page>`)).toContain("names one value");
		expect(fail(`<page><data required></page>`)).toContain("<data> needs a name");
		expect(fail(`<page><data p="x" when="admin"></page>`)).toContain(`only when="session"`);
		expect(fail(`<page><data p="x" fallback="nope"></page>`)).toContain("is not a literal");
		expect(fail(`<page><data p="x" required fallback="null"></page>`)).toContain("both required and has a fallback");
		expect(fail(`<page>\n<data p="x">\n<data p="y"></page>`)).toBe("pages/x.uwu:3: 'p' is declared twice in <page>");
		expect(fail(`<page><p>hi</p></page>`)).toContain("only <data> and <action> elements");
		expect(fail(`<page><data p="x">`)).toContain("<page> is not closed");
		expect(fail(`<template>x</template>\n<page cache="off"></page>`)).toBe("pages/x.uwu:2: <page> must come first in the file, before <template>");
	});

	test("a layout may only declare <data>; uwu's own errors carry the file and line", () => {
		expect(() => compilePageFile(`<page title="x"></page><template>{{> @child}}</template>`, "_layout.uwu")).toThrow(
			"pages/_layout.uwu:1: <page title> belongs on a page; a layout file may only declare <data>",
		);
		expect(() => compilePageFile(`<template>\n{{#if x}}</template>`, "index.uwu")).toThrow(/^pages\/index.uwu:\d+: /);
		expect(() => compilePageFile(`<script>import x from "y";</script><template>{{x}}</template>`, "index.uwu")).toThrow(/may not import modules/);
	});

	test("an unknown source or service in <data> fails at mount", async () => {
		write({ "index.uwu": `<page>\n<data p="nope.find"></page><template>{{p}}</template>` });
		await expect(mountPages({ dir })).rejects.toThrow(`pages/index.uwu:2: <data p> calls 'nope.find', and no source("nope.find", …) is registered`);
		write({ "index.uwu": `<page>\n\n<data p="billing:GET /x"></page><template>{{p}}</template>` });
		await expect(mountPages({ dir })).rejects.toThrow("pages/index.uwu:3: <data p> fetches from 'billing', which is not a configured service");
	});
});

describe("service fetches", () => {
	test("GET from the configured base, the path filled and encoded; the cookie only where configured", async () => {
		const seen: { path: string; cookie: string | null; key: string | null }[] = [];
		const stub = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch(request) {
				const url = new URL(request.url);
				seen.push({ path: url.pathname + url.search, cookie: request.headers.get("cookie"), key: request.headers.get("x-key") });
				if (url.pathname === "/stock/missing") return new Response("no", { status: 404 });
				if (url.pathname === "/stock/locked") return new Response("no", { status: 403 });
				if (url.pathname.startsWith("/broken")) return new Response("no", { status: 500 });
				return Response.json({ count: 3, path: url.pathname });
			},
		});
		try {
			const base = `http://127.0.0.1:${stub.port}`;
			const { get } = await serve(
				{
					"_error.uwu": `<template>{{error.status}}</template>`,
					"p/[slug].uwu": `<page><data stock="inventory:GET /stock/{{params.slug}}?full=1" required></data><data ad="ads:GET /ad" fallback="null"></data></page>
<template>{{stock.count}} {{stock.path}}{{ad.text}}</template>`,
					"broken.uwu": `<page><data x="inventory:GET /broken"></data></page><template>{{x}}</template>`,
				},
				{ services: { inventory: { base: `${base}/`, headers: { "x-key": "k1" } }, ads: { base, cookie: false } } },
			);
			const answer = await get("/p/a%2Fb%20c", { headers: { cookie: "sid=visitor" } });
			expect(answer.status).toBe(200);
			expect(await answer.text()).toBe("3 /stock/a%2Fb%20c");
			const inventory = seen.find((s) => s.path.startsWith("/stock/"))!;
			expect(inventory).toEqual({ path: "/stock/a%2Fb%20c?full=1", cookie: "sid=visitor", key: "k1" });
			expect(seen.find((s) => s.path === "/ad")).toEqual({ path: "/ad", cookie: null, key: null });

			expect((await get("/p/missing")).status).toBe(404);
			expect((await get("/p/locked")).status).toBe(403);
			expect((await get("/broken")).status).toBe(502);
		} finally {
			stub.stop(true);
		}
	});
});

describe("head tags", () => {
	test("the title is the first <h1> by default; canonical from the public URL", async () => {
		const { get } = await serve({
			"_layout.uwu": LAYOUT,
			"about.uwu": `<template><p>intro</p><h1 class="big">About <em>us</em> &amp; you</h1><h1>second</h1></template>`,
		});
		const html = await (await get("/about?ref=x")).text();
		expect(html).toContain(`<head><title>About us &#38; you</title><link rel="canonical" href="https://shop.test/about"></head>`);
		expect(html).not.toContain("robots");
	});

	test("<page title> and description fill from data; layouts read page.meta", async () => {
		source("product", () => ({ name: `Shoe "Max" <2>`, summary: "Runs fast" }));
		const { get } = await serve(
			{
				"_layout.uwu": `<template><head>{{{page.head}}}</head><footer>{{page.meta.title}}|{{page.description}}</footer>{{> @child}}</template>`,
				"p/[slug].uwu": `<page title="{{product.name}} | Shop" description="{{product.summary}}"></page><template><h1>ignored</h1></template>`,
			},
			{ baseUrl: "https://cdn.shop.test/" },
		);
		const html = await (await get("/p/max")).text();
		expect(html).toContain(
			`<title>Shoe &#34;Max&#34; &#60;2&#62; | Shop</title><meta name="description" content="Runs fast"><link rel="canonical" href="https://cdn.shop.test/p/max">`,
		);
		expect(html).toContain(`<footer>Shoe &quot;Max&quot; &lt;2&gt; | Shop|Runs fast</footer>`);
	});

	test("a page that reads viewer or session says noindex; a layout that does, does not", async () => {
		const { get } = await serve({
			"_layout.uwu": `<template><head>{{{page.head}}}</head>{{#if viewer}}hi{{/if}}{{> @child}}</template>`,
			"public.uwu": `<template><h1>Public</h1></template>`,
			"mine.uwu": `<template><h1>Mine</h1>{{viewer.name}}</template>`,
			"cart.uwu": `<template><h1>Cart</h1>{{session.cart}}</template>`,
		});
		expect(await (await get("/public")).text()).not.toContain("noindex");
		expect(await (await get("/mine")).text()).toContain(`<meta name="robots" content="noindex">`);
		expect(await (await get("/cart")).text()).toContain(`<meta name="robots" content="noindex">`);
	});
});

describe("caching", () => {
	test("a signed-out visitor's page is kept; cache=off and a signed-in visitor draw every time", async () => {
		let loads = 0;
		source("product", () => ({ name: `load ${++loads}` }));
		const { app, get } = await serve({
			"kept.uwu": `<template>{{product.name}}</template>`,
			"fresh.uwu": `<page cache="off"></page><template>{{product.name}}</template>`,
			"mine.uwu": `<template>{{product.name}} {{session.n}}</template>`,
		});
		expect(await (await get("/kept")).text()).toBe("load 1");
		expect(await (await get("/kept")).text()).toBe("load 1");
		// Another query string is another page.
		expect(await (await get("/kept?x=1")).text()).toBe("load 2");

		expect(await (await get("/fresh")).text()).toBe("load 3");
		expect(await (await get("/fresh")).text()).toBe("load 4");

		const session = app.sessions!.create();
		const cookie = { cookie: `${app.sessions!.cookieName}=${session.id}` };
		expect(await (await get("/kept", { headers: cookie })).text()).toBe("load 5");
		expect(await (await get("/kept", { headers: cookie })).text()).toBe("load 6");

		// A page that reads the session is never kept, even for a visitor without one.
		expect(await (await get("/mine")).text()).toBe("load 7 ");
		expect(await (await get("/mine")).text()).toBe("load 8 ");
	});

	test("a page reading viewer is kept only while there is none; a 404 is never kept", async () => {
		let loads = 0;
		source("product", ({ params }) => (params.slug === "none" ? null : { n: ++loads }), { required: true });
		const { get } = await serve(
			{ "p/[slug].uwu": `<template>{{product.n}}{{#if viewer}} for {{viewer}}{{/if}}</template>` },
			{ viewer: (ctx) => ctx.headers.get("x-user") },
		);
		expect(await (await get("/p/a")).text()).toBe("1");
		expect(await (await get("/p/a")).text()).toBe("1");
		expect(await (await get("/p/a", { headers: { "x-user": "ann" } })).text()).toBe("2 for ann");
		expect((await get("/p/none")).status).toBe(404);
		expect((await get("/p/none")).status).toBe(404);
	});

	test("secrets are drawn as marks and filled per visitor", async () => {
		let draws = 0;
		source("count", () => ++draws);
		const { get } = await serve(
			{ "index.uwu": `<template><script nonce="{{secrets.nonce}}"></script>{{count}}</template>` },
			{ secrets: (ctx) => ({ nonce: ctx.headers.get("x-nonce") ?? "n0" }) },
		);
		expect(await (await get("/", { headers: { "x-nonce": "abc" } })).text()).toBe(`<script nonce="abc"></script>1`);
		expect(await (await get("/", { headers: { "x-nonce": "xyz" } })).text()).toBe(`<script nonce="xyz"></script>1`);
	});

	test("cache: false turns it off for every page", async () => {
		let loads = 0;
		source("n", () => ++loads);
		const { get } = await serve({ "index.uwu": `<template>{{n}}</template>` }, { cache: false });
		expect(await (await get("/")).text()).toBe("1");
		expect(await (await get("/")).text()).toBe("2");
	});
});

describe("page switching", () => {
	test("a page file answers a Natsu-Nav request with a part", async () => {
		writeFileSync(join(dir, "site.css"), "body { margin: 0; } h1 { font-size: 2em; }");
		const assets = new Assets({ outDir: join(dir, "out"), styles: { site: [join(dir, "site.css")] }, navigate: true });
		await assets.build();
		source("product", ({ params }) => ({ name: `Product ${params.slug}` }));
		const { get } = await serve(
			{
				"_layout.uwu": `<template><!doctype html><html><head><meta charset="utf-8">{{{page.head}}}</head><body><header>Shop</header><main id="main" data-natsu-region>{{> @child}}</main></body></html></template>`,
				"index.uwu": `<template><h1>Home</h1></template>`,
				"p/[slug].uwu": `<template><h1>{{product.name}}</h1></template>`,
			},
			{ assets },
			(app) => app.use(assets.middleware()),
		);
		const home = await (await get("/")).text();
		const key = /<meta name="natsu" content="([^"]+)"/.exec(home)?.[1];
		expect(key).toBeTruthy();

		const part = await get("/p/shoe", { headers: { "natsu-nav": key! } });
		expect(part.status).toBe(200);
		expect(part.headers.get("natsu-part")).toBe("1");
		const text = await part.text();
		expect(text).toContain("<title>Product shoe</title>");
		expect(text).toContain(`<main id="main" data-natsu-region><h1>Product shoe</h1></main>`);
		expect(text).not.toContain("<header>");

		// Again, from PageCache: still a part.
		const again = await get("/p/shoe", { headers: { "natsu-nav": key! } });
		expect(again.headers.get("natsu-part")).toBe("1");
		expect(await again.text()).toContain(`<main id="main" data-natsu-region><h1>Product shoe</h1></main>`);
	});
});

describe("development", () => {
	test("a change recompiles; a new file adds its route; a broken file keeps the last good build", async () => {
		const { get } = await serve({ "index.uwu": `<template>one</template>` }, { dev: true });
		expect(await (await get("/")).text()).toBe("one");

		const until = async (path: string, want: string | number): Promise<void> => {
			for (let i = 0; i < 100; i++) {
				const answer = await get(path);
				if (typeof want === "number" ? answer.status === want : (await answer.text()) === want) return;
				await wait(20);
			}
			throw new Error(`${path} never answered ${want}`);
		};
		write({ "index.uwu": `<page cache="off"></page><template>two</template>` });
		await until("/", "two");
		write({ "new.uwu": `<template>new</template>` });
		await until("/new", "new");
		write({ "index.uwu": `<page cache="off"></page><template>{{#if}}</template>` });
		await wait(150);
		expect(await (await get("/")).text()).toBe("two");
	});
});

describe("the public surface", () => {
	test("index.ts exports the page API", () => {
		expect(natsu.mountPages).toBe(mountPages);
		expect(natsu.compilePages).toBe(compilePages);
		expect(natsu.source).toBe(source);
		expect(natsu.registerModelResolver).toBe(registerModelResolver);
		expect(natsu.NotFound).toBe(NotFound);
		expect(natsu.Forbidden).toBe(Forbidden);
	});
});
