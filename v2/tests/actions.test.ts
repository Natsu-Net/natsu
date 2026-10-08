/**
 * Page files that do things and stay current: actions (the CSRF check, auth,
 * the 303 back with a flash, a refused form drawn again, the runtime's
 * part), live data (tags in the page, kept pages let go, the socket), the
 * partials walk and the 404 page.
 *
 * Every test writes a small app directory, mounts it and talks to it over a
 * real socket, as tests/pages.test.ts does.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as natsu from "../index.ts";
import { Assets } from "../src/assets.ts";
import { invalidate, onInvalidate, signTags, verifyTags } from "../src/invalidate.ts";
import { Invalid, action, clearActions, guard } from "../src/pages/actions.ts";
import { compilePageFile } from "../src/pages/compile.ts";
import { clearSources, source } from "../src/pages/data.ts";
import { PageCompileError } from "../src/pages/errors.ts";
import { type PagesOptions, type PageSite, mountPages } from "../src/pages/mount.ts";
import { Application } from "../src/server.ts";
import { type RunningApp, reset, startApp } from "./helpers.ts";

let dir: string;
let running: RunningApp | undefined;
let site: PageSite | undefined;

beforeEach(() => {
	reset({ General: { logFormat: "", logLevel: "silent", url: "https://shop.test" } });
	clearSources();
	clearActions();
	dir = mkdtempSync(join(tmpdir(), "natsu-actions-"));
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
		const full = join(dir, file.startsWith("../") ? file.slice(3) : join("pages", file));
		mkdirSync(dirname(full), { recursive: true });
		writeFileSync(full, text);
	}
}

async function serve(files: Record<string, string>, options: Omit<PagesOptions, "dir"> = {}, setup?: (app: Application) => void) {
	write(files);
	const app = new Application();
	setup?.(app);
	site = await mountPages({ dir, app, ...options });
	running = await startApp(app);
	return { app, site, get: (path: string, init?: RequestInit) => running!.fetch(path, { redirect: "manual", ...init }) };
}

const LAYOUT = `<template><!doctype html><html><head>{{{page.head}}}</head><body><main id="main" data-natsu-region>{{> @child}}</main></body></html></template>`;

/** A todo list: a form that adds, a button that removes, a flash, and the form's errors. */
const TODOS = `<page><action add="todos.add"></page>
<template>
<h1>Todos</h1>
{{#if flash}}<p class="flash">{{flash.message}}</p>{{/if}}
<ul>{{#each todos}}<li>{{title}} <button @click="action:todos.remove" data-id="{{id}}">x</button></li>{{/each}}</ul>
<form @submit="action:add"><input name="title" value="{{form.values.title}}">{{#if form.errors.title}}<b class="error">{{form.errors.title}}</b>{{/if}}<input type="password" name="password" value="{{form.values.password}}"></form>
</template>`;

let todos: { id: number; title: string }[] = [];
function registerTodos(): void {
	todos = [];
	let next = 1;
	source("todos", () => todos);
	action(
		"todos.add",
		({ input }) => {
			const title = String(input.title ?? "").trim();
			if (!title) throw new Invalid({ title: "Give it a title" }, "Not added");
			todos.push({ id: next++, title });
			return { flash: `Added ${title}` };
		},
		{ touches: ["todos"] },
	);
	action("todos.remove", ({ input }) => {
		todos = todos.filter((todo) => String(todo.id) !== input.id);
	}, { touches: ["todos"] });
}

/** The CSRF cookie a GET set, and the token in the page's form. */
async function tokenOf(answer: Response): Promise<{ cookie: string; token: string; html: string }> {
	const set = answer.headers.getSetCookie().find((c) => c.startsWith("natsu_csrf="));
	const cookie = set ? set.split(";")[0]! : "";
	const html = await answer.text();
	const token = /name="_csrf" value="([^"]+)"/.exec(html)?.[1] ?? "";
	return { cookie, token, html };
}

const form = (fields: Record<string, string>) => new URLSearchParams(fields);
const cookieOf = (answer: Response, name: string) => answer.headers.getSetCookie().find((c) => c.startsWith(`${name}=`));

describe("actions without script", () => {
	test("a form posts to its page: the action runs, a 303 comes back with a flash shown once", async () => {
		registerTodos();
		const { get } = await serve({ "todos.uwu": TODOS });
		const first = await get("/todos");
		const { cookie, token, html } = await tokenOf(first);
		expect(cookie).toMatch(/^natsu_csrf=[\w-]{32}$/);
		expect(cookie.slice("natsu_csrf=".length)).toBe(token);
		// uwu's markup, with natsu's token beside the action field.
		expect(html).toContain(`<form data-uwu-action="add" data-uwu-event="submit" method="post"><input type="hidden" name="_action" value="add"><input type="hidden" name="_csrf" value="${token}">`);
		expect(cookieOf(first, "natsu_csrf")).not.toContain("HttpOnly");

		const posted = await get("/todos", { method: "POST", body: form({ _action: "add", _csrf: token, title: "milk" }), headers: { cookie } });
		expect(posted.status).toBe(303);
		expect(posted.headers.get("location")).toBe("/todos");
		const flash = cookieOf(posted, "natsu_flash")!;
		expect(flash).toContain("HttpOnly");
		expect(todos).toEqual([{ id: 1, title: "milk" }]);

		const shown = await get("/todos", { headers: { cookie: `${cookie}; ${flash.split(";")[0]}` } });
		const page = await shown.text();
		expect(page).toContain(`<p class="flash">Added milk</p>`);
		expect(page).toContain(`<li>milk <button data-uwu-action="todos.remove" data-uwu-event="click" data-id="1">x</button></li>`);
		expect(cookieOf(shown, "natsu_flash")).toContain("Max-Age=0");

		// The button's action: its data is the input.
		const removed = await get("/todos", { method: "POST", body: form({ _action: "todos.remove", _csrf: token, id: "1" }), headers: { cookie } });
		expect(removed.status).toBe(303);
		expect(todos).toEqual([]);
	});

	test("a refused form is drawn again, 422, with its errors and what was typed (never a password)", async () => {
		registerTodos();
		const { get } = await serve({ "todos.uwu": TODOS });
		const { cookie, token } = await tokenOf(await get("/todos"));
		const refused = await get("/todos", { method: "POST", body: form({ _action: "add", _csrf: token, title: "  ", password: "hunter2" }), headers: { cookie } });
		expect(refused.status).toBe(422);
		const html = await refused.text();
		expect(html).toContain(`<b class="error">Give it a title</b>`);
		expect(html).toContain(`<input name="title" value="  ">`);
		expect(html).toContain(`<input type="password" name="password" value="">`);
		expect(html).toContain(`name="_csrf" value="${token}"`);
		expect(todos).toEqual([]);
		// An action can answer errors instead of throwing them.
		action("todos.check", () => ({ errors: { title: "taken" } }));
		write({ "check.uwu": `<template><form @submit="action:todos.check"></form>{{form.errors.title}}</template>` });
		await site!.reload();
		running!.app.reload();
		const checked = await get("/check", { method: "POST", body: form({ _action: "todos.check", _csrf: token }), headers: { cookie } });
		expect(checked.status).toBe(422);
		expect(await checked.text()).toContain("taken");
	});

	test("the CSRF check: the cookie's token must come back, from this site", async () => {
		registerTodos();
		action("ping", () => ({ flash: "pong" }), { csrf: false });
		const { get } = await serve({ "todos.uwu": TODOS.replace("<page>", `<page><action ping="ping">`) });
		const { cookie, token } = await tokenOf(await get("/todos"));
		const post = (fields: Record<string, string>, headers: Record<string, string> = { cookie }) =>
			get("/todos", { method: "POST", body: form(fields), headers });
		expect((await post({ _action: "add", title: "a" })).status).toBe(403);
		expect((await post({ _action: "add", title: "a", _csrf: "x".repeat(32) })).status).toBe(403);
		expect((await post({ _action: "add", title: "a", _csrf: token }, {})).status).toBe(403);
		expect((await post({ _action: "add", title: "a", _csrf: token }, { cookie, "sec-fetch-site": "cross-site" })).status).toBe(403);
		expect((await post({ _action: "add", title: "a", _csrf: token }, { cookie, origin: "https://evil.test" })).status).toBe(403);
		expect(todos).toEqual([]);
		// The header works as well as the field (the runtime's click without a form).
		expect((await post({ _action: "add", title: "a" }, { cookie, "natsu-csrf": token, origin: "https://shop.test" })).status).toBe(303);
		// An action that opted out takes no token.
		expect((await post({ _action: "ping" }, {})).status).toBe(303);
		expect(todos.length).toBe(1);
	});

	test("only what the page names runs from its URL; a public action from any", async () => {
		registerTodos();
		let secret = 0;
		action("admin.wipe", () => void secret++);
		action("newsletter.join", () => ({ flash: "joined" }), { public: true, csrf: false });
		const { get } = await serve({ "todos.uwu": TODOS, "about.uwu": `<template>about</template>` });
		const { cookie, token } = await tokenOf(await get("/todos"));
		const wipe = await get("/todos", { method: "POST", body: form({ _action: "admin.wipe", _csrf: token }), headers: { cookie } });
		expect(wipe.status).toBe(404);
		expect(secret).toBe(0);
		expect((await get("/todos", { method: "POST", body: form({ _action: "nope", _csrf: token }), headers: { cookie } })).status).toBe(404);
		const joined = await get("/about", { method: "POST", body: form({ _action: "newsletter.join" }) });
		expect(joined.status).toBe(303);
		expect(joined.headers.get("location")).toBe("/about");
		expect(site!.routes.find((r) => r.path === "/todos")!.actions).toEqual([
			{ short: "add", name: "todos.add" },
			{ short: "todos.remove", name: "todos.remove" },
		]);
	});

	test("a page with no action answers a POST 405", async () => {
		const { get } = await serve({ "about.uwu": `<template>about</template>` });
		const answer = await get("/about", { method: "POST", body: form({ _action: "x" }) });
		expect(answer.status).toBe(405);
		expect(answer.headers.get("allow")).toBe("GET, HEAD");
	});

	test("auth: the <action> line's rule and the action's own, checked on the server", async () => {
		let ran = 0;
		action("posts.save", () => void ran++);
		action("posts.delete", () => void ran++, { auth: ({ viewer }) => (viewer as { admin?: boolean } | null)?.admin === true });
		guard("staff", ({ viewer }) => (viewer as { staff?: boolean } | null)?.staff === true);
		action("posts.pin", () => void ran++, { auth: "staff" });
		const { get } = await serve(
			{
				"_error.uwu": `<template><h1>{{error.status}}</h1></template>`,
				"posts.uwu": `<page><action save="posts.save" auth="viewer"><action pin="posts.pin"></page><template><form @submit="action:save"></form><form @submit="action:pin"></form><button @click="action:posts.delete">x</button></template>`,
			},
			{ viewer: (ctx) => (ctx.headers.get("x-user") ? JSON.parse(ctx.headers.get("x-user")!) : null) },
		);
		const { cookie, token } = await tokenOf(await get("/posts"));
		const post = (name: string, user?: object) =>
			get("/posts", { method: "POST", body: form({ _action: name, _csrf: token }), headers: { cookie, ...(user ? { "x-user": JSON.stringify(user) } : {}) } });
		const signedOut = await post("save");
		expect(signedOut.status).toBe(401);
		expect(await signedOut.text()).toBe("<h1>401</h1>");
		expect((await post("save", { name: "ann" })).status).toBe(303);
		expect((await post("posts.delete", { name: "ann" })).status).toBe(403);
		expect((await post("posts.delete", { admin: true })).status).toBe(303);
		expect((await post("pin", { name: "ann" })).status).toBe(403);
		expect((await post("pin", { staff: true })).status).toBe(303);
		expect(ran).toBe(3);
	});

	test("a redirect goes where the action says, on this site only; bodies over the limit are refused unread", async () => {
		action("go", ({ input }) => ({ redirect: String(input.to) }), { csrf: false });
		const { get } = await serve({ "go.uwu": `<template><form @submit="action:go"></form></template>` }, { maxBody: 64 });
		const go = (to: string) => get("/go", { method: "POST", body: form({ _action: "go", to }) });
		expect((await go("/elsewhere?x=1")).headers.get("location")).toBe("/elsewhere?x=1");
		expect((await go("//evil.test/")).headers.get("location")).toBe("/go");
		expect((await go("https://evil.test/")).headers.get("location")).toBe("/go");
		expect((await go("x".repeat(100))).status).toBe(413);
	});

	test("what nothing runs fails at mount, naming the file and the line", async () => {
		write({ "a.uwu": `<template>\n<button @click="action:nope">x</button></template>` });
		await expect(mountPages({ dir })).rejects.toThrow(/pages\/a.uwu:2: action:nope is used, and nothing runs it/);
		rmSync(join(dir, "pages"), { recursive: true });
		write({ "b.uwu": `<page>\n<action go="missing.thing"></page><template>b</template>` });
		await expect(mountPages({ dir })).rejects.toThrow(/pages\/b.uwu:2: <action go> runs 'missing.thing', and no action/);
		rmSync(join(dir, "pages"), { recursive: true });
		action("x", () => {});
		write({ "c.uwu": `<page><action go="x" auth="admins"></page><template>c</template>` });
		await expect(mountPages({ dir })).rejects.toThrow(/no guard\("admins"/);
		expect(() => compilePageFile(`<page><action go></page><template>x</template>`, "d.uwu")).toThrow(PageCompileError);
		expect(() => compilePageFile(`<page><action go="x" go2="y"></page><template>x</template>`, "d.uwu")).toThrow(/names one action/);
	});
});

describe("actions with the runtime", () => {
	test("the post with the page's key: a 303 back is a visit, a refused form a part", async () => {
		registerTodos();
		const assets = new Assets({ outDir: join(dir, "out"), navigate: true });
		await assets.build();
		const { get } = await serve({ "_layout.uwu": LAYOUT, "todos.uwu": TODOS }, { assets }, (app) => app.use(assets.middleware()));
		const page = await get("/todos");
		const { cookie, token, html } = await tokenOf(page);
		const key = /<meta name="natsu" content="([^"]+)"/.exec(html)![1]!;
		const headers = { cookie, "natsu-nav": key, "natsu-action": "1" };

		const done = await get("/todos", { method: "POST", body: form({ _action: "add", _csrf: token, title: "eggs" }), headers });
		expect(done.status).toBe(204);
		expect(done.headers.get("natsu-location")).toBe("/todos");
		expect(cookieOf(done, "natsu_flash")).toBeTruthy();
		expect(todos.map((t) => t.title)).toEqual(["eggs"]);

		const refused = await get("/todos", { method: "POST", body: form({ _action: "add", _csrf: token, title: "" }), headers });
		expect(refused.status).toBe(422);
		expect(refused.headers.get("natsu-part")).toBe("1");
		const part = await refused.text();
		expect(part).toContain(`<b class="error">Give it a title</b>`);
		expect(part).toContain(`<main id="main" data-natsu-region>`);

		// Timing: an action and the visit that redraws the page, as the runtime makes them.
		const rounds = 50;
		const started = Bun.nanoseconds();
		for (let i = 0; i < rounds; i++) {
			const post = await get("/todos", { method: "POST", body: form({ _action: "add", _csrf: token, title: `t${i}` }), headers });
			await post.arrayBuffer();
			const redraw = await get(post.headers.get("natsu-location")!, { headers: { cookie, "natsu-nav": key } });
			expect(redraw.headers.get("natsu-part")).toBe("1");
			await redraw.arrayBuffer();
		}
		const ms = (Bun.nanoseconds() - started) / 1e6 / rounds;
		console.log(`[actions] action round trip (POST + part): ${ms.toFixed(2)} ms over ${rounds}, ${todos.length} todos`);
		expect(ms).toBeLessThan(100);
	});
});

describe("live data", () => {
	test("a page carries the signed tags of what it loaded; live: false and tags(args) are honoured", async () => {
		source("todos", () => [{ title: "a" }]);
		source("settings", () => ({ theme: "dark" }), { live: false });
		source("product", ({ args }) => ({ name: `P ${args.slug}` }), { tags: ({ args }) => [`product:${args.slug}`] });
		const { get } = await serve({
			"_layout.uwu": LAYOUT,
			"index.uwu": `<template>{{#each todos}}{{title}}{{/each}}{{settings.theme}}</template>`,
			"plain.uwu": `<template>{{settings.theme}}</template>`,
			"p/[slug].uwu": `<page><data product="product slug=params.slug"></page><template>{{product.name}}</template>`,
		});
		const meta = (html: string) => /<meta name="natsu-live" content="([^"]+)">/.exec(html)?.[1];
		const home = meta(await (await get("/")).text())!;
		expect(home.split("|")[0]).toBe("todos");
		expect(verifyTags(home)).toEqual(["todos"]);
		expect(meta(await (await get("/plain")).text())).toBeUndefined();
		expect(verifyTags(meta(await (await get("/p/shoe")).text()))).toEqual(["product", "product:shoe"]);
		// Tampered with: not ours.
		expect(verifyTags(home.replace("todos", "users"))).toBeNull();
		expect(verifyTags(signTags(["a b"]))).toBeNull();
	});

	test("an invalidation lets kept pages go; an action's touches invalidate", async () => {
		registerTodos();
		let loads = 0;
		source("count", () => ++loads, { tags: () => "counter" });
		const heard: string[][] = [];
		const stop = onInvalidate((tags) => heard.push([...tags]));
		try {
			const { get } = await serve({ "c.uwu": `<template>{{count}}</template>`, "todos.uwu": TODOS });
			expect(await (await get("/c")).text()).toBe("1");
			expect(await (await get("/c")).text()).toBe("1");
			invalidate("counter");
			expect(await (await get("/c")).text()).toBe("2");
			expect(await (await get("/c")).text()).toBe("2");
			invalidate("count");
			expect(await (await get("/c")).text()).toBe("3");

			const { cookie, token } = await tokenOf(await get("/todos"));
			await get("/todos", { method: "POST", body: form({ _action: "add", _csrf: token, title: "x" }), headers: { cookie } });
			expect(heard).toEqual([["counter"], ["count"], ["todos"]]);
		} finally {
			stop();
		}
	});

	test("a socket watches the tags a page listed and hears their invalidations; made-up tags are ignored", async () => {
		source("todos", () => [], { tags: () => ["list:1"] });
		const { get } = await serve({ "_layout.uwu": LAYOUT, "index.uwu": `<template>{{#each todos}}{{/each}}</template>` });
		const signed = /<meta name="natsu-live" content="([^"]+)">/.exec(await (await get("/")).text())![1]!.replace(/&#124;/g, "|");
		const ws = new WebSocket(`${running!.base.replace("http", "ws")}/_uwu/socket`);
		const frames: string[] = [];
		ws.onmessage = (e) => frames.push(String(e.data));
		await new Promise((resolve) => (ws.onopen = resolve));
		ws.send(JSON.stringify({ t: "watch", tags: "other|forged" }));
		ws.send(JSON.stringify({ t: "watch", tags: signed }));
		await Bun.sleep(30);
		invalidate(["other", "list:1"]);
		await Bun.sleep(30);
		expect(frames).toEqual([JSON.stringify({ t: "invalidate", tag: "list:1" })]);
		// A page without tags: the next watch clears the list.
		ws.send(JSON.stringify({ t: "watch", tags: "" }));
		await Bun.sleep(30);
		invalidate("todos");
		await Bun.sleep(30);
		expect(frames.length).toBe(1);
		ws.close();
	});
});

describe("partials", () => {
	test("a partial's reads are planned where it is included; its styles come along", async () => {
		const seen: Record<string, string[]> = {};
		source("products", ({ fields }) => ((seen.products = fields), [{ name: "Shoe", price: 3, secret: "x" }]));
		source("viewerName", ({ fields }) => ((seen.viewerName = fields), "ann"));
		const { get } = await serve({
			"_partials/card.uwu": `<template><b>{{name}}</b> {{> price}}</template><style>b { color: red }</style>`,
			"_partials/price.uwu": `<template><i>{{price}}</i></template>`,
			"_partials/hello.uwu": `<template>hi {{viewerName}}</template>`,
			"_layout.uwu": `<template><!doctype html><html><head>{{{page.head}}}</head><body>{{> hello}}{{> @child}}</body></html></template>`,
			"index.uwu": `<template>{{#each products}}{{> card}}{{/each}}</template>`,
		});
		const html = await (await get("/")).text();
		expect(html).toMatch(/hi ann<b data-uwu-c-[0-9a-f]+="">Shoe<\/b> <i>3<\/i>/);
		expect(html).toMatch(/<style>[^<]*b\[data-uwu-c-/);
		expect(seen.products).toEqual(["name", "price"]);
		expect(seen.viewerName).toEqual(["*"]);
		expect(site!.routes[0]!.data.map((d) => d.name)).toEqual(["products", "page", "viewerName"]);
	});

	test("another partials directory; a partial has no <page>; one that includes itself stops", async () => {
		source("label", () => "L");
		write({ "../components/tag.uwu": `<template>[{{label}}]{{#if false}}{{> tag}}{{/if}}</template>` });
		const { get } = await serve({ "index.uwu": `<template>{{> tag}}</template>` }, { partials: "components" });
		expect(site!.routes[0]!.data.map((d) => d.name)).toEqual(["label"]);
		expect(await (await get("/")).text()).toBe("[L]");
		rmSync(join(dir, "pages"), { recursive: true });
		write({ "index.uwu": `<template>x</template>`, "_partials/p.uwu": `<page><data a="b"></page><template>x</template>` });
		await expect(mountPages({ dir })).rejects.toThrow(/a partial has no <page> block/);
	});
});

describe("the 404 page", () => {
	test("a URL no route answers is drawn by _error.uwu in its layouts, with a 404", async () => {
		const { get } = await serve({
			"_layout.uwu": LAYOUT,
			"_error.uwu": `<template><h1>{{error.status}}</h1><p>{{error.message}}</p></template>`,
			"index.uwu": `<template>home</template>`,
		});
		const missing = await get("/no/such/page");
		expect(missing.status).toBe(404);
		expect(missing.headers.get("content-type")).toBe("text/html; charset=utf-8");
		const html = await missing.text();
		expect(html).toContain(`<main id="main" data-natsu-region><h1>404</h1><p>Not Found</p></main>`);
		expect(html).toContain(`<meta name="robots" content="noindex">`);
		expect(site!.notFound).toBeFunction();
	});

	test("without _error.uwu a 404 is the plain one", async () => {
		const { get } = await serve({ "index.uwu": `<template>home</template>` });
		const missing = await get("/nope");
		expect(missing.status).toBe(404);
		expect(await missing.text()).toBe("Not Found");
	});
});

describe("viewer in a layout", () => {
	test("pages are kept for signed-out visitors and drawn afresh for signed-in ones", async () => {
		let loads = 0;
		source("n", () => ++loads);
		const { get } = await serve(
			{ "_layout.uwu": `<template>{{#if viewer}}hi {{viewer}}|{{/if}}{{> @child}}</template>`, "index.uwu": `<template>{{n}}</template>` },
			{ viewer: (ctx) => ctx.headers.get("x-user") },
		);
		expect(await (await get("/")).text()).toBe("1");
		expect(await (await get("/")).text()).toBe("1");
		expect(await (await get("/", { headers: { "x-user": "ann" } })).text()).toBe("hi ann|2");
		expect(await (await get("/", { headers: { "x-user": "ann" } })).text()).toBe("hi ann|3");
		expect(await (await get("/")).text()).toBe("1");
	});
});

describe("the public surface", () => {
	test("index.ts exports actions and live data", () => {
		expect(natsu.action).toBe(action);
		expect(natsu.guard).toBe(guard);
		expect(natsu.Invalid).toBe(Invalid);
		expect(natsu.invalidate).toBe(invalidate);
		expect(natsu.onInvalidate).toBe(onInvalidate);
	});
});
