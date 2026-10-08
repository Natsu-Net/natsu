/**
 * What actions and live data cost: the runtime's size, an action's round
 * trip, and an invalidation's way to a watching socket.
 *
 * Over a real socket on 127.0.0.1, with Assets and page switching on, a
 * page with a list (a live source), a form and a button:
 *
 * - **post, no script**: the form's POST, answered 303 (the browser then
 *   loads the page: not counted);
 * - **post + part**: what the runtime does: the POST with the page's key
 *   (answered 204 with Natsu-Location) and the visit that redraws the
 *   page as a part;
 * - **refused + part**: a refused form, drawn again as a part (422);
 * - **invalidate -> frame**: `invalidate(tag)` until a socket that
 *   watches the tag has the frame.
 *
 *   bun run bench/actions.ts [--requests 2000]
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import { Assets } from "../src/assets.ts";
import { setConfig } from "../src/config.ts";
import { invalidate } from "../src/invalidate.ts";
import { setColorEnabled, setLogSink } from "../src/logger.ts";
import { Invalid, action } from "../src/pages/actions.ts";
import { source } from "../src/pages/data.ts";
import { mountPages } from "../src/pages/mount.ts";
import { Application } from "../src/server.ts";

setColorEnabled(false);
setLogSink(() => {});
setConfig({ General: { logFormat: "", logLevel: "silent", url: "http://127.0.0.1" }, Session: { driver: "memory", sweepInterval: 0 }, Static: { enabled: false } });

const at = process.argv.indexOf("--requests");
const REQUESTS = at > 0 ? Number(process.argv[at + 1]) : 2000;

// --- the runtime ---------------------------------------------------------------

const built = await Bun.build({
	entrypoints: [new URL("../src/client/navigate.ts", import.meta.url).pathname],
	target: "browser",
	format: "iife",
	minify: true,
	define: { NATSU_DEV: "false" },
});
const code = await built.outputs[0]!.text();
const br = brotliCompressSync(Buffer.from(code), { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length;
console.log(`runtime (navigation, actions, live data): ${code.length} B minified, ${gzipSync(Buffer.from(code), { level: 9 }).length} B gzip, ${br} B brotli`);

// --- the app -----------------------------------------------------------------------

const dir = mkdtempSync(join(tmpdir(), "natsu-bench-actions-"));
mkdirSync(join(dir, "pages"), { recursive: true });
writeFileSync(
	join(dir, "pages", "_layout.uwu"),
	`<template><!doctype html><html><head><meta charset="utf-8">{{{page.head}}}</head><body><header>site</header><main id="main" data-natsu-region>{{> @child}}</main></body></html></template>`,
);
writeFileSync(
	join(dir, "pages", "todos.uwu"),
	`<page><action add="todos.add"></page><template><h1>Todos</h1>{{#if flash}}<p>{{flash.message}}</p>{{/if}}
<ul>{{#each todos}}<li>{{title}} <button @click="action:todos.remove" data-id="{{id}}">x</button></li>{{/each}}</ul>
<form @submit="action:add"><input name="title" value="{{form.values.title}}">{{form.errors.title}}</form></template>`,
);
let todos: { id: number; title: string }[] = [];
let id = 0;
source("todos", () => todos);
action(
	"todos.add",
	({ input }) => {
		const title = String(input.title ?? "");
		if (!title) throw new Invalid({ title: "Give it a title" });
		todos = [...todos, { id: ++id, title }].slice(-20);
		return { flash: "Added" };
	},
	{ touches: ["todos"] },
);
action("todos.remove", ({ input }) => void (todos = todos.filter((t) => String(t.id) !== input.id)), { touches: ["todos"] });

const assets = new Assets({ outDir: join(dir, "out"), navigate: true });
await assets.build();
const app = new Application();
app.use(assets.middleware());
await mountPages({ dir, app, assets });
const server = await app.start({ port: 0, hostname: "127.0.0.1", quiet: true });
const base = server.url.origin;

const first = await fetch(`${base}/todos`);
const cookie = first.headers.getSetCookie().find((c) => c.startsWith("natsu_csrf="))!.split(";")[0]!;
const html = await first.text();
const token = /name="_csrf" value="([^"]+)"/.exec(html)![1]!;
const key = /<meta name="natsu" content="([^"]+)"/.exec(html)![1]!;
const live = /<meta name="natsu-live" content="([^"]+)"/.exec(html)![1]!;

const post = (fields: Record<string, string>, headers: Record<string, string> = {}) =>
	fetch(`${base}/todos`, { method: "POST", redirect: "manual", body: new URLSearchParams({ _csrf: token, ...fields }), headers: { cookie, ...headers } });

const measure = async (name: string, run: (i: number) => Promise<void>): Promise<void> => {
	for (let i = 0; i < 100; i++) await run(i);
	const times: number[] = [];
	for (let i = 0; i < REQUESTS; i++) {
		const started = Bun.nanoseconds();
		await run(i);
		times.push((Bun.nanoseconds() - started) / 1e6);
	}
	times.sort((a, b) => a - b);
	const pick = (q: number) => times[Math.min(times.length - 1, Math.floor(times.length * q))]!.toFixed(3);
	console.log(`${name.padEnd(22)} p50 ${pick(0.5)} ms   p90 ${pick(0.9)} ms   p99 ${pick(0.99)} ms`);
};

await measure("post, no script", async (i) => {
	const answer = await post({ _action: "add", title: `t${i}` });
	if (answer.status !== 303) throw new Error(`answered ${answer.status}`);
	await answer.arrayBuffer();
});
await measure("post + part", async (i) => {
	const answer = await post({ _action: "add", title: `t${i}` }, { "natsu-nav": key, "natsu-action": "1" });
	if (answer.status !== 204) throw new Error(`answered ${answer.status}`);
	const part = await fetch(base + answer.headers.get("natsu-location"), { headers: { cookie, "natsu-nav": key } });
	if (part.headers.get("natsu-part") !== "1") throw new Error("not a part");
	await part.arrayBuffer();
});
await measure("refused + part", async () => {
	const answer = await post({ _action: "add", title: "" }, { "natsu-nav": key, "natsu-action": "1" });
	if (answer.status !== 422 || answer.headers.get("natsu-part") !== "1") throw new Error(`answered ${answer.status}`);
	await answer.arrayBuffer();
});

const ws = new WebSocket(`${base.replace("http", "ws")}/_uwu/socket`);
await new Promise((resolve) => (ws.onopen = resolve));
ws.send(JSON.stringify({ t: "watch", tags: live.replace(/&#124;/g, "|") }));
await Bun.sleep(20);
let heard: (() => void) | undefined;
ws.onmessage = () => heard?.();
await measure("invalidate -> frame", () => {
	const got = new Promise<void>((resolve) => (heard = resolve));
	invalidate("todos");
	return got;
});

ws.close();
await app.close(true);
rmSync(dir, { recursive: true, force: true });
