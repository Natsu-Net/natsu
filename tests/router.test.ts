import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Application } from "../src/server.ts";
import { Context } from "../src/context.ts";
import { Controller } from "../src/controller.ts";
import { Router } from "../src/router.ts";
import { reset, rawRequest, startApp, type RunningApp } from "./helpers.ts";

let running: RunningApp | undefined;

beforeEach(() => {
	reset();
});

afterEach(async () => {
	await running?.stop();
	running = undefined;
});

async function serve(build: () => void): Promise<RunningApp> {
	build();
	running = await startApp(new Application());
	return running;
}

const text = (body: string) => (ctx: Context) => {
	ctx.response.body = body;
};

describe("methods", () => {
	test("each verb dispatches to its own handler", async () => {
		const app = await serve(() => {
			const routes = new Router();
			routes.get("/r", text("get"));
			routes.post("/r", text("post"));
			routes.put("/r", text("put"));
			routes.delete("/r", text("delete"));
			routes.patch("/r", text("patch"));
		});

		for (const method of ["GET", "POST", "PUT", "DELETE", "PATCH"]) {
			const response = await app.fetch("/r", { method });
			expect(await response.text()).toBe(method.toLowerCase());
		}
	});

	test("an unregistered method is 405 with an Allow header", async () => {
		const app = await serve(() => {
			new Router().get("/only", text("x"));
		});
		const response = await app.fetch("/only", { method: "DELETE" });
		expect(response.status).toBe(405);
		expect(response.headers.get("allow")?.split(", ").sort()).toEqual(["GET", "HEAD"]);
	});

	test("HEAD answers a GET route with no body", async () => {
		const app = await serve(() => {
			new Router().get("/h", text("body"));
		});
		const response = await app.fetch("/h", { method: "HEAD" });
		expect(response.status).toBe(200);
		expect(await response.text()).toBe("");
	});

	test("all() catches a method nobody registered", async () => {
		const app = await serve(() => {
			new Router().all("/any", (ctx) => {
				ctx.response.body = `any:${ctx.method}`;
			});
		});
		expect(await (await app.fetch("/any", { method: "PATCH" })).text()).toBe("any:PATCH");
		expect(await (await app.fetch("/any", { method: "OPTIONS" })).text()).toBe("any:OPTIONS");
	});

	test("a specific method wins over all() on the same path", async () => {
		const app = await serve(() => {
			const routes = new Router();
			routes.all("/mix", text("any"));
			routes.get("/mix", text("specific"));
		});
		expect(await (await app.fetch("/mix")).text()).toBe("specific");
		expect(await (await app.fetch("/mix", { method: "POST" })).text()).toBe("any");
	});
});

describe("parameters", () => {
	test("a single parameter reaches ctx.params", async () => {
		const app = await serve(() => {
			new Router().get("/u/:id", (ctx) => {
				ctx.response.body = `id=${ctx.params.id}`;
			});
		});
		expect(await (await app.fetch("/u/42")).text()).toBe("id=42");
	});

	test("several parameters in one path", async () => {
		const app = await serve(() => {
			new Router().get("/a/:x/b/:y", (ctx) => {
				ctx.response.body = `${ctx.params.x}-${ctx.params.y}`;
			});
		});
		expect(await (await app.fetch("/a/1/b/2")).text()).toBe("1-2");
	});

	test("a parameter arrives percent-decoded", async () => {
		const app = await serve(() => {
			new Router().get("/u/:name", (ctx) => {
				ctx.response.body = ctx.params.name ?? "";
			});
		});
		expect(await (await app.fetch("/u/h%C3%A9llo")).text()).toBe("héllo");
	});

	test("a literal path beats a parameter on the same segment", async () => {
		const app = await serve(() => {
			const routes = new Router();
			routes.get("/u/:id", text("param"));
			routes.get("/u/me", text("literal"));
		});
		expect(await (await app.fetch("/u/me")).text()).toBe("literal");
		expect(await (await app.fetch("/u/other")).text()).toBe("param");
	});

	test("a wildcard catches the rest of the path", async () => {
		const app = await serve(() => {
			new Router().get("/files/*", (ctx) => {
				ctx.response.body = ctx.path;
			});
		});
		expect(await (await app.fetch("/files/a/b/c.txt")).text()).toBe("/files/a/b/c.txt");
	});

	test("params do not leak between requests", async () => {
		const app = await serve(() => {
			new Router().get("/p/:id", (ctx) => {
				ctx.response.body = JSON.stringify(ctx.params);
			});
		});
		expect(await (await app.fetch("/p/1")).text()).toBe('{"id":"1"}');
		expect(await (await app.fetch("/p/2")).text()).toBe('{"id":"2"}');
	});
});

describe("prefixes", () => {
	test("Prefix joins paths and normalises slashes", async () => {
		const app = await serve(() => {
			new Router().Prefix("/test/", (sub) => {
				sub.get("/user", text("user"));
				sub.get("/", text("root"));
			});
		});
		expect(await (await app.fetch("/test/user")).text()).toBe("user");
		expect(await (await app.fetch("/test")).text()).toBe("root");
	});

	test("prefixes nest", async () => {
		const app = await serve(() => {
			new Router().Prefix("/a", (outer) => {
				outer.Prefix("/b", (inner) => {
					inner.get("/c", text("abc"));
				});
			});
		});
		expect(await (await app.fetch("/a/b/c")).text()).toBe("abc");
	});

	test("a guard that returns true lets the route run", async () => {
		const app = await serve(() => {
			new Router().Prefix("/g", (sub) => sub.get("/ok", text("ran")), () => true);
		});
		expect(await (await app.fetch("/g/ok")).text()).toBe("ran");
	});

	test("a guard that returns false blocks the route", async () => {
		let ran = false;
		const app = await serve(() => {
			new Router().Prefix(
				"/g",
				(sub) =>
					sub.get("/blocked", () => {
						ran = true;
					}),
				() => false,
			);
		});
		expect((await app.fetch("/g/blocked")).status).toBe(404);
		expect(ran).toBe(false);
	});

	test("a guard that returns nothing blocks too — v1 denies by default", async () => {
		let ran = false;
		const app = await serve(() => {
			new Router().Prefix(
				"/g",
				(sub) =>
					sub.get("/implicit", () => {
						ran = true;
					}),
				() => {
					/* no return */
				},
			);
		});
		expect((await app.fetch("/g/implicit")).status).toBe(404);
		expect(ran).toBe(false);
	});

	test("an async guard is awaited", async () => {
		const app = await serve(() => {
			new Router().Prefix("/g", (sub) => sub.get("/slow", text("ran")), async () => {
				await Bun.sleep(1);
				return true;
			});
		});
		expect(await (await app.fetch("/g/slow")).text()).toBe("ran");
	});

	test("nested guards run outermost first and all must pass", async () => {
		const order: string[] = [];
		const app = await serve(() => {
			new Router().Prefix(
				"/a",
				(outer) => {
					outer.Prefix(
						"/b",
						(inner) => inner.get("/c", text("ok")),
						() => {
							order.push("inner");
							return true;
						},
					);
				},
				() => {
					order.push("outer");
					return true;
				},
			);
		});
		expect(await (await app.fetch("/a/b/c")).text()).toBe("ok");
		expect(order).toEqual(["outer", "inner"]);
	});

	test("an outer guard that blocks stops the inner one from running", async () => {
		const order: string[] = [];
		const app = await serve(() => {
			new Router().Prefix(
				"/a",
				(outer) => {
					outer.Prefix(
						"/b",
						(inner) => inner.get("/c", text("ok")),
						() => {
							order.push("inner");
							return true;
						},
					);
				},
				() => {
					order.push("outer");
					return false;
				},
			);
		});
		expect((await app.fetch("/a/b/c")).status).toBe(404);
		expect(order).toEqual(["outer"]);
	});

	test("a guard applies only to its own group", async () => {
		const app = await serve(() => {
			const routes = new Router();
			routes.Prefix("/locked", (sub) => sub.get("/x", text("locked")), () => false);
			routes.get("/open", text("open"));
		});
		expect((await app.fetch("/locked/x")).status).toBe(404);
		expect(await (await app.fetch("/open")).text()).toBe("open");
	});
});

describe("domains", () => {
	test("a domain router only answers its own host", () => {
		new Router("app.test").get("/d", text("app"));
		const entry = Router.routes().entries.get("/d");
		expect(entry?.select("GET", "app.test")).toBeDefined();
		expect(entry?.select("GET", "other.test")).toBeUndefined();
	});

	test("a domain without a port matches any port", () => {
		new Router("app.test").get("/d", text("app"));
		expect(Router.routes().entries.get("/d")?.select("GET", "app.test:8083")).toBeDefined();
	});

	test("a domain with a port requires that port", () => {
		new Router("app.test:8083").get("/d", text("app"));
		const entry = Router.routes().entries.get("/d");
		expect(entry?.select("GET", "app.test:8083")).toBeDefined();
		expect(entry?.select("GET", "app.test:9999")).toBeUndefined();
	});

	test("host matching ignores case", () => {
		new Router("App.Test").get("/d", text("app"));
		expect(Router.routes().entries.get("/d")?.select("GET", "app.TEST")).toBeDefined();
	});

	test("the domain-specific route wins even when registered second", async () => {
		new Router().get("/both", text("catch-all"));
		new Router("app.test").get("/both", text("domain"));

		const entry = Router.routes().entries.get("/both");
		const domainHandler = entry?.select("GET", "app.test");
		const otherHandler = entry?.select("GET", "elsewhere.test");

		const a = new Context(new Request("http://app.test/both"));
		await domainHandler?.(a);
		expect(a.response.body).toBe("domain");

		const b = new Context(new Request("http://elsewhere.test/both"));
		await otherHandler?.(b);
		expect(b.response.body).toBe("catch-all");
	});

	test("a host mismatch with no catch-all is a 404, not a 405", async () => {
		const app = await serve(() => {
			new Router("nowhere.test").get("/only-there", text("x"));
		});
		const response = await app.fetch("/only-there");
		expect(response.status).toBe(404);
		expect(response.headers.get("allow")).toBeNull();
	});

	test("over the wire, the Host header decides", async () => {
		const app = await serve(() => {
			new Router("app.test").get("/host", text("matched"));
			new Router().get("/host", text("fallback"));
		});
		const matched = await rawRequest(app.base, "GET /host HTTP/1.1", []);
		expect(matched).toContain("fallback");

		const url = new URL(app.base);
		const viaHost = await new Promise<string>((resolve, reject) => {
			let received = "";
			Bun.connect({
				hostname: url.hostname,
				port: Number(url.port),
				socket: {
					open(socket) {
						socket.write("GET /host HTTP/1.1\r\nHost: app.test\r\nConnection: close\r\n\r\n");
					},
					data(_s, chunk) {
						received += chunk.toString();
					},
					close() {
						resolve(received);
					},
					error(_s, error) {
						reject(error);
					},
				},
			}).catch(reject);
		});
		expect(viaHost).toContain("matched");
	});
});

describe("controller references", () => {
	test("a 'Name@method' route resolves even when the controller loads later", async () => {
		const app = await serve(() => {
			new Router().get("/late", "Late@show");
		});
		// The route was compiled and the server started before this ran.
		new Controller("Late").Add("show", text("late binding works"));
		expect(await (await app.fetch("/late")).text()).toBe("late binding works");
	});

	test("a route pointing at a controller that never appears is a 404", async () => {
		const app = await serve(() => {
			new Router().get("/ghost", "Ghost@nothing");
		});
		expect((await app.fetch("/ghost")).status).toBe(404);
	});
});

describe("compilation", () => {
	test("the compiled table is cached until a route is added", () => {
		const routes = new Router();
		routes.get("/a", text("a"));
		const first = Router.routes();
		expect(Router.routes()).toBe(first);
		routes.get("/b", text("b"));
		expect(Router.routes()).not.toBe(first);
	});

	test("a trailing slash reaches the same route", async () => {
		const app = await serve(() => {
			new Router().get("/x", text("x"));
		});
		expect(await (await app.fetch("/x/")).text()).toBe("x");
	});

	test("registering '/y/' is registering '/y' — paths are normalised once", async () => {
		const app = await serve(() => {
			const routes = new Router();
			routes.get("/y", text("no-slash"));
			routes.get("/y/", text("with-slash"));
		});
		// Both spellings are one route, so the first registration answers both.
		expect(Router.records().map((r) => r.path)).toEqual(["/y", "/y"]);
		expect(await (await app.fetch("/y")).text()).toBe("no-slash");
		expect(await (await app.fetch("/y/")).text()).toBe("no-slash");
	});

	test("duplicate registrations resolve in registration order", async () => {
		const app = await serve(() => {
			const routes = new Router();
			routes.get("/dup", text("first"));
			routes.get("/dup", text("second"));
		});
		expect(await (await app.fetch("/dup")).text()).toBe("first");
	});

	test("routes registered after the server started are picked up by restart()", async () => {
		const app = await serve(() => {
			new Router().get("/before", text("before"));
		});
		expect((await app.fetch("/after")).status).toBe(404);

		new Router().get("/after", text("after"));
		await app.app.restart({ quiet: true });

		expect(await (await app.fetch("/after")).text()).toBe("after");
		expect(await (await app.fetch("/before")).text()).toBe("before");
	});

	test("Router.clear() empties the table", () => {
		new Router().get("/gone", text("x"));
		expect(Router.records().length).toBe(1);
		Router.clear();
		expect(Router.records().length).toBe(0);
		expect(Router.routes().entries.size).toBe(0);
	});
});
