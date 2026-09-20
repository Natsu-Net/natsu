import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Application, compose, loadDirectory } from "../src/server.ts";
import { Context, type Middleware } from "../src/context.ts";
import { Router } from "../src/router.ts";
import { setConfig } from "../src/config.ts";
import { setLogLevel, setLogSink } from "../src/logger.ts";
import { reset, startApp, tempDir, type RunningApp } from "./helpers.ts";

let running: RunningApp | undefined;

beforeEach(() => {
	reset();
});

afterEach(async () => {
	await running?.stop();
	running = undefined;
	setLogLevel("silent");
	setLogSink(() => {});
});

describe("compose", () => {
	test("runs middleware as an onion around the terminal", async () => {
		const order: string[] = [];
		const chain = compose([
			async (_ctx, next) => {
				order.push("a:before");
				await next();
				order.push("a:after");
			},
			async (_ctx, next) => {
				order.push("b:before");
				await next();
				order.push("b:after");
			},
		]);

		await chain(new Context(new Request("http://a.test/")), async () => {
			order.push("terminal");
		});
		expect(order).toEqual(["a:before", "b:before", "terminal", "b:after", "a:after"]);
	});

	test("a middleware that never calls next stops the chain", async () => {
		const order: string[] = [];
		const chain = compose([
			async () => {
				order.push("short-circuit");
			},
			async (_ctx, next) => {
				order.push("never");
				await next();
			},
		]);

		await chain(new Context(new Request("http://a.test/")), async () => {
			order.push("terminal");
		});
		expect(order).toEqual(["short-circuit"]);
	});

	test("calling next twice is an error, not a silent double run", async () => {
		const chain = compose([
			async (_ctx, next) => {
				await next();
				await next();
			},
		]);
		let terminals = 0;
		await expect(
			chain(new Context(new Request("http://a.test/")), async () => {
				terminals++;
			}),
		).rejects.toThrow(/more than once/);
		expect(terminals).toBe(1);
	});

	test("an empty chain still reaches the terminal", async () => {
		let reached = false;
		await compose([])(new Context(new Request("http://a.test/")), async () => {
			reached = true;
		});
		expect(reached).toBe(true);
	});

	test("a throw propagates out of the chain", async () => {
		const chain = compose([
			async () => {
				throw new Error("boom");
			},
		]);
		await expect(chain(new Context(new Request("http://a.test/")), async () => {})).rejects.toThrow("boom");
	});
});

describe("middleware through the server", () => {
	test("application middleware wraps the route handler in registration order", async () => {
		const order: string[] = [];
		new Router().get("/m", (ctx) => {
			order.push("handler");
			ctx.response.body = "ok";
		});

		const app = new Application();
		app.use(async (_ctx, next) => {
			order.push("one:in");
			await next();
			order.push("one:out");
		});
		app.use(async (_ctx, next) => {
			order.push("two:in");
			await next();
			order.push("two:out");
		});
		running = await startApp(app);

		await running.fetch("/m");
		expect(order).toEqual(["one:in", "two:in", "handler", "two:out", "one:out"]);
	});

	test("middleware sees the response the handler produced", async () => {
		new Router().get("/seen", (ctx) => {
			ctx.response.body = "from handler";
		});
		const app = new Application();
		app.use(async (ctx, next) => {
			await next();
			ctx.response.headers.set("X-Saw", String(ctx.response.body));
		});
		running = await startApp(app);
		expect((await running.fetch("/seen")).headers.get("x-saw")).toBe("from handler");
	});

	test("middleware can answer without reaching the route", async () => {
		let handlerRan = false;
		new Router().get("/guarded", () => {
			handlerRan = true;
		});
		const app = new Application();
		app.use(async (ctx) => {
			ctx.response.status = 401;
			ctx.response.body = "nope";
		});
		running = await startApp(app);

		const response = await running.fetch("/guarded");
		expect(response.status).toBe(401);
		expect(handlerRan).toBe(false);
	});

	test("middleware also runs for a 404", async () => {
		let saw = false;
		const app = new Application();
		app.use(async (_ctx, next) => {
			saw = true;
			await next();
		});
		running = await startApp(app);
		expect((await running.fetch("/nothing-here")).status).toBe(404);
		expect(saw).toBe(true);
	});

	test("use() after start is picked up on the next request", async () => {
		new Router().get("/late", (ctx) => {
			ctx.response.body = "ok";
		});
		const app = new Application();
		running = await startApp(app);
		app.use(async (ctx, next) => {
			await next();
			ctx.response.headers.set("X-Late", "1");
		});
		expect((await running.fetch("/late")).headers.get("x-late")).toBe("1");
	});
});

describe("handlers", () => {
	test("a returned value becomes the body", async () => {
		new Router().get("/returned", () => "returned body");
		running = await startApp(new Application());
		expect(await (await running.fetch("/returned")).text()).toBe("returned body");
	});

	test("an explicit body wins over the return value", async () => {
		new Router().get("/both", (ctx) => {
			ctx.response.body = "explicit";
			return "returned";
		});
		running = await startApp(new Application());
		expect(await (await running.fetch("/both")).text()).toBe("explicit");
	});

	test("a returned Response is used as-is", async () => {
		new Router().get("/raw", () => new Response("raw body", { status: 201, headers: { "X-Raw": "1" } }));
		running = await startApp(new Application());
		const response = await running.fetch("/raw");
		expect(response.status).toBe(201);
		expect(response.headers.get("x-raw")).toBe("1");
		expect(await response.text()).toBe("raw body");
	});

	test("an async handler is awaited", async () => {
		new Router().get("/slow", async () => {
			await Bun.sleep(5);
			return "eventually";
		});
		running = await startApp(new Application());
		expect(await (await running.fetch("/slow")).text()).toBe("eventually");
	});
});

describe("errors", () => {
	test("a throwing handler is a 500 without leaking the stack", async () => {
		new Router().get("/boom", () => {
			throw new Error("private detail");
		});
		running = await startApp(new Application());
		const response = await running.fetch("/boom");
		expect(response.status).toBe(500);
		expect(await response.text()).toBe("Internal Server Error");
	});

	test("development mode includes the stack", async () => {
		setConfig({ General: { development: true } });
		new Router().get("/boom", () => {
			throw new Error("private detail");
		});
		running = await startApp(new Application());
		expect(await (await running.fetch("/boom")).text()).toContain("private detail");
	});

	test("onError can replace the response", async () => {
		new Router().get("/boom", () => {
			throw new Error("nope");
		});
		const app = new Application();
		app.onError((error, ctx) => {
			ctx.response.status = 418;
			ctx.response.body = `handled: ${error.message}`;
		});
		running = await startApp(app);
		const response = await running.fetch("/boom");
		expect(response.status).toBe(418);
		expect(await response.text()).toBe("handled: nope");
	});

	test("an onError that writes nothing falls back to the default 500", async () => {
		new Router().get("/boom", () => {
			throw new Error("nope");
		});
		const app = new Application();
		app.onError(() => {});
		running = await startApp(app);
		expect((await running.fetch("/boom")).status).toBe(500);
	});

	test("a throw in middleware is caught the same way", async () => {
		const app = new Application();
		app.use(async () => {
			throw new Error("middleware blew up");
		});
		running = await startApp(app);
		expect((await running.fetch("/anything")).status).toBe(500);
	});

	test("one failing request does not poison the next", async () => {
		const routes = new Router();
		routes.get("/boom", () => {
			throw new Error("boom");
		});
		routes.get("/fine", () => "fine");
		running = await startApp(new Application());
		expect((await running.fetch("/boom")).status).toBe(500);
		expect(await (await running.fetch("/fine")).text()).toBe("fine");
	});
});

describe("request logging", () => {
	test("logs one line per request with the status and duration", async () => {
		setConfig({ General: { logFormat: "{method} {path} {status} {ms}ms", logLevel: "info" } });
		new Router().get("/logged", () => "ok");
		running = await startApp(new Application());

		// Capture only request lines, not the registration chatter above.
		const lines: string[] = [];
		setLogLevel("info");
		setLogSink((line) => lines.push(line));
		await running.fetch("/logged");

		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatch(/^GET \/logged 200 [\d.]+ms$/);
	});

	test("ignored prefixes stay quiet", async () => {
		setConfig({ General: { logFormat: "{path}", logLevel: "info", logIgnore: ["/assets", "/favicon.ico"] } });

		const routes = new Router();
		routes.get("/assets/app.js", () => "js");
		routes.get("/page", () => "page");
		running = await startApp(new Application());

		const lines: string[] = [];
		setLogLevel("info");
		setLogSink((line) => lines.push(line));
		await running.fetch("/assets/app.js");
		await running.fetch("/page");
		expect(lines).toEqual(["/page"]);
	});

	test("a request that ends in a 500 is still logged", async () => {
		setConfig({ General: { logFormat: "{method} {path} {status}", logLevel: "info" } });
		new Router().get("/boom", () => {
			throw new Error("boom");
		});
		running = await startApp(new Application());

		const lines: string[] = [];
		setLogLevel("info");
		setLogSink((line) => lines.push(line));
		expect((await running.fetch("/boom")).status).toBe(500);
		// The handler's error is caught inside the chain, so middleware that
		// wraps the request still runs its second half.
		expect(lines.filter((line) => !line.startsWith("[ERROR]"))).toEqual(["GET /boom 500"]);
	});

	test("an empty logFormat disables the logger entirely", async () => {
		setConfig({ General: { logFormat: "", logLevel: "info" } });
		new Router().get("/quiet", () => "ok");
		running = await startApp(new Application());

		const lines: string[] = [];
		setLogLevel("info");
		setLogSink((line) => lines.push(line));
		await running.fetch("/quiet");
		expect(lines).toEqual([]);
	});
});

describe("lifecycle", () => {
	test("start binds a port and stop releases it", async () => {
		new Router().get("/up", () => "up");
		const app = new Application();
		const server = await app.start({ port: 0, hostname: "127.0.0.1", quiet: true });
		const origin = server.url.origin;
		expect(await (await fetch(`${origin}/up`)).text()).toBe("up");

		// A graceful stop keeps an already-open keep-alive connection usable,
		// so the check for "the port is gone" has to cut connections.
		await app.stop(true);
		expect(app.running).toBe(false);
		await expect(fetch(`${origin}/up`)).rejects.toThrow();
		await app.close();
	});

	test("stop is idempotent", async () => {
		const app = new Application();
		await app.start({ port: 0, hostname: "127.0.0.1", quiet: true });
		await app.stop();
		await app.stop();
		await app.close();
	});

	test("restart keeps the same port and picks up new routes", async () => {
		new Router().get("/first", () => "first");
		const app = new Application();
		const server = await app.start({ port: 0, hostname: "127.0.0.1", quiet: true });
		const origin = server.url.origin;

		new Router().get("/second", () => "second");
		await app.restart({ quiet: true });

		expect(app.server?.url.origin).toBe(origin);
		expect(await (await fetch(`${origin}/first`)).text()).toBe("first");
		expect(await (await fetch(`${origin}/second`)).text()).toBe("second");
		await app.close();
	});

	test("restart on a stopped app starts it again", async () => {
		new Router().get("/x", () => "x");
		const app = new Application();
		await app.start({ port: 0, hostname: "127.0.0.1", quiet: true });
		await app.stop();
		const server = await app.restart({ port: 0, hostname: "127.0.0.1", quiet: true });
		expect(await (await fetch(`${server.url.origin}/x`)).text()).toBe("x");
		await app.close();
	});

	test("a graceful stop lets an in-flight request finish", async () => {
		new Router().get("/slow", async () => {
			await Bun.sleep(80);
			return "finished";
		});
		const app = new Application();
		const server = await app.start({ port: 0, hostname: "127.0.0.1", quiet: true });

		const inflight = fetch(`${server.url.origin}/slow`);
		await Bun.sleep(10);
		await app.stop(false);
		expect(await (await inflight).text()).toBe("finished");
		await app.close();
	});

	test("reload before start is refused", () => {
		expect(() => new Application().reload()).toThrow(/before start/);
	});

	test("start on a running app reloads instead of binding twice", async () => {
		const app = new Application();
		const first = await app.start({ port: 0, hostname: "127.0.0.1", quiet: true });
		const second = await app.start({ quiet: true });
		expect(second.url.origin).toBe(first.url.origin);
		await app.close();
	});
});

describe("handle()", () => {
	test("runs the pipeline without binding a socket", async () => {
		new Router().get("/direct", () => "direct");
		const app = new Application();
		const response = await app.handle(new Request("http://a.test/direct"));
		expect(await response.text()).toBe("direct");
		await app.close();
	});

	test("params must be supplied, because Bun owns pattern matching", async () => {
		new Router().get("/u/:id", (ctx) => `id=${ctx.params.id ?? "none"}`);
		const app = new Application();
		// The literal path is not in the table — only the pattern is.
		expect((await app.handle(new Request("http://a.test/u/7"))).status).toBe(404);
		const matched = await app.handle(new Request("http://a.test/u/:id"), undefined, { id: "7" });
		expect(await matched.text()).toBe("id=7");
		await app.close();
	});
});

describe("loadDirectory", () => {
	test("imports every module under a directory, and tolerates a missing one", async () => {
		const dir = tempDir("natsu-load-");
		try {
			mkdirSync(join(dir.path, "nested"), { recursive: true });
			writeFileSync(join(dir.path, "a.ts"), `globalThis.__natsuLoaded = [...(globalThis.__natsuLoaded ?? []), "a"];`);
			writeFileSync(
				join(dir.path, "nested", "b.ts"),
				`globalThis.__natsuLoaded = [...(globalThis.__natsuLoaded ?? []), "b"];`,
			);
			writeFileSync(join(dir.path, "notes.md"), "ignored");

			const loaded = await loadDirectory(dir.path);
			expect(loaded).toHaveLength(2);
			expect((globalThis as Record<string, unknown>).__natsuLoaded).toEqual(["a", "b"]);
			expect(await loadDirectory(join(dir.path, "does-not-exist"))).toEqual([]);
		} finally {
			delete (globalThis as Record<string, unknown>).__natsuLoaded;
			dir.cleanup();
		}
	});
});

describe("errors and middleware second halves", () => {
	test("a session written before a throw is still persisted", async () => {
		const { SessionManager } = await import("../src/session/session.ts");
		const manager = new SessionManager({ cookieName: "SID", sweepInterval: 0 });
		new Router().get("/half-done", (ctx) => {
			ctx.session.Set("user", "aiko");
			throw new Error("after the write");
		});
		running = await startApp(new Application({ sessions: manager }));

		const response = await running.fetch("/half-done");
		expect(response.status).toBe(500);
		const cookie = response.headers.get("set-cookie") ?? "";
		const id = (cookie.split(";")[0] ?? "").split("=")[1] ?? "";
		expect((await manager.adapter.load(id))?.data).toEqual({ user: "aiko" });
		await manager.close();
	});
});

describe("ordering of built-ins", () => {
	test("the session middleware runs before application middleware", async () => {
		const seen: boolean[] = [];
		const app = new Application();
		const middleware: Middleware = async (ctx, next) => {
			seen.push(ctx.sessions !== undefined);
			await next();
		};
		app.use(middleware);
		new Router().get("/order", () => "ok");
		running = await startApp(app);
		await running.fetch("/order");
		expect(seen).toEqual([true]);
	});
});
