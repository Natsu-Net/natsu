import { describe, expect, test } from "bun:test";
import { Context, parseCookies, serializeCookie } from "../src/context.ts";

function ctxFor(url: string, init?: RequestInit): Context {
	return new Context(new Request(url, init));
}

describe("url parsing", () => {
	test("path and search without building a URL", () => {
		const ctx = ctxFor("http://a.test/x/y?q=1");
		expect(ctx.path).toBe("/x/y");
		expect(ctx.search).toBe("?q=1");
	});

	test("a bare origin is path '/'", () => {
		const ctx = ctxFor("http://a.test");
		expect(ctx.path).toBe("/");
		expect(ctx.search).toBe("");
	});

	test("a fragment never reaches the path or the query", () => {
		const ctx = ctxFor("http://a.test/x#frag");
		expect(ctx.path).toBe("/x");
		expect(ctx.search).toBe("");
	});

	test("the hand-rolled parse agrees with URL", () => {
		for (const raw of ["http://a.test/", "http://a.test/a/b", "http://a.test/a?b=c", "http://a.test:8080/a/b?c=d"]) {
			const ctx = ctxFor(raw);
			expect(ctx.path).toBe(new URL(raw).pathname);
			expect(ctx.search).toBe(new URL(raw).search);
		}
	});

	test("query is flat with last-value-wins, and empty for no query", () => {
		expect(ctxFor("http://a.test/x?a=1&a=2&b=3").query).toEqual({ a: "2", b: "3" });
		expect(ctxFor("http://a.test/x").query).toEqual({});
	});

	test("searchParams keeps every repeated value", () => {
		expect(ctxFor("http://a.test/x?a=1&a=2").searchParams.getAll("a")).toEqual(["1", "2"]);
	});
});

describe("cookies", () => {
	test("parses a header, decoding values", () => {
		const cookies = parseCookies("a=1; b=hello%20world;c=");
		expect(cookies.get("a")).toBe("1");
		expect(cookies.get("b")).toBe("hello world");
		expect(cookies.get("c")).toBe("");
	});

	test("a malformed escape is kept raw instead of throwing", () => {
		expect(parseCookies("a=%E0%A4%A").get("a")).toBe("%E0%A4%A");
	});

	test("junk pairs are skipped", () => {
		const cookies = parseCookies("novalue; =novalue; a=1");
		expect([...cookies.keys()]).toEqual(["a"]);
	});

	test("no header is an empty map", () => {
		expect(parseCookies(null).size).toBe(0);
	});

	test("serializes with HttpOnly and SameSite by default", () => {
		expect(serializeCookie("s", "v")).toBe("s=v; Path=/; HttpOnly; SameSite=Lax");
	});

	test("httpOnly: false is honoured, and values are encoded", () => {
		expect(serializeCookie("s", "a b", { httpOnly: false, secure: true, maxAge: 60, sameSite: "strict" })).toBe(
			"s=a%20b; Max-Age=60; Path=/; Secure; SameSite=Strict",
		);
	});

	test("deleteCookie expires it and forgets the request value", () => {
		const ctx = ctxFor("http://a.test/", { headers: { cookie: "s=v" } });
		expect(ctx.cookies.get("s")).toBe("v");
		ctx.deleteCookie("s");
		expect(ctx.cookies.get("s")).toBeUndefined();
		expect(ctx.response.headers.get("set-cookie")).toContain("Max-Age=0");
	});
});

describe("response", () => {
	test("nothing written is a 404", () => {
		expect(ctxFor("http://a.test/").toResponse().status).toBe(404);
	});

	test("a body alone is a 200", () => {
		const ctx = ctxFor("http://a.test/");
		ctx.response.body = "hi";
		expect(ctx.toResponse().status).toBe(200);
	});

	test("an explicit status survives an empty body", () => {
		const ctx = ctxFor("http://a.test/");
		ctx.response.status = 204;
		expect(ctx.toResponse().status).toBe(204);
	});

	test("a string starting with '<' is sniffed as HTML", async () => {
		const ctx = ctxFor("http://a.test/");
		ctx.response.body = "<h1>x</h1>";
		expect(ctx.toResponse().headers.get("content-type")).toBe("text/html; charset=utf-8");
	});

	test("an explicit content-type is never overwritten", () => {
		const ctx = ctxFor("http://a.test/");
		ctx.response.headers.set("Content-Type", "application/xml");
		ctx.response.body = "<x/>";
		expect(ctx.toResponse().headers.get("content-type")).toBe("application/xml");
	});

	test("an object body is JSON", async () => {
		const ctx = ctxFor("http://a.test/");
		ctx.response.body = { a: 1 };
		const response = ctx.toResponse();
		expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
		expect(await response.json()).toEqual({ a: 1 });
	});

	test("binary bodies pass through untouched", async () => {
		const ctx = ctxFor("http://a.test/");
		ctx.response.body = new Uint8Array([1, 2, 3]);
		expect(new Uint8Array(await ctx.toResponse().arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
	});

	test("a handler's own Response is returned, with queued cookies grafted on", async () => {
		const ctx = ctxFor("http://a.test/");
		ctx.setCookie("s", "v");
		ctx.response.headers.set("X-From-Middleware", "1");
		ctx.response.body = new Response("raw", { status: 201, headers: { "X-Own": "1" } });
		const response = ctx.toResponse();
		expect(response.status).toBe(201);
		expect(await response.text()).toBe("raw");
		expect(response.headers.get("x-own")).toBe("1");
		expect(response.headers.get("x-from-middleware")).toBe("1");
		expect(response.headers.get("set-cookie")).toContain("s=v");
	});

	test("redirect sets Location and 302 by default", () => {
		const ctx = ctxFor("http://a.test/");
		ctx.response.redirect("/login");
		const response = ctx.toResponse();
		expect(response.status).toBe(302);
		expect(response.headers.get("location")).toBe("/login");
	});

	test("headers are only allocated if something asks for them", () => {
		const ctx = ctxFor("http://a.test/");
		expect(ctx.response.headersInitialized).toBe(false);
		ctx.response.headers.set("a", "b");
		expect(ctx.response.headersInitialized).toBe(true);
	});
});

describe("ip", () => {
	test("the forwarded header is ignored unless the proxy is trusted", () => {
		const ctx = ctxFor("http://a.test/", { headers: { "x-forwarded-for": "1.2.3.4, 5.6.7.8" } });
		expect(ctx.ip).toBe("");
		ctx.trustProxy = true;
		expect(ctx.ip).toBe("1.2.3.4");
	});
});

describe("session", () => {
	test("touching ctx.session without a manager fails loudly", () => {
		expect(() => ctxFor("http://a.test/").session).toThrow(/Session support is disabled/);
	});

	test("sessionLoaded stays false until something asks", () => {
		expect(ctxFor("http://a.test/").sessionLoaded).toBe(false);
	});
});

describe("params", () => {
	test("the default params object is shared and empty", () => {
		expect(ctxFor("http://a.test/").params).toEqual({});
	});
});
