import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setConfig } from "../src/config.ts";
import { checkTags, invalidate, signTags, verifyTags } from "../src/invalidate.ts";
import { clearActions } from "../src/pages/actions.ts";
import { clearSources, source } from "../src/pages/data.ts";
import { type PageSite, mountPages } from "../src/pages/mount.ts";
import { Application } from "../src/server.ts";
import { type RunningApp, reset, startApp } from "./helpers.ts";

let dir: string;
let running: RunningApp | undefined;
let site: PageSite | undefined;

beforeEach(() => {
	reset({ General: { logFormat: "", logLevel: "silent", url: "https://shop.test" } });
	clearSources();
	clearActions();
	dir = mkdtempSync(join(tmpdir(), "natsu-livetags-"));
});

afterEach(async () => {
	setSystemTime();
	site?.close();
	site = undefined;
	await running?.stop();
	running = undefined;
	rmSync(dir, { recursive: true, force: true });
});

async function serve(files: Record<string, string>) {
	mkdirSync(join(dir, "pages"), { recursive: true });
	for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, "pages", file), text);
	const app = new Application();
	site = await mountPages({ dir, app });
	running = await startApp(app);
	return { app, get: (path: string, init?: RequestInit) => running!.fetch(path, { redirect: "manual", ...init }) };
}

async function frames(cookie: string | undefined, say: (ws: WebSocket) => void, then?: () => void): Promise<string[]> {
	const ws = new WebSocket(`${running!.base.replace("http", "ws")}/_uwu/socket`, { headers: cookie ? { cookie } : {} } as never);
	const seen: string[] = [];
	ws.onmessage = (e) => seen.push(String(e.data));
	await new Promise((resolve) => (ws.onopen = resolve));
	say(ws);
	await Bun.sleep(30);
	then?.();
	await Bun.sleep(30);
	ws.close();
	return seen;
}

describe("signed live tags", () => {
	test("a list expires after the configured lifetime", () => {
		setConfig({ General: { liveTagTtl: 60 } });
		const signed = signTags(["a:1"]);
		expect(verifyTags(signed)).toEqual(["a:1"]);
		setSystemTime(new Date(Date.now() + 59_000));
		expect(verifyTags(signed)).toEqual(["a:1"]);
		setSystemTime(new Date(Date.now() + 5_000));
		expect(verifyTags(signed)).toBeNull();
		expect(checkTags(signed)?.expired).toBe(true);
	});

	test("the expiry cannot be extended or the scope flag flipped", () => {
		setConfig({ General: { liveTagTtl: 60 } });
		const signed = signTags(["a:1"], "sess");
		const [text, rest] = signed.split("|") as [string, string];
		const [kind, stamp, given] = rest.split(".") as [string, string, string];
		const later = (parseInt(stamp, 36) + 99999).toString(36);
		expect(verifyTags(`${text}|${kind}.${later}.${given}`, "sess")).toBeNull();
		expect(verifyTags(`${text}|p.${stamp}.${given}`, "sess")).toBeNull();
		expect(verifyTags(`${text}|p.${stamp}.${given}`)).toBeNull();
	});

	test("a session-bound list verifies only for its own session", () => {
		const signed = signTags(["viewer:1:2"], "sess-a");
		expect(verifyTags(signed, "sess-a")).toEqual(["viewer:1:2"]);
		expect(verifyTags(signed, "sess-b")).toBeNull();
		expect(verifyTags(signed, "")).toBeNull();
		expect(verifyTags(signed)).toBeNull();
	});

	test("a public list verifies for any session", () => {
		const signed = signTags(["todos"]);
		expect(verifyTags(signed, "sess-a")).toEqual(["todos"]);
		expect(verifyTags(signed, "")).toEqual(["todos"]);
	});

	test("malformed signatures are refused", () => {
		const signed = signTags(["a:1"]);
		for (const bad of ["a:1|", "a:1|p", "a:1|p.1", "a:1|x.1.2", `${signed}.x`, signed.replace("|p.", "|P."), "|p.1.2", 5, null]) {
			expect(verifyTags(bad)).toBeNull();
		}
	});

	test("a page drawn with a session carries tags bound to it; a leaked list is useless to another socket", async () => {
		source("room", () => ({ n: 1 }), { tags: () => ["viewer:g:u1"] });
		const { app, get } = await serve({
			"_layout.uwu": `<template><!doctype html><html><head>{{{page.head}}}</head><body>{{> @child}}</body></html></template>`,
			"index.uwu": `<page><data room="room"></page><template>{{room.n}}</template>`,
		});
		const mine = app.sessions!.create();
		mine.Set("k", "v");
		const other = app.sessions!.create();
		other.Set("k", "v");
		const html = await (await get("/", { headers: { cookie: `${app.sessions!.cookieName}=${mine.id}` } })).text();
		const signed = /<meta name="natsu-live" content="([^"]+)">/.exec(html)![1]!.replaceAll("&#124;", "|");
		expect(signed.split("|")[1]!.startsWith("s.")).toBe(true);

		const own = await frames(`${app.sessions!.cookieName}=${mine.id}`, (ws) => ws.send(JSON.stringify({ t: "watch", tags: signed })), () => invalidate("viewer:g:u1"));
		expect(own).toEqual([JSON.stringify({ t: "invalidate", tag: "viewer:g:u1" })]);

		const stolen = await frames(`${app.sessions!.cookieName}=${other.id}`, (ws) => ws.send(JSON.stringify({ t: "watch", tags: signed })), () => invalidate("viewer:g:u1"));
		expect(stolen).toEqual([]);

		const anonymous = await frames(undefined, (ws) => ws.send(JSON.stringify({ t: "watch", tags: signed })), () => invalidate("viewer:g:u1"));
		expect(anonymous).toEqual([]);
	});

	test("a socket holding an expired list is told it is stale and subscribes to nothing", async () => {
		await serve({ "index.uwu": `<template>hi</template>` });
		setConfig({ General: { liveTagTtl: 1 } });
		const signed = signTags(["old:1"]);
		setSystemTime(new Date(Date.now() + 5_000));
		const seen = await frames(undefined, (ws) => ws.send(JSON.stringify({ t: "watch", tags: signed })), () => invalidate("old:1"));
		expect(seen).toEqual([JSON.stringify({ t: "stale" })]);
	});
});
