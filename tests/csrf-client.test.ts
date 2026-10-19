import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Window } from "happy-dom";
import { Assets } from "../src/assets.ts";
import { action, clearActions } from "../src/pages/actions.ts";
import { clearSources, source } from "../src/pages/data.ts";
import { type PageSite, mountPages } from "../src/pages/mount.ts";
import { Application } from "../src/server.ts";
import { type RunningApp, reset, startApp } from "./helpers.ts";

const ORIGIN = "https://shop.test";
const ENTRY = new URL("../src/client/navigate.ts", import.meta.url).pathname;

const LAYOUT = `<template><!doctype html><html><head>{{{page.head}}}</head><body><main id="main" data-natsu-region>{{> @child}}</main></body></html></template>`;
const PAGE = `<page><action add="todos.add"></page>
<template>
<h1>Todos</h1>
<ul>{{#each todos}}<li>{{title}}</li>{{/each}}</ul>
<form id="f" @submit="action:add"><input name="title" value="milk"><button id="go">Add</button></form>
<button id="mark" @click="action:todos.mark" data-id="9">mark</button>
</template>`;

let runtime = "";
beforeAll(async () => {
	const out = await Bun.build({ entrypoints: [ENTRY], format: "iife", minify: true, define: { NATSU_DEV: "false" } });
	if (!out.success) throw new AggregateError(out.logs, "navigate.ts did not build");
	runtime = await out.outputs[0]!.text();
});

let dir: string;
let running: RunningApp | undefined;
let site: PageSite | undefined;
let window: any;
let added: string[];
let marked: string[];
const posts: { masked: boolean; field: string }[] = [];

beforeEach(() => {
	reset({ General: { logFormat: "", logLevel: "silent", url: ORIGIN } });
	clearSources();
	clearActions();
	added = [];
	marked = [];
	posts.length = 0;
	dir = mkdtempSync(join(tmpdir(), "natsu-csrf-client-"));
});

afterEach(async () => {
	await window?.happyDOM.close();
	site?.close();
	site = undefined;
	await running?.stop();
	running = undefined;
	rmSync(dir, { recursive: true, force: true });
});

async function boot(): Promise<void> {
	source("todos", () => added.map((title) => ({ title })));
	action("todos.add", ({ input }) => {
		added.push(String(input.title));
		return { flash: "ok" };
	});
	action("todos.mark", ({ input }) => {
		marked.push(String(input.id));
	});
	mkdirSync(join(dir, "pages"), { recursive: true });
	writeFileSync(join(dir, "pages", "_layout.uwu"), LAYOUT);
	writeFileSync(join(dir, "pages", "todos.uwu"), PAGE);
	const assets = new Assets({ outDir: join(dir, "out"), navigate: true });
	await assets.build();
	const app = new Application();
	app.use(assets.middleware());
	site = await mountPages({ dir, app, assets });
	running = await startApp(app);

	const first = await running.fetch("/todos", { redirect: "manual" });
	const jar = new Map<string, string>();
	const absorb = (response: Response) => {
		for (const line of response.headers.getSetCookie()) {
			const [pair] = line.split(";");
			const at = pair!.indexOf("=");
			jar.set(pair!.slice(0, at), pair!.slice(at + 1));
		}
	};
	absorb(first);
	const html = (await first.text()).replace(/<script\b[^>]*><\/script>/g, (tag) => (tag.includes("natsu.js") ? "" : tag));

	window = new Window({
		url: `${ORIGIN}/todos`,
		settings: {
			disableJavaScriptFileLoading: true,
			disableCSSFileLoading: true,
			handleDisabledFileLoadingAsSuccess: true,
			navigation: { disableMainFrameNavigation: true },
		},
	} as never);
	for (const name of ["Map", "Set", "WeakMap", "Promise", "Date", "JSON", "Array", "Object", "Number", "String", "RegExp", "Error", "TypeError", "Math", "decodeURIComponent", "reportError"])
		if (window[name] === undefined) window[name] = (globalThis as any)[name];
	window.WebSocket = class {
		addEventListener() {}
		removeEventListener() {}
		send() {}
		close() {}
	};
	window.document.write(html);
	for (const [name, value] of jar) window.document.cookie = `${name}=${value}`;
	Object.defineProperty(window.location, "assign", { value: () => {} });
	Object.defineProperty(window.location, "reload", { value: () => {} });

	window.fetch = async (input: string, init: { method?: string; headers?: Record<string, string>; body?: unknown } = {}) => {
		const url = new URL(String(input), window.location.href);
		const headers: Record<string, string> = {
			...init.headers,
			cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; "),
			origin: ORIGIN,
			"sec-fetch-site": "same-origin",
		};
		if (init.method === "POST") {
			const body = init.body instanceof URLSearchParams ? init.body : new URLSearchParams(String(init.body));
			const sent = body.get("_csrf") ?? "";
			posts.push({ masked: sent.length >= 65, field: sent });
		}
		const response = await running!.fetch(url.pathname + url.search, {
			method: init.method ?? "GET",
			headers,
			body: init.body as BodyInit | undefined,
			redirect: "manual",
		});
		absorb(response);
		return response;
	};

	const tag = window.document.querySelector('meta[name="natsu"]');
	expect(tag).not.toBeNull();
	const boot = window.document.createElement("script");
	Object.defineProperty(window.document, "currentScript", { get: () => boot, configurable: true });
	new Function("window", `with (window) {${runtime}}`)(window);
	window.document.dispatchEvent(new window.Event("DOMContentLoaded"));
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

describe("masked CSRF tokens through the shipped client runtime", () => {
	test("a form submit carries the page's masked token and the action runs", async () => {
		await boot();
		const hidden = window.document.querySelector('#f input[name="_csrf"]');
		expect(hidden.value.length).toBeGreaterThanOrEqual(65);

		const submit = new window.SubmitEvent("submit", { bubbles: true, cancelable: true, submitter: window.document.querySelector("#go") });
		window.document.querySelector("#f").dispatchEvent(submit);
		await settle();

		expect(submit.defaultPrevented).toBe(true);
		expect(posts).toHaveLength(1);
		expect(posts[0]!.masked).toBe(true);
		expect(posts[0]!.field).toBe(hidden.value);
		expect(added).toEqual(["milk"]);
	});

	test("a click action sends the raw cookie token and is still accepted", async () => {
		await boot();
		const click = new window.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
		window.document.querySelector("#mark").dispatchEvent(click);
		await settle();

		expect(posts).toHaveLength(1);
		expect(posts[0]!.masked).toBe(false);
		expect(posts[0]!.field).toBe(window.document.cookie.match(/natsu_csrf=([^;]*)/)![1]);
		expect(marked).toEqual(["9"]);
	});

	test("a post whose token is wrong is refused", async () => {
		await boot();
		window.document.querySelector('#f input[name="_csrf"]').value = "x".repeat(86);
		const submit = new window.SubmitEvent("submit", { bubbles: true, cancelable: true, submitter: window.document.querySelector("#go") });
		window.document.querySelector("#f").dispatchEvent(submit);
		await settle();
		expect(added).toEqual([]);
	});
});
