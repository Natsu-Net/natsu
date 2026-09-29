/**
 * Response compression.
 *
 * What has to hold: a client that asks for brotli gets brotli that decodes to
 * the same bytes, a client that asks for nothing gets the body untouched, and
 * nothing that is already compressed, too small, or a byte range is touched.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { compress, negotiate } from "../src/compress.ts";
import { Application } from "../src/server.ts";
import { Router } from "../src/router.ts";
import { reset, startApp, type RunningApp } from "./helpers.ts";

const PAGE = `<!doctype html><html><body>${"<p class=\"card\">hello world</p>".repeat(200)}</body></html>`;

let running: RunningApp | undefined;
let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "natsu-compress-"));
	writeFileSync(join(root, "site.css"), ".card{color:red}\n".repeat(400));
	writeFileSync(join(root, "tiny.css"), ".a{}");
	writeFileSync(join(root, "logo.png"), new Uint8Array(4096));
	reset({ Static: { enabled: true, root } });
	const router = new Router();
	router.get("/page", (ctx) => {
		ctx.response.body = PAGE;
	});
	router.get("/json", (ctx) => {
		ctx.response.body = { rows: Array.from({ length: 200 }, (_, i) => ({ id: i, title: "same title" })) };
	});
	router.get("/chunk", (ctx) => {
		ctx.response.headers.set("content-type", "text/css; charset=utf-8");
		ctx.response.headers.set("cache-control", "public, max-age=31536000, immutable");
		ctx.response.body = ".x{color:blue}\n".repeat(300);
	});
});

afterEach(async () => {
	await running?.stop();
	running = undefined;
	rmSync(root, { recursive: true, force: true });
});

async function start(): Promise<RunningApp> {
	const app = new Application();
	app.use(compress());
	running = await startApp(app);
	return running;
}

/** Bun's fetch decodes by default; these tests need the wire bytes. */
function raw(path: string, encoding?: string, extra: Record<string, string> = {}): Promise<Response> {
	const headers: Record<string, string> = { ...extra };
	headers["accept-encoding"] = encoding ?? "identity";
	return fetch(running!.base + path, { headers, decompress: false } as RequestInit);
}

describe("negotiate", () => {
	test("brotli first, then gzip, and q=0 is a refusal", () => {
		expect(negotiate("gzip, deflate, br")).toBe("br");
		expect(negotiate("gzip")).toBe("gzip");
		expect(negotiate("br;q=0, gzip")).toBe("gzip");
		expect(negotiate("identity")).toBeUndefined();
		expect(negotiate(null)).toBeUndefined();
	});
});

describe("compress", () => {
	test("a page goes out as brotli that decodes to the same page", async () => {
		await start();
		const res = await raw("/page", "br");
		expect(res.headers.get("content-encoding")).toBe("br");
		expect(res.headers.get("vary")).toContain("Accept-Encoding");
		expect(res.headers.get("content-type")).toContain("text/html");
		const bytes = new Uint8Array(await res.arrayBuffer());
		expect(bytes.length).toBeLessThan(PAGE.length / 10);
		expect(brotliDecompressSync(bytes).toString()).toBe(PAGE);
	});

	test("gzip for a client that only takes gzip", async () => {
		await start();
		const res = await raw("/page", "gzip");
		expect(res.headers.get("content-encoding")).toBe("gzip");
		expect(gunzipSync(new Uint8Array(await res.arrayBuffer())).toString()).toBe(PAGE);
	});

	test("a client that asks for nothing gets the body as it was", async () => {
		await start();
		const res = await raw("/page");
		expect(res.headers.get("content-encoding")).toBeNull();
		expect(await res.text()).toBe(PAGE);
	});

	test("JSON bodies are compressed and keep their type", async () => {
		await start();
		const res = await raw("/json", "br");
		expect(res.headers.get("content-encoding")).toBe("br");
		expect(res.headers.get("content-type")).toContain("application/json");
		expect(JSON.parse(brotliDecompressSync(new Uint8Array(await res.arrayBuffer())).toString()).rows).toHaveLength(200);
	});

	test("static text files are compressed, and a second request gets the same bytes", async () => {
		await start();
		const first = new Uint8Array(await (await raw("/site.css", "br")).arrayBuffer());
		const second = await raw("/site.css", "br");
		expect(second.headers.get("content-encoding")).toBe("br");
		expect(second.headers.get("accept-ranges")).toBeNull();
		expect(new Uint8Array(await second.arrayBuffer())).toEqual(first);
		expect(brotliDecompressSync(first).toString()).toBe(".card{color:red}\n".repeat(400));
	});

	test("an immutable body is compressed and decodes back", async () => {
		await start();
		const res = await raw("/chunk", "br");
		expect(res.headers.get("content-encoding")).toBe("br");
		expect(brotliDecompressSync(new Uint8Array(await res.arrayBuffer())).toString()).toBe(".x{color:blue}\n".repeat(300));
	});

	test("images, tiny bodies, byte ranges and HEAD are left alone", async () => {
		await start();
		expect((await raw("/logo.png", "br")).headers.get("content-encoding")).toBeNull();
		expect((await raw("/tiny.css", "br")).headers.get("content-encoding")).toBeNull();
		const ranged = await raw("/site.css", "br", { range: "bytes=0-9" });
		expect(ranged.status).toBe(206);
		expect(ranged.headers.get("content-encoding")).toBeNull();
		const head = await fetch(running!.base + "/page", { method: "HEAD", headers: { "accept-encoding": "br" } });
		expect(head.headers.get("content-encoding")).toBeNull();
	});
});
