import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Application } from "../src/server.ts";
import type { Context } from "../src/context.ts";
import { Controller, GetController, controllerNames, hasController } from "../src/controller.ts";
import { Get, Post, Router, All } from "../src/router.ts";
import { reset, startApp, type RunningApp } from "./helpers.ts";

let running: RunningApp | undefined;

beforeEach(() => {
	reset();
});

afterEach(async () => {
	await running?.stop();
	running = undefined;
});

describe("namespace form", () => {
	test("Add registers under Namespace@method", () => {
		new Controller("Home").Add("Index", () => "x");
		expect(hasController("Home@Index")).toBe(true);
		expect(controllerNames()).toEqual(["Home@Index"]);
	});

	test("Add chains", () => {
		const home = new Controller("Home");
		expect(home.Add("A", () => "a")).toBe(home);
		home.Add("B", () => "b");
		expect(controllerNames().sort()).toEqual(["Home@A", "Home@B"]);
	});

	test("a second Add with the same name replaces the first", async () => {
		const home = new Controller("Home");
		home.Add("Index", () => "one");
		home.Add("Index", () => "two");
		expect(await GetController("Home@Index")({} as Context)).toBe("two");
	});

	test("GetController resolves at call time, not at lookup time", async () => {
		const handler = GetController("Later@fn");
		expect(await handler({} as Context)).toBeUndefined();
		new Controller("Later").Add("fn", () => "here now");
		expect(await handler({} as Context)).toBe("here now");
	});

	test("a missing controller returns undefined instead of throwing", async () => {
		expect(await GetController("Nope@none")({} as Context)).toBeUndefined();
	});

	test("the handler receives the context", async () => {
		new Controller("Echo").Add("ctx", (ctx) => ctx.path);
		const fake = { path: "/from-ctx" } as Context;
		expect(await GetController("Echo@ctx")(fake)).toBe("/from-ctx");
	});
});

describe("decorator form", () => {
	test("@Controller + @Get registers a route and a registry entry", async () => {
		@Controller("/users")
		class Users {
			@Get("/:id")
			show(ctx: Context): string {
				return `user ${ctx.params.id}`;
			}

			@Post("/")
			create(): string {
				return "created";
			}
		}
		void Users;

		expect(hasController("Users@show")).toBe(true);
		expect(Router.records().map((r) => `${r.method} ${r.path}`).sort()).toEqual(["GET /users/:id", "POST /users"]);

		running = await startApp(new Application());
		expect(await (await running.fetch("/users/9")).text()).toBe("user 9");
		expect(await (await running.fetch("/users", { method: "POST" })).text()).toBe("created");
	});

	test("the class is constructed once, lazily, on the first request", async () => {
		let constructed = 0;

		@Controller("/lazy")
		class Lazy {
			constructor() {
				constructed++;
			}

			@Get("/a")
			a(): string {
				return "a";
			}

			@Get("/b")
			b(): string {
				return "b";
			}
		}
		void Lazy;

		expect(constructed).toBe(0);
		running = await startApp(new Application());
		await running.fetch("/lazy/a");
		await running.fetch("/lazy/b");
		expect(constructed).toBe(1);
	});

	test("methods keep their `this` and share instance state", async () => {
		@Controller("/counter")
		class Counter {
			private hits = 0;

			@Get("/hit")
			hit(): string {
				this.hits++;
				return String(this.hits);
			}
		}
		void Counter;

		running = await startApp(new Application());
		expect(await (await running.fetch("/counter/hit")).text()).toBe("1");
		expect(await (await running.fetch("/counter/hit")).text()).toBe("2");
	});

	test("a decorated controller can be bound to a domain", () => {
		@Controller("/scoped", { domain: "admin.test" })
		class Scoped {
			@Get("/x")
			x(): string {
				return "x";
			}
		}
		void Scoped;

		const entry = Router.routes().entries.get("/scoped/x");
		expect(entry?.select("GET", "admin.test")).toBeDefined();
		expect(entry?.select("GET", "public.test")).toBeUndefined();
	});

	test("the registry name can be overridden", () => {
		@Controller("/n", { name: "Renamed" })
		class Original {
			@Get("/x")
			x(): string {
				return "x";
			}
		}
		void Original;

		expect(hasController("Renamed@x")).toBe(true);
		expect(hasController("Original@x")).toBe(false);
	});

	test("@All covers every method", async () => {
		@Controller("/every")
		class Every {
			@All("/thing")
			thing(ctx: Context): string {
				return ctx.method;
			}
		}
		void Every;

		running = await startApp(new Application());
		expect(await (await running.fetch("/every/thing", { method: "DELETE" })).text()).toBe("DELETE");
	});

	test("a decorated method is reachable by its string name too", async () => {
		@Controller("/mixed")
		class Mixed {
			@Get("/decorated")
			decorated(): string {
				return "from decorator";
			}
		}
		void Mixed;

		new Router().get("/by-string", "Mixed@decorated");
		running = await startApp(new Application());
		expect(await (await running.fetch("/by-string")).text()).toBe("from decorator");
	});

	test("an empty prefix mounts at the root", async () => {
		@Controller()
		class Root {
			@Get("/root")
			root(): string {
				return "root";
			}
		}
		void Root;

		running = await startApp(new Application());
		expect(await (await running.fetch("/root")).text()).toBe("root");
	});
});

describe("the two forms are one callable", () => {
	test("with new it is a namespace, without it is a decorator", () => {
		expect(new Controller("X")).toHaveProperty("Add");
		expect(typeof Controller("/prefix")).toBe("function");
	});
});
