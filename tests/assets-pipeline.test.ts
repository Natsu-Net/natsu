import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Assets, type AssetReport, type AssetsOptions } from "../src/assets.ts";
import { headTags } from "../src/assets/head.ts";
import { Application } from "../src/server.ts";
import { Router } from "../src/router.ts";
import { reset, startApp, type RunningApp } from "./helpers.ts";

const MOUNT = resolve(import.meta.dir, "../src/client/mount.ts");
const AD_TAG = `<script async src="https://ads.example.test/tag.js?client=1" crossorigin="anonymous" class="card"></script>`;
const FONT = new Uint8Array([0x77, 0x4f, 0x46, 0x32, 0, 1, 2, 3, 250, 251, 252, 253, 254, 255]);
const LIB = `window.remoteLib = function () { return "remote-lib-marker"; };`;

let dir: string;
let out: string;
let running: RunningApp | undefined;
let remote: ReturnType<typeof Bun.serve> | undefined;
let libBody = LIB;
let remoteHits = 0;

function put(path: string, body: string | Uint8Array): string {
	const full = join(dir, path);
	mkdirSync(join(full, ".."), { recursive: true });
	writeFileSync(full, body);
	return full;
}

function page(): string {
	return (
		`<!doctype html><html><head><title>x</title>` +
		`<link rel="stylesheet" href="/static/site.css">` +
		`<script type="module" src="/static/app.js"></script>` +
		AD_TAG +
		`<script src="${remote!.url.origin}/lib.js" crossorigin="anonymous"></script>` +
		`</head><body><div class="card hero-banner"><h1 class="card__title">t</h1></div><div id="widget"></div></body></html>`
	);
}

function options(extra: Partial<AssetsOptions> = {}): AssetsOptions {
	return {
		outDir: out,
		minify: true,
		discover: { templates: [join(dir, "views")], roots: { "/static/": join(dir, "static") } },
		block: ["https://ads.example.test/*"],
		remote: {
			allowLoopbackHttp: true,
			allowPrivate: true,
			lockfile: join(dir, "natsu-assets.lock.json"),
			cacheDir: join(dir, "remote-cache"),
		},
		files: { font: join(dir, "static/font.woff2") },
		rewrite: { "/static/font.woff2": "font" },
		mangle: { markup: [join(dir, "views")], literals: true },
		prefetchChunks: true,
		firstLoad: { inline: true, preload: true },
		...extra,
	};
}

async function serve(pipeline: Assets): Promise<RunningApp> {
	reset();
	new Router().get("/page", (ctx) => {
		ctx.response.body = page();
	});
	new Router().get("/tagged", (ctx) => {
		headTags(ctx).preload("/hero.avif", "image");
		ctx.response.body = page();
	});
	const app = new Application();
	app.use(pipeline.middleware());
	return startApp(app);
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "natsu-pipeline-"));
	out = join(dir, "out");
	libBody = LIB;
	remoteHits = 0;
	remote = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch(request) {
			if (new URL(request.url).pathname !== "/lib.js") return new Response("no", { status: 404 });
			remoteHits++;
			return new Response(libBody, { headers: { "content-type": "text/javascript" } });
		},
	});
	put("static/font.woff2", FONT);
	put(
		"static/site.css",
		`@font-face { font-family: "x"; src: url("/static/font.woff2") format("woff2"); }\n` +
			`.card { border: 1px solid; font-family: "x"; }\n.card__title { font-weight: 600; }\n` +
			`.hero-banner { padding: 1rem; }\n.is-open { display: block; }\n.never-used { color: red; }\n`,
	);
	put("static/widget.js", `export default function widget(el) { el.classList.add("is-open"); el.dataset.ready = "widget-marker"; }\n`);
	put(
		"static/app.js",
		`import { mount } from ${JSON.stringify(MOUNT)};\n` +
			`import { shared } from "./shared.js";\n` +
			`mount("#widget", () => import("./widget.js"));\n` +
			`shared("app");\n` +
			`document.querySelector(".hero-banner")?.classList.toggle("is-open");\n`,
	);
	put("static/shared.js", `export function shared(who) { (window.sharedLog ??= []).push("shared-marker " + who); }\n`);
	put("static/other.js", `import { shared } from "./shared.js";\nshared("other");\n`);
	put("views/page.html", page());
	put("views/other.html", `<html><head><script type="module" src="/static/other.js"></script></head><body></body></html>`);
});

afterEach(async () => {
	await running?.stop();
	running = undefined;
	await remote?.stop(true);
	remote = undefined;
	rmSync(dir, { recursive: true, force: true });
});

describe("asset pipeline end to end", () => {
	test("discovers, blocks, pins, renames and serves a first visit and a return visit", async () => {
		const pipeline = new Assets(options());
		const built = await pipeline.prebuild({ pin: true });
		expect(existsSync(built.manifest)).toBe(true);
		expect(built.remote?.pinned).toEqual([`${remote!.url.origin}/lib.js`]);
		expect(remoteHits).toBeGreaterThan(0);
		const lock = JSON.parse(readFileSync(join(dir, "natsu-assets.lock.json"), "utf8"));
		expect(Object.keys(lock.pins)).toEqual([`${remote!.url.origin}/lib.js`]);

		const report = await pipeline.build();
		running = await serve(pipeline);
		const cold = await running.fetch("/page");
		const coldText = await cold.text();
		const cookie = cold.headers.get("set-cookie") ?? "";
		expect(cookie).toStartWith("natsu-a=");
		expect(cookie).toContain("HttpOnly");
		expect(cookie).toContain("SameSite=Lax");
		expect(cold.headers.get("vary") ?? "").toContain("Cookie");
		expect(cold.headers.get("cache-control")).toBe("private, no-cache");

		expect(coldText).toContain(AD_TAG);
		expect(coldText).not.toContain(remote!.url.origin);
		expect(coldText).not.toContain("/static/");
		expect(coldText).toContain("<style");
		expect(coldText).not.toContain("never-used");
		const preloaded = /<link rel="modulepreload" href="(\/_a\/[^"]+)"/.exec(coldText)?.[1] ?? "";
		expect(await (await running.fetch(preloaded)).text()).toContain("shared-marker");
		expect(coldText).toMatch(/<meta name="natsu-chunks" content="\/_a\/chunks\.[0-9a-f]{10}\.json"/);

		const libUrl = /<script src="(\/_a\/[^"]+)"/.exec(coldText)?.[1] ?? "";
		expect(libUrl).toStartWith("/_a/");
		expect(/<script src="\/_a\/[^>]*>/.exec(coldText)?.[0]).not.toContain("crossorigin");
		expect(await (await running.fetch(libUrl)).text()).toBe(LIB);

		const fontUrl = /url\("?(\/_a\/font\.[0-9a-f]{10}\.woff2)"?\)/.exec(coldText)?.[1] ?? "";
		expect(fontUrl).not.toBe("");
		const font = await running.fetch(fontUrl);
		expect(font.headers.get("content-type")).toBe("font/woff2");
		expect(new Uint8Array(await font.arrayBuffer())).toEqual(FONT);

		const renamed = /<div class="([^"]+)"><h1/.exec(coldText)?.[1] ?? "";
		expect(renamed).not.toContain("hero-banner");
		const short = renamed.split(" ")[1]!;
		const appUrl = /<script type="module" src="(\/_a\/[^"]+)"/.exec(coldText)?.[1] ?? "";
		const appText = await (await running.fetch(appUrl)).text();
		expect(appText).not.toContain("hero-banner");
		expect(appText).toContain(`.${short}`);
		expect(report.mangled?.literals ?? 0).toBeGreaterThan(0);

		const chunksUrl = /name="natsu-chunks" content="([^"]+)"/.exec(coldText)?.[1] ?? "";
		const chunks = await (await running.fetch(chunksUrl)).json();
		const mounts = Object.values(chunks.m as Record<string, Array<[string, string]>>).flat();
		expect(mounts.map((entry) => entry[0])).toContain("#widget");
		const widget = mounts.find((entry) => entry[0] === "#widget")![1];
		expect(await (await running.fetch(widget)).text()).toContain("widget-marker");

		const warm = await running.fetch("/page", { headers: { cookie: cookie.split(";")[0]! } });
		const warmText = await warm.text();
		expect(warm.headers.get("set-cookie")).toBeNull();
		expect(warmText).toMatch(/<link rel="stylesheet" href="\/_a\/[^"]+\.css"/);
		expect(warmText).not.toContain("@font-face");
		expect(warmText).toContain(AD_TAG);

		const tagged = await (await running.fetch("/tagged", { headers: { cookie: cookie.split(";")[0]! } })).text();
		expect(tagged).toContain('<link rel="preload" href="/hero.avif" as="image">');
	});

	test("a prebuilt app boots with no build, no source and no network", async () => {
		await new Assets(options()).prebuild({ pin: true });
		const hits = remoteHits;
		await remote!.stop(true);
		rmSync(join(dir, "static"), { recursive: true, force: true });
		rmSync(join(dir, "views"), { recursive: true, force: true });
		rmSync(join(dir, "remote-cache"), { recursive: true, force: true });

		const realBuild = Bun.build;
		let builds = 0;
		(Bun as { build: unknown }).build = (...args: Parameters<typeof Bun.build>) => {
			builds++;
			return realBuild(...args);
		};
		const pipeline = new Assets(options({ prebuilt: { strict: true } }));
		let report: AssetReport;
		try {
			report = await pipeline.build();
		} finally {
			(Bun as { build: unknown }).build = realBuild;
		}
		expect(builds).toBe(0);
		expect(remoteHits).toBe(hits);
		expect(report.prebuilt).toBe(true);

		running = await serve(pipeline);
		const text = await (await running.fetch("/page")).text();
		expect(text).toContain(AD_TAG);
		expect(text).toContain("<style");
		const libUrl = /<script src="(\/_a\/[^"]+)"/.exec(text)?.[1] ?? "";
		expect(await (await running.fetch(libUrl)).text()).toBe(LIB);
		const fontUrl = /url\("?(\/_a\/font\.[0-9a-f]{10}\.woff2)"?\)/.exec(text)?.[1] ?? "";
		expect(new Uint8Array(await (await running.fetch(fontUrl)).arrayBuffer())).toEqual(FONT);
	});

	test("a changed remote file fails the build until it is pinned again", async () => {
		await new Assets(options()).prebuild({ pin: true });
		rmSync(join(dir, "remote-cache"), { recursive: true, force: true });
		libBody = `${LIB}\nwindow.changed = true;`;
		let message = "";
		try {
			await new Assets(options()).build();
		} catch (cause) {
			message = cause instanceof Error ? cause.message : String(cause);
		}
		expect(message).toContain(`remote asset changed: ${remote!.url.origin}/lib.js`);
		const again = await new Assets(options()).prebuild({ pin: true });
		expect(again.remote?.pinned).toEqual([`${remote!.url.origin}/lib.js`]);
	});

	test("a damaged prebuilt manifest is refused when strict and rebuilt otherwise", async () => {
		const built = await new Assets(options()).prebuild({ pin: true });
		writeFileSync(built.manifest, readFileSync(built.manifest, "utf8").replace(/"sha256":\s*"[0-9a-f]{4}/, '"sha256":"ffff'));
		let message = "";
		try {
			await new Assets(options({ prebuilt: { strict: true } })).build();
		} catch (cause) {
			message = cause instanceof Error ? cause.message : String(cause);
		}
		expect(message).toStartWith("natsu/assets: prebuilt assets refused:");
		const lenient = new Assets(options({ prebuilt: true }));
		expect((await lenient.build()).prebuilt).toBeUndefined();
	});

	test("without the new options nothing new reaches the page", async () => {
		const pipeline = new Assets({
			outDir: out,
			styles: { site: [join(dir, "static/site.css")] },
			rewrite: { "/static/site.css": "site" },
		});
		await pipeline.build();
		running = await serve(pipeline);
		const response = await running.fetch("/page");
		const text = await response.text();
		expect(response.headers.get("set-cookie")).toBeNull();
		expect(text).toContain(AD_TAG);
		expect(text).toContain(`${remote!.url.origin}/lib.js`);
		expect(text).toContain('src="/static/app.js"');
		expect(text).not.toContain("natsu-chunks");
		expect(text).not.toContain("<style");
	});
});
