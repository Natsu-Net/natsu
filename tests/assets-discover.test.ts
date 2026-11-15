import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { discoverAssets, entryName, scanTemplate } from "../src/assets/discover.ts";

let dir: string;

function put(path: string, body = ""): void {
	const full = join(dir, path);
	mkdirSync(dirname(full), { recursive: true });
	writeFileSync(full, body);
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "natsu-discover-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("scanTemplate", () => {
	test("reads script src and stylesheet href with their attributes", () => {
		const tags = scanTemplate(
			`<head><link rel="stylesheet" href="/a.css" media=print><LINK REL='preload stylesheet' HREF='/b.css'>` +
				`<script type="module" src="/m.js"></script><script defer src=/c.js data-once></script></head>`,
		);
		expect(tags.map((tag) => [tag.tag, tag.ref])).toEqual([
			["link", "/a.css"],
			["link", "/b.css"],
			["script", "/m.js"],
			["script", "/c.js"],
		]);
		expect(tags[0]!.attributes).toEqual({ rel: "stylesheet", href: "/a.css", media: "print" });
		expect(tags[2]!.attributes.type).toBe("module");
		expect(tags[3]!.attributes).toEqual({ defer: "", src: "/c.js", "data-once": "" });
		expect(tags.every((tag) => !tag.dynamic)).toBe(true);
	});

	test("ignores comments, inline script bodies and other links", () => {
		const tags = scanTemplate(
			`<!-- <script src="/commented.js"></script> -->` +
				`<link rel="icon" href="/favicon.ico"><link rel="preload" as="font" href="/f.woff2">` +
				`<script>const html = '<script src="/inner.js"><\\/script><link rel="stylesheet" href="/inner.css">';</script>` +
				`<scripted src="/no.js"></scripted><script src="/real.js"></script>`,
		);
		expect(tags.map((tag) => tag.ref)).toEqual(["/real.js"]);
	});

	test("marks template expressions as dynamic and survives quotes inside them", () => {
		const tags = scanTemplate(
			`<script src="{{ asset("app.js") }}"></script>` +
				`<script {{#if fast}}async{{/if}} src="/js/{{name}}.js"></script>` +
				`<link rel="stylesheet" href="/css/\${theme}.css">` +
				`<link rel="stylesheet" href="{% static 'x.css' %}">` +
				`<script src="/plain.js"></script>`,
		);
		expect(tags.map((tag) => [tag.ref, tag.dynamic])).toEqual([
			[`{{ asset("app.js") }}`, true],
			["/js/{{name}}.js", true],
			["/css/${theme}.css", true],
			["{% static 'x.css' %}", true],
			["/plain.js", false],
		]);
	});

	test("does not throw on broken markup", () => {
		expect(scanTemplate(`<script src="/a.js`)).toEqual([]);
		expect(scanTemplate(`<!-- never closed <script src="/a.js"></script>`)).toEqual([]);
		expect(scanTemplate(`<script src="/a.js">never closed`).map((tag) => tag.ref)).toEqual(["/a.js"]);
		expect(scanTemplate(`<link rel=stylesheet href=/a.css`)).toEqual([]);
		expect(scanTemplate(`<link rel=stylesheet href=/a.css>`).map((tag) => tag.ref)).toEqual(["/a.css"]);
		expect(scanTemplate("<")).toEqual([]);
	});

	test("stays linear on hostile input", () => {
		const hostile = `${"<script {{ ".repeat(60_000)}${"<!-".repeat(60_000)}${'<link href="{{'.repeat(60_000)}`;
		const started = performance.now();
		scanTemplate(hostile);
		expect(performance.now() - started).toBeLessThan(1500);
	});
});

describe("entryName", () => {
	test("names by stem, then by path, then by count", () => {
		expect(entryName("module", "/assets/js/app.js?v=3#x", new Set())).toBe("js-app");
		expect(entryName("classic", "/vendor/player.min.js", new Set())).toBe("js-player-min");
		expect(entryName("style", "/rank-pages.css", new Set())).toBe("css-rank-pages");
		expect(entryName("file", "/v/lib.js", new Set(["js-lib"]))).toBe("js-v-lib");
		expect(entryName("module", "/admin/users/list.js", new Set(["js-list"]))).toBe("js-admin-users-list");
		expect(entryName("module", "/a/list.js", new Set(["js-list", "js-a-list"]))).toBe("js-a-list-2");
		expect(entryName("style", "/.css", new Set())).toBe("css-css");
	});
});

describe("discoverAssets", () => {
	test("classifies every ref and gives merge-ready entries", async () => {
		put("public/assets/js/app.ts", "export {};");
		put("public/assets/js/legacy.js", "var a;");
		put("public/assets/js/vendor.min.js", "var v;");
		put("public/assets/css/site.css", ".a{}");
		put("secure/js/boot.mjs", "export {};");
		put(
			"views/layout.html",
			`<link rel="stylesheet" href="/assets/css/site.css?v=2">` +
				`<script type="module" src="/assets/js/app.js"></script>` +
				`<script src="/assets/js/legacy.js" defer></script>` +
				`<script src="/assets/js/vendor.min.js"></script>` +
				`<script type="module" src="/js/boot.js"></script>` +
				`<script src="https://cdn.example/lib.js" integrity="sha384-abc" crossorigin></script>` +
				`<link rel="stylesheet" href="//cdn.example/x.css">` +
				`<script src="https://ads.example/tag.js?client={{client}}"></script>` +
				`<script src="https://ads.example/static.js"></script>` +
				`<script src="/assets/js/{{page}}.js"></script>` +
				`<script src="/assets/js/gone.js"></script>` +
				`<script src="data:text/javascript,1"></script>` +
				`<script src="/elsewhere/x.js"></script>`,
		);
		put("views/pages/home.uwu", `<script type="module" src="/assets/js/app.js"></script>`);
		put("views/notes.txt", `<script src="/assets/js/ignored.js"></script>`);
		const input = {
			cwd: dir,
			templates: ["views"],
			roots: { "/assets/": "public/assets", "/js/": "secure/js" },
			remote: true,
			isBlocked: (ref: string) => ref.startsWith("https://ads.example/"),
		};
		const found = await discoverAssets(input);
		expect(found.scripts).toEqual({ "js-app": "public/assets/js/app.ts", "js-boot": "secure/js/boot.mjs" });
		expect(found.classicScripts).toEqual({ "js-legacy": "public/assets/js/legacy.js" });
		expect(found.files).toEqual({ "js-vendor-min": "public/assets/js/vendor.min.js" });
		expect(found.styles).toEqual({ "css-site": ["public/assets/css/site.css"] });
		expect(found.rewrite).toEqual({
			"/assets/css/site.css?v=2": "css-site",
			"/assets/js/app.js": "js-app",
			"/assets/js/legacy.js": "js-legacy",
			"/assets/js/vendor.min.js": "js-vendor-min",
			"/js/boot.js": "js-boot",
		});
		expect(found.remote).toEqual([
			{ ref: "//cdn.example/x.css", url: "https://cdn.example/x.css", kind: "style" },
			{ ref: "https://cdn.example/lib.js", url: "https://cdn.example/lib.js", kind: "script", integrity: "sha384-abc" },
		]);
		const outcomes = Object.fromEntries(found.refs.map((ref) => [ref.ref, ref.outcome]));
		expect(outcomes).toEqual({
			"//cdn.example/x.css": "remote",
			"/assets/css/site.css?v=2": "style",
			"/assets/js/app.js": "module",
			"/assets/js/gone.js": "missing",
			"/assets/js/legacy.js": "classic",
			"/assets/js/vendor.min.js": "file",
			"/assets/js/{{page}}.js": "dynamic",
			"/elsewhere/x.js": "missing",
			"/js/boot.js": "module",
			"data:text/javascript,1": "unsupported",
			"https://ads.example/static.js": "blocked",
			"https://ads.example/tag.js?client={{client}}": "blocked",
			"https://cdn.example/lib.js": "remote",
		});
		expect(found.skipped.map((ref) => ref.ref)).toEqual([
			"/assets/js/gone.js",
			"/assets/js/{{page}}.js",
			"/elsewhere/x.js",
			"data:text/javascript,1",
			"https://ads.example/static.js",
			"https://ads.example/tag.js?client={{client}}",
		]);
		expect(found.skipped.every((ref) => typeof ref.reason === "string" && ref.reason !== "")).toBe(true);
		expect(found.refs.find((ref) => ref.ref === "/assets/js/app.js")!.templates).toEqual([
			"views/layout.html",
			"views/pages/home.uwu",
		]);
		expect(JSON.stringify(await discoverAssets(input))).toBe(JSON.stringify(found));
	});

	test("remote refs are left out when remote is off", async () => {
		put("views/a.html", `<script src="https://cdn.example/lib.js"></script>`);
		const found = await discoverAssets({ cwd: dir, templates: ["views"], roots: {} });
		expect(found.remote).toEqual([]);
		expect(found.skipped.map((ref) => [ref.ref, ref.outcome])).toEqual([["https://cdn.example/lib.js", "left-out"]]);
	});

	test("explicit entries win and are never repeated", async () => {
		put("public/js/app.ts", "export {};");
		put("public/js/other.ts", "export {};");
		put("public/js/site.js", "var a;");
		put("public/css/site.css", ".a{}");
		put("public/css/panel.css", ".b{}");
		put(
			"views/a.html",
			`<script type="module" src="/js/app.js"></script><script type="module" src="/js/other.js"></script>` +
				`<script src="/js/site.js"></script>` +
				`<link rel="stylesheet" href="/css/site.css"><link rel="stylesheet" href="/css/panel.css">`,
		);
		const found = await discoverAssets({
			cwd: dir,
			templates: ["views"],
			roots: { "/": "public" },
			explicit: {
				scripts: { main: "public/js/app.ts" },
				classicScripts: { "js-site": "elsewhere/site.js" },
				styles: { panel: ["public/css/panel.css", "public/css/site.css"] },
				rewrite: { "/css/panel.css": "panel" },
			},
		});
		expect(found.scripts).toEqual({ "js-other": "public/js/other.ts" });
		expect(found.classicScripts).toEqual({ "js-js-site": "public/js/site.js" });
		expect(found.styles).toEqual({ "css-site": ["public/css/site.css"] });
		expect(found.rewrite).toEqual({
			"/css/site.css": "css-site",
			"/js/app.js": "main",
			"/js/other.js": "js-other",
			"/js/site.js": "js-js-site",
		});
		expect(found.refs.find((ref) => ref.ref === "/css/panel.css")).toMatchObject({ outcome: "explicit", name: "panel" });
	});

	test("overrides rename, point at a file, change the kind and leave out", async () => {
		put("client/canvas/boot.ts", "export {};");
		put("public/big.js", "var a;");
		put("public/plain.js", "var b;");
		put("public/skip.js", "var c;");
		put(
			"views/a.html",
			`<script type="module" src="/js/canvas-boot.js"></script><script src="/big.js"></script>` +
				`<script src="/plain.js"></script><script src="/skip.js"></script>`,
		);
		const found = await discoverAssets({
			cwd: dir,
			templates: ["views"],
			roots: { "/": "public" },
			asIs: ["/big.js"],
			overrides: {
				"/js/canvas-boot.js": { name: "canvas-boot", file: "client/canvas/boot.ts" },
				"/plain.js": { kind: "module" },
				"/skip.js": { skip: true },
			},
		});
		expect(found.scripts).toEqual({ "canvas-boot": "client/canvas/boot.ts", "js-plain": "public/plain.js" });
		expect(found.files).toEqual({ "js-big": "public/big.js" });
		expect(found.classicScripts).toEqual({});
		expect(found.skipped.map((ref) => [ref.ref, ref.outcome])).toEqual([["/skip.js", "left-out"]]);
	});

	test("name collisions fall back to the path slug, override collisions throw", async () => {
		put("public/admin/list.js", "var a;");
		put("public/users/list.js", "var b;");
		put("views/a.html", `<script src="/users/list.js"></script><script src="/admin/list.js"></script>`);
		const base = { cwd: dir, templates: ["views"], roots: { "/": "public" } };
		const found = await discoverAssets(base);
		expect(found.classicScripts).toEqual({ "js-list": "public/admin/list.js", "js-users-list": "public/users/list.js" });
		await expect(
			discoverAssets({ ...base, overrides: { "/admin/list.js": { name: "same" }, "/users/list.js": { name: "same" } } }),
		).rejects.toThrow(/override name "same" for \/users\/list\.js collides/);
		await expect(
			discoverAssets({ ...base, explicit: { files: { taken: "x.js" } }, overrides: { "/admin/list.js": { name: "taken" } } }),
		).rejects.toThrow(/override name "taken" for \/admin\/list\.js collides with an explicit entry/);
	});

	test("two module refs with one file stem throw and name both refs", async () => {
		put("public/admin/list.ts", "export {};");
		put("public/users/list.js", "export {};");
		put(
			"views/a.html",
			`<script type="module" src="/users/list.js"></script><script type="module" src="/admin/list.js"></script>`,
		);
		const base = { cwd: dir, templates: ["views"], roots: { "/": "public" } };
		const failure = await discoverAssets(base).catch((cause: Error) => cause);
		expect(failure).toBeInstanceOf(Error);
		const message = (failure as Error).message;
		expect(message).toContain("/admin/list.js");
		expect(message).toContain("/users/list.js");
		expect(message).toContain("overrides[ref].kind");
		const fixed = await discoverAssets({ ...base, overrides: { "/users/list.js": { skip: true } } });
		expect(fixed.scripts).toEqual({ "js-list": "public/admin/list.ts" });
	});

	test("one file under two refs is one entry", async () => {
		put("public/app.js", "var a;");
		put("views/a.html", `<script src="/app.js"></script><script src="/app.js?v=2"></script>`);
		const found = await discoverAssets({ cwd: dir, templates: ["views"], roots: { "/": "public" } });
		expect(found.classicScripts).toEqual({ "js-app": "public/app.js" });
		expect(found.rewrite).toEqual({ "/app.js": "js-app", "/app.js?v=2": "js-app" });
	});

	test("a path that leaves its root is missing and never read", async () => {
		put("secret/key.js", "var secret;");
		put("public/ok.js", "var a;");
		symlinkSync(join(dir, "secret"), join(dir, "public", "link"));
		put(
			"views/a.html",
			`<script src="/../secret/key.js"></script><script src="/link/key.js"></script><script src="/ok.js"></script>`,
		);
		const found = await discoverAssets({ cwd: dir, templates: ["views"], roots: { "/": "public" } });
		expect(found.classicScripts).toEqual({ "js-ok": "public/ok.js" });
		expect(found.skipped.map((ref) => [ref.ref, ref.outcome])).toEqual([
			["/../secret/key.js", "missing"],
			["/link/key.js", "missing"],
		]);
		expect(found.skipped.every((ref) => /outside root/.test(ref.reason!))).toBe(true);
	});

	test("the longest root prefix wins", async () => {
		put("public/assets/a.js", "var shallow;");
		put("built/a.js", "var deep;");
		put("views/a.html", `<script src="/assets/a.js"></script>`);
		const found = await discoverAssets({
			cwd: dir,
			templates: ["views"],
			roots: { "/": "public", "/assets/": "built" },
		});
		expect(found.classicScripts).toEqual({ "js-a": "built/a.js" });
	});

	test("an unreadable template directory throws, a template file is accepted as is", async () => {
		put("one.tpl", `<script src="/a.js"></script>`);
		put("public/a.js", "var a;");
		await expect(discoverAssets({ cwd: dir, templates: ["nowhere"], roots: {} })).rejects.toThrow(/nowhere/);
		const found = await discoverAssets({ cwd: dir, templates: ["one.tpl"], roots: { "/": "public" } });
		expect(found.classicScripts).toEqual({ "js-a": "public/a.js" });
	});
});
