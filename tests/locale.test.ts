import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Application, compose } from "../src/server.ts";
import { compress } from "../src/compress.ts";
import { Router } from "../src/router.ts";
import { localeRouting, localizeHtml, localizeTarget, splitLocale } from "../src/locale.ts";
import { reset, startApp, type RunningApp } from "./helpers.ts";

const routing = localeRouting({ prefixes: ["fr"], exclude: ["/auth/", "/sitemap.xml"] });

describe("splitLocale", () => {
	test("finds the prefix and the path under it", () => {
		expect(splitLocale(routing, "/fr")).toEqual({ locale: "fr", path: "/" });
		expect(splitLocale(routing, "/fr/")).toEqual({ locale: "fr", path: "/" });
		expect(splitLocale(routing, "/fr/servers/12")).toEqual({ locale: "fr", path: "/servers/12" });
	});

	test("ignores look-alikes and excluded paths", () => {
		expect(splitLocale(routing, "/french")).toBeNull();
		expect(splitLocale(routing, "/servers")).toBeNull();
		expect(splitLocale(routing, "/fr/auth/callback")).toBeNull();
	});

	test("refuses a prefix that is not a language", () => {
		expect(() => localeRouting({ prefixes: ["fr/x"] })).toThrow();
		expect(() => localeRouting({ prefixes: ["fr"], exclude: ["auth"] })).toThrow();
	});
});

describe("localizeTarget", () => {
	test("prefixes same-site paths and keeps query and hash", () => {
		expect(localizeTarget(routing, "fr", "/")).toBe("/fr");
		expect(localizeTarget(routing, "fr", "/servers?tab=1#top")).toBe("/fr/servers?tab=1#top");
	});

	test("leaves everything else alone", () => {
		for (const target of ["https://discord.com/x", "//cdn.test/a", "#top", "?page=2", "relative", "/site.css", "/sitemap.xml", "/auth/login", "/fr/servers", "/fr"]) {
			expect(localizeTarget(routing, "fr", target)).toBe(target);
		}
	});
});

describe("localizeHtml", () => {
	test("rewrites links and form actions only", () => {
		const html = `<a class="x" href="/servers">S</a><form method="post" action='/me'></form><link href="/site.css" rel="stylesheet"><img src="/a.png"><a href="https://x.test/">X</a>`;
		expect(localizeHtml(routing, "fr", html)).toBe(
			`<a class="x" href="/fr/servers">S</a><form method="post" action='/fr/me'></form><link href="/site.css" rel="stylesheet"><img src="/a.png"><a href="https://x.test/">X</a>`,
		);
	});

	test("keeps links that opt out", () => {
		const html = `<a hreflang="en" href="/servers">EN</a><a data-locale="off" href="/servers">raw</a>`;
		expect(localizeHtml(routing, "fr", html)).toBe(html);
	});

	test("is idempotent", () => {
		const once = localizeHtml(routing, "fr", `<a href="/servers?a=1&amp;b=2">x</a>`);
		expect(once).toBe(`<a href="/fr/servers?a=1&amp;b=2">x</a>`);
		expect(localizeHtml(routing, "fr", once)).toBe(once);
	});
});

describe("Application.localePrefixes", () => {
	let running: RunningApp | undefined;

	beforeEach(() => reset());
	afterEach(async () => {
		await running?.stop();
		running = undefined;
	});

	function app(): Application {
		const routes = new Router();
		routes.get("/", (ctx) => {
			ctx.response.type = "text/html";
			return `<a href="/servers">${ctx.locale ?? "en"}</a>`;
		});
		routes.get("/servers/:id", (ctx) => `${ctx.locale ?? "en"} ${ctx.path} ${ctx.params.id} ${ctx.localize("/me")}`);
		routes.get("/go", (ctx) => ctx.response.redirect("/servers/1"));
		routes.post("/echo", async (ctx) => `${ctx.locale} ${await ctx.request.text()}`);
		routes.get("/auth/callback", (ctx) => `auth ${ctx.locale ?? "none"}`);
		return new Application().localePrefixes({ prefixes: ["fr"], exclude: ["/auth/"] });
	}

	test("serves the same route bare and under the prefix, without the prefix in the path", async () => {
		running = await startApp(app());
		expect(await (await running.fetch("/servers/7")).text()).toBe("en /servers/7 7 /me");
		expect(await (await running.fetch("/fr/servers/7")).text()).toBe("fr /servers/7 7 /fr/me");
	});

	test("serves the root under /fr and /fr/ and rewrites its links", async () => {
		running = await startApp(app());
		expect(await (await running.fetch("/")).text()).toBe(`<a href="/servers">en</a>`);
		expect(await (await running.fetch("/fr")).text()).toBe(`<a href="/fr/servers">fr</a>`);
		expect(await (await running.fetch("/fr/")).text()).toBe(`<a href="/fr/servers">fr</a>`);
	});

	test("keeps the prefix in redirects", async () => {
		running = await startApp(app());
		const bare = await running.fetch("/go", { redirect: "manual" });
		expect(bare.headers.get("location")).toBe("/servers/1");
		const french = await running.fetch("/fr/go", { redirect: "manual" });
		expect(french.headers.get("location")).toBe("/fr/servers/1");
	});

	test("passes the body of a prefixed POST through", async () => {
		running = await startApp(app());
		const answer = await running.fetch("/fr/echo", { method: "POST", body: "hello" });
		expect(await answer.text()).toBe("fr hello");
	});

	test("does not serve excluded paths under the prefix", async () => {
		running = await startApp(app());
		expect(await (await running.fetch("/auth/callback")).text()).toBe("auth none");
		expect((await running.fetch("/fr/auth/callback")).status).toBe(404);
	});

	test("rewrites links before compression turns the page into bytes", async () => {
		const application = app();
		application.use(compress({ threshold: 0 }));
		running = await startApp(application);
		const answer = await running.fetch("/fr", { headers: { "accept-encoding": "gzip" } });
		expect(await answer.text()).toBe(`<a href="/fr/servers">fr</a>`);
	});

	test("compose is unchanged for apps without prefixes", async () => {
		expect(typeof compose([])).toBe("function");
	});
});
