import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { Context } from "../src/context.ts";
import { StaticFiles, parseRange } from "../src/static.ts";
import { Application } from "../src/server.ts";
import { Router } from "../src/router.ts";
import { rawRequest, reset, startApp, tempDir, type RunningApp } from "./helpers.ts";

const dir = tempDir("natsu-static-");
const root = join(dir.path, "public");

beforeAll(() => {
	mkdirSync(join(root, "sub"), { recursive: true });
	mkdirSync(join(root, "deep", "nested"), { recursive: true });
	writeFileSync(join(root, "ok.txt"), "hello static");
	writeFileSync(join(root, "index.html"), "<h1>root index</h1>");
	writeFileSync(join(root, "sub", "index.html"), "<h1>sub index</h1>");
	writeFileSync(join(root, "logo.svg"), "<svg/>");
	writeFileSync(join(root, ".env"), "API_KEY=hunter2");
	writeFileSync(join(root, "deep", "nested", "file.txt"), "deep file");
	writeFileSync(join(dir.path, "secret.txt"), "TOP SECRET");
	// A symlink that leaves the document root — the case a string filter cannot see.
	symlinkSync(join(dir.path, "secret.txt"), join(root, "escape-link.txt"));
	symlinkSync(join(root, "ok.txt"), join(root, "inside-link.txt"));
});

afterAll(() => {
	dir.cleanup();
});

function statics(options: Partial<ConstructorParameters<typeof StaticFiles>[0]> = {}): StaticFiles {
	return new StaticFiles({ root, index: "index.html", ...options });
}

function ctxFor(path: string, init?: RequestInit): Context {
	return new Context(new Request(`http://static.test${path}`, init));
}

describe("path resolution", () => {
	const files = statics();

	test("an ordinary path resolves inside the root", () => {
		expect(files.resolvePath("/ok.txt")).toEqual({ path: join(root, "ok.txt") });
	});

	test.each([
		["plain traversal", "/../secret.txt"],
		["nested traversal", "/deep/../../secret.txt"],
		["encoded slash traversal", "/..%2fsecret.txt"],
		["double-encoded dots", "/%2e%2e/secret.txt"],
		["uppercase encoded dots", "/%2E%2E/secret.txt"],
		["mixed encoding", "/a/..%2F..%2Fsecret.txt"],
		["deep climb", "/deep/nested/../../../secret.txt"],
		["trailing climb", "/deep/.."],
		["absolute-looking", "//../secret.txt"],
		["backslash climb", "/..\\..\\secret.txt"],
	])("refuses %s", (_name, path) => {
		const outcome = files.resolvePath(path);
		// Either it is refused outright, or it resolved to something that is
		// still inside the root — never to the file outside it.
		if ("path" in outcome) {
			expect(outcome.path.startsWith(root)).toBe(true);
			expect(outcome.path).not.toBe(join(dir.path, "secret.txt"));
		} else {
			expect(["escape", "dotfile", "malformed"]).toContain(outcome.rejected);
		}
	});

	test("the v1 filter would have let one of these through", () => {
		// `.replace(/\/\.\.\//g, "/")` leaves `..%2f` untouched, which decodes
		// to `../` at the syscall. This is the regression test for that.
		const naive = `${root}/..%2fsecret.txt`.replace(/\/\.\.\//g, "/");
		expect(decodeURIComponent(naive)).toBe(`${root}/../secret.txt`);
		expect(files.resolvePath("/..%2fsecret.txt")).toEqual({ rejected: "escape" });
	});

	test("refuses a NUL byte", () => {
		expect(files.resolvePath("/ok.txt%00.png")).toEqual({ rejected: "malformed" });
	});

	test("refuses malformed percent-encoding", () => {
		expect(files.resolvePath("/%E0%A4%A")).toEqual({ rejected: "malformed" });
	});

	test("refuses a dotfile by default, allows it when asked", () => {
		expect(files.resolvePath("/.env")).toEqual({ rejected: "dotfile" });
		expect(statics({ dotfiles: true }).resolvePath("/.env")).toEqual({ path: join(root, ".env") });
	});

	test("refuses a dot-prefixed directory anywhere in the path", () => {
		expect(files.resolvePath("/.git/config")).toEqual({ rejected: "dotfile" });
		expect(files.resolvePath("/sub/.hidden/x")).toEqual({ rejected: "dotfile" });
	});

	test("refuses a symlink that leaves the root", () => {
		expect(files.resolvePath("/escape-link.txt")).toEqual({ rejected: "escape" });
	});

	test("allows a symlink that stays inside the root", () => {
		expect(files.resolvePath("/inside-link.txt")).toEqual({ path: join(root, "inside-link.txt") });
	});

	test("followSymlinks: true opts back into the risk", () => {
		expect(statics({ followSymlinks: true }).resolvePath("/escape-link.txt")).toEqual({
			path: join(root, "escape-link.txt"),
		});
	});

	test("the root itself resolves to the root", () => {
		expect(files.resolvePath("/")).toEqual({ path: root });
	});
});

describe("serving", () => {
	test("serves a file with its type and validators", async () => {
		const ctx = ctxFor("/ok.txt");
		expect(await statics({ maxAge: 60 }).serve(ctx)).toBe(true);
		const response = ctx.toResponse();
		expect(response.status).toBe(200);
		expect(await response.text()).toBe("hello static");
		expect(response.headers.get("content-type")).toBe("text/plain;charset=utf-8");
		expect(response.headers.get("etag")).toMatch(/^W\/"[0-9a-f]+-[0-9a-f]+"$/);
		expect(response.headers.get("last-modified")).toBeTruthy();
		expect(response.headers.get("cache-control")).toBe("public, max-age=60");
		expect(response.headers.get("accept-ranges")).toBe("bytes");
	});

	test("svg gets the right type, which Deno's table got wrong", async () => {
		const ctx = ctxFor("/logo.svg");
		await statics().serve(ctx);
		expect(ctx.toResponse().headers.get("content-type")).toBe("image/svg+xml");
	});

	test("a directory serves its index file", async () => {
		const ctx = ctxFor("/sub/");
		expect(await statics().serve(ctx)).toBe(true);
		expect(await ctx.toResponse().text()).toBe("<h1>sub index</h1>");
	});

	test("a directory with no index is not served", async () => {
		const ctx = ctxFor("/deep");
		expect(await statics({ index: "" }).serve(ctx)).toBe(false);
	});

	test("a missing file is not handled, so the app can 404 it", async () => {
		expect(await statics().serve(ctxFor("/nope.txt"))).toBe(false);
	});

	test("a refused path is reported as absent, not as forbidden", async () => {
		// A 403 would confirm the file exists outside the root.
		expect(await statics().serve(ctxFor("/..%2fsecret.txt"))).toBe(false);
		expect(await statics().serve(ctxFor("/.env"))).toBe(false);
	});

	test("malformed encoding is a 400", async () => {
		const ctx = ctxFor("/%E0%A4%A");
		expect(await statics().serve(ctx)).toBe(true);
		expect(ctx.toResponse().status).toBe(400);
	});

	test("POST is not served from disk", async () => {
		expect(await statics().serve(ctxFor("/ok.txt", { method: "POST" }))).toBe(false);
	});

	test("HEAD is served", async () => {
		expect(await statics().serve(ctxFor("/ok.txt", { method: "HEAD" }))).toBe(true);
	});
});

describe("conditional requests", () => {
	test("a matching ETag is a 304 with no body", async () => {
		const first = ctxFor("/ok.txt");
		await statics().serve(first);
		const etag = first.toResponse().headers.get("etag") ?? "";

		const second = ctxFor("/ok.txt", { headers: { "if-none-match": etag } });
		await statics().serve(second);
		const response = second.toResponse();
		expect(response.status).toBe(304);
		expect(await response.text()).toBe("");
	});

	test("a weak/strong spelling mismatch still matches", async () => {
		const first = ctxFor("/ok.txt");
		await statics().serve(first);
		const strong = (first.toResponse().headers.get("etag") ?? "").replace(/^W\//, "");

		const second = ctxFor("/ok.txt", { headers: { "if-none-match": strong } });
		await statics().serve(second);
		expect(second.toResponse().status).toBe(304);
	});

	test("a list of ETags matches if any member does", async () => {
		const first = ctxFor("/ok.txt");
		await statics().serve(first);
		const etag = first.toResponse().headers.get("etag") ?? "";

		const second = ctxFor("/ok.txt", { headers: { "if-none-match": `W/"nope", ${etag}` } });
		await statics().serve(second);
		expect(second.toResponse().status).toBe(304);
	});

	test("'*' matches anything present", async () => {
		const ctx = ctxFor("/ok.txt", { headers: { "if-none-match": "*" } });
		await statics().serve(ctx);
		expect(ctx.toResponse().status).toBe(304);
	});

	test("a stale ETag re-sends the file", async () => {
		const ctx = ctxFor("/ok.txt", { headers: { "if-none-match": 'W/"0-0"' } });
		await statics().serve(ctx);
		expect(ctx.toResponse().status).toBe(200);
	});

	test("If-Modified-Since is honoured, and loses to If-None-Match", async () => {
		const past = new Date(Date.now() - 86_400_000);
		utimesSync(join(root, "ok.txt"), past, past);

		const fresh = ctxFor("/ok.txt", { headers: { "if-modified-since": new Date().toUTCString() } });
		await statics().serve(fresh);
		expect(fresh.toResponse().status).toBe(304);

		const stale = ctxFor("/ok.txt", {
			headers: { "if-modified-since": new Date(Date.now() - 172_800_000).toUTCString() },
		});
		await statics().serve(stale);
		expect(stale.toResponse().status).toBe(200);

		// ETag present but non-matching: the date must not rescue it.
		const conflicting = ctxFor("/ok.txt", {
			headers: { "if-none-match": 'W/"0-0"', "if-modified-since": new Date().toUTCString() },
		});
		await statics().serve(conflicting);
		expect(conflicting.toResponse().status).toBe(200);
	});

	test("an unparseable date is ignored", async () => {
		const ctx = ctxFor("/ok.txt", { headers: { "if-modified-since": "not a date" } });
		await statics().serve(ctx);
		expect(ctx.toResponse().status).toBe(200);
	});
});

describe("ranges", () => {
	test("parses the forms it supports", () => {
		expect(parseRange("bytes=0-4", 12)).toEqual({ start: 0, end: 4 });
		expect(parseRange("bytes=5-", 12)).toEqual({ start: 5, end: 11 });
		expect(parseRange("bytes=-3", 12)).toEqual({ start: 9, end: 11 });
		expect(parseRange("bytes=0-100", 12)).toEqual({ start: 0, end: 11 });
	});

	test("declines what it does not support and rejects the impossible", () => {
		expect(parseRange(null, 12)).toBeUndefined();
		expect(parseRange("bytes=0-1,4-5", 12)).toBeUndefined();
		expect(parseRange("items=0-1", 12)).toBeUndefined();
		expect(parseRange("bytes=-", 12)).toBeUndefined();
		expect(parseRange("bytes=20-", 12)).toBe("unsatisfiable");
		expect(parseRange("bytes=5-2", 12)).toBe("unsatisfiable");
		expect(parseRange("bytes=-0", 12)).toBe("unsatisfiable");
	});

	test("serves 206 with Content-Range", async () => {
		const ctx = ctxFor("/ok.txt", { headers: { range: "bytes=0-4" } });
		await statics().serve(ctx);
		const response = ctx.toResponse();
		expect(response.status).toBe(206);
		expect(response.headers.get("content-range")).toBe("bytes 0-4/12");
		expect(await response.text()).toBe("hello");
	});

	test("an unsatisfiable range is 416", async () => {
		const ctx = ctxFor("/ok.txt", { headers: { range: "bytes=999-" } });
		await statics().serve(ctx);
		const response = ctx.toResponse();
		expect(response.status).toBe(416);
		expect(response.headers.get("content-range")).toBe("bytes */12");
	});
});

describe("through a running server", () => {
	let running: RunningApp | undefined;

	afterEach(async () => {
		await running?.stop();
		running = undefined;
	});

	test("files are served, and traversal over the raw socket does not leak", async () => {
		reset({ Static: { enabled: true, root, index: "index.html", maxAge: 0 } });
		running = await startApp(new Application({ cwd: dir.path }));

		expect(await (await running.fetch("/ok.txt")).text()).toBe("hello static");
		expect(await (await running.fetch("/")).text()).toBe("<h1>root index</h1>");

		for (const attack of [
			"GET /..%2fsecret.txt HTTP/1.1",
			"GET /%2e%2e/secret.txt HTTP/1.1",
			"GET /deep/..%2F..%2Fsecret.txt HTTP/1.1",
			"GET /.env HTTP/1.1",
			"GET /escape-link.txt HTTP/1.1",
		]) {
			const response = await rawRequest(running.base, attack);
			expect(response).not.toContain("TOP SECRET");
			expect(response).not.toContain("hunter2");
			expect(response.split("\r\n")[0]).toContain("404");
		}
	});

	test("a file created after a 404 is served — misses are not cached", async () => {
		reset({ Static: { enabled: true, root, index: "index.html" }, Cache: { publicCacheTTL: 900 } });
		running = await startApp(new Application({ cwd: dir.path }));

		expect((await running.fetch("/appears-later.txt")).status).toBe(404);
		writeFileSync(join(root, "appears-later.txt"), "now it exists");
		expect(await (await running.fetch("/appears-later.txt")).text()).toBe("now it exists");
	});

	test("a registered route wins over a file of the same name by default", async () => {
		reset({ Static: { enabled: true, root, index: "index.html" } });
		new Router().get("/ok.txt", (ctx) => {
			ctx.response.body = "from the route";
		});
		running = await startApp(new Application({ cwd: dir.path }));
		expect(await (await running.fetch("/ok.txt")).text()).toBe("from the route");
	});

	test("Static.beforeRoutes restores v1's order", async () => {
		reset({ Static: { enabled: true, root, index: "index.html", beforeRoutes: true } });
		new Router().get("/ok.txt", (ctx) => {
			ctx.response.body = "from the route";
		});
		running = await startApp(new Application({ cwd: dir.path }));
		expect(await (await running.fetch("/ok.txt")).text()).toBe("hello static");
	});
});
