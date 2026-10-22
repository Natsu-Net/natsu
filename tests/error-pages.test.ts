import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { clearActions } from "../src/pages/actions.ts";
import { clearSources, source } from "../src/pages/data.ts";
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
	dir = mkdtempSync(join(tmpdir(), "natsu-errors-"));
});

afterEach(async () => {
	site?.close();
	site = undefined;
	await running?.stop();
	running = undefined;
	rmSync(dir, { recursive: true, force: true });
});

async function serve(files: Record<string, string>, options: Omit<PagesOptions, "dir"> = {}) {
	for (const [file, text] of Object.entries(files)) {
		const full = join(dir, "pages", file);
		mkdirSync(dirname(full), { recursive: true });
		writeFileSync(full, text);
	}
	const app = new Application();
	site = await mountPages({ dir, app, ...options });
	running = await startApp(app);
	return (path: string) => running!.fetch(path);
}

describe("what an error page tells the visitor", () => {
	test("a service that failed is a Bad Gateway that names neither the service nor its path", async () => {
		const stub = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch: (request) => new Response("boom", { status: new URL(request.url).pathname.startsWith("/locked") ? 403 : 500 }),
		});
		try {
			const get = await serve(
				{
					"_error.uwu": `<template>{{error.status}}: {{error.message}}</template>`,
					"broken/[id].uwu": `<page><data x="internal-billing:GET /v2/secret-route/{{params.id}}" required></data></page><template>{{x}}</template>`,
					"locked/[id].uwu": `<page><data x="internal-billing:GET /locked/{{params.id}}" required></data></page><template>{{x}}</template>`,
				},
				{ services: { "internal-billing": { base: `http://127.0.0.1:${stub.port}` } } },
			);
			const broken = await get("/broken/7");
			const text = await broken.text();
			expect(broken.status).toBe(502);
			expect(text).toBe("502: Bad Gateway");
			expect(text).not.toContain("billing");
			expect(text).not.toContain("secret-route");
			const locked = await get("/locked/7");
			expect(locked.status).toBe(403);
			expect(await locked.text()).toBe("403: Forbidden");
		} finally {
			stub.stop(true);
		}
	});

	test("a source that throws shows no stack and no message unless development is on", async () => {
		source("boom", () => {
			throw new Error("db password is hunter2 at /srv/app/db.ts:12");
		});
		const get = await serve({
			"_error.uwu": `<template>{{error.status}}: {{error.message}}</template>`,
			"boom.uwu": `<template>{{boom}}</template>`,
		});
		const answer = await get("/boom");
		expect(answer.status).toBe(500);
		expect(await answer.text()).toBe("500: Internal Server Error");
	});

	test("without an error page, a 500 body is the bare status text", async () => {
		source("boom", () => {
			throw new Error("secret detail");
		});
		const get = await serve({ "boom.uwu": `<template>{{boom}}</template>` });
		const answer = await get("/boom");
		expect(answer.status).toBe(500);
		expect(await answer.text()).toBe("Internal Server Error");
	});
});
