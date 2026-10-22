import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { config } from "../src/config.ts";
import { Application } from "../src/server.ts";
import { Context } from "../src/context.ts";
import { Router } from "../src/router.ts";
import { MemoryAdapter, type SessionAdapter } from "../src/session/adapter.ts";
import { SqliteAdapter } from "../src/session/sqlite.ts";
import { Session, SessionManager } from "../src/session/session.ts";
import { reset, startApp, tempDir, type RunningApp } from "./helpers.ts";

const nowSeconds = () => Math.floor(Date.now() / 1000);

describe("Session", () => {
	test("Get answers false for an absent key — v1 callers compare against false", () => {
		const session = new Session("id", nowSeconds() + 60);
		expect(session.Get("nope")).toBe(false);
		session.Set("a", 0);
		expect(session.Get<number>("a")).toBe(0);
		expect(session.Has("a")).toBe(true);
	});

	test("Set marks the session dirty; iSet deliberately does not", () => {
		const session = new Session("id", nowSeconds() + 60);
		session.iSet("scratch", 1);
		expect(session.dirty).toBe(false);
		session.Set("real", 1);
		expect(session.dirty).toBe(true);
	});

	test("delete and clear mark it dirty", () => {
		const session = new Session("id", nowSeconds() + 60, { a: 1, b: 2 });
		session.delete("a");
		expect(session.Get("a")).toBe(false);
		expect(session.dirty).toBe(true);
		session.dirty = false;
		session.clear();
		expect(session.data).toEqual({});
		expect(session.dirty).toBe(true);
	});

	test("expiry is checked against the clock", () => {
		expect(new Session("id", nowSeconds() - 1).IsExpired()).toBe(true);
		expect(new Session("id", nowSeconds() + 60).IsExpired()).toBe(false);
	});

	test("SetExpires returns the new absolute expiry", () => {
		const session = new Session("id", nowSeconds());
		const expiry = session.SetExpires(120);
		expect(expiry).toBeGreaterThan(nowSeconds() + 110);
		expect(session.expire).toBe(expiry);
	});

	test("Save on an unbound session is a no-op, not a crash", async () => {
		await new Session("loose", nowSeconds() + 60).Save();
	});
});

const adapters: [string, () => { adapter: SessionAdapter; cleanup: () => void }][] = [
	["memory", () => ({ adapter: new MemoryAdapter(), cleanup: () => {} })],
	[
		"sqlite (in-memory)",
		() => {
			const adapter = new SqliteAdapter({ path: ":memory:" });
			return { adapter, cleanup: () => adapter.close() };
		},
	],
];

describe.each(adapters)("adapter: %s", (_name, make) => {
	test("round-trips a record", async () => {
		const { adapter, cleanup } = make();
		try {
			await adapter.save({ id: "a", data: { user: "aiko", n: 3 }, expires: nowSeconds() + 60 });
			expect((await adapter.load("a"))?.data).toEqual({ user: "aiko", n: 3 });
		} finally {
			cleanup();
		}
	});

	test("an unknown id is undefined", async () => {
		const { adapter, cleanup } = make();
		try {
			expect(await adapter.load("missing")).toBeUndefined();
		} finally {
			cleanup();
		}
	});

	test("an expired record reads as missing and is dropped", async () => {
		const { adapter, cleanup } = make();
		try {
			await adapter.save({ id: "old", data: {}, expires: nowSeconds() - 1 });
			expect(await adapter.load("old")).toBeUndefined();
			expect(await adapter.size()).toBe(0);
		} finally {
			cleanup();
		}
	});

	test("saving the same id twice updates rather than duplicates", async () => {
		const { adapter, cleanup } = make();
		try {
			await adapter.save({ id: "a", data: { v: 1 }, expires: nowSeconds() + 60 });
			await adapter.save({ id: "a", data: { v: 2 }, expires: nowSeconds() + 60 });
			expect(await adapter.size()).toBe(1);
			expect((await adapter.load("a"))?.data).toEqual({ v: 2 });
		} finally {
			cleanup();
		}
	});

	test("the stored copy is a snapshot, not a live reference", async () => {
		const { adapter, cleanup } = make();
		try {
			const data: Record<string, unknown> = { v: 1 };
			await adapter.save({ id: "a", data, expires: nowSeconds() + 60 });
			data.v = 99;
			expect((await adapter.load("a"))?.data).toEqual({ v: 1 });
		} finally {
			cleanup();
		}
	});

	test("sweep removes only what has expired, and counts it", async () => {
		const { adapter, cleanup } = make();
		try {
			await adapter.save({ id: "old1", data: {}, expires: nowSeconds() - 10 });
			await adapter.save({ id: "old2", data: {}, expires: nowSeconds() - 5 });
			await adapter.save({ id: "live", data: {}, expires: nowSeconds() + 60 });
			expect(await adapter.sweep()).toBe(2);
			expect(await adapter.size()).toBe(1);
			expect(await adapter.load("live")).toBeDefined();
		} finally {
			cleanup();
		}
	});

	test("destroy and clear", async () => {
		const { adapter, cleanup } = make();
		try {
			await adapter.save({ id: "a", data: {}, expires: nowSeconds() + 60 });
			await adapter.destroy("a");
			expect(await adapter.load("a")).toBeUndefined();
			await adapter.save({ id: "b", data: {}, expires: nowSeconds() + 60 });
			await adapter.clear();
			expect(await adapter.size()).toBe(0);
		} finally {
			cleanup();
		}
	});

	test("nested structures survive the round trip", async () => {
		const { adapter, cleanup } = make();
		try {
			const data = { user: { name: "aiko", roles: ["admin", "dev"] }, seen: [1, 2, 3] };
			await adapter.save({ id: "a", data, expires: nowSeconds() + 60 });
			expect((await adapter.load("a"))?.data).toEqual(data);
		} finally {
			cleanup();
		}
	});
});

describe("SqliteAdapter", () => {
	test("persists across processes — reopening the file finds the session", () => {
		const dir = tempDir("natsu-sqlite-");
		const path = join(dir.path, "nested", "sessions.sqlite");
		try {
			const first = new SqliteAdapter({ path });
			first.save({ id: "persisted", data: { user: "aiko" }, expires: nowSeconds() + 60 });
			first.close();

			const second = new SqliteAdapter({ path });
			expect(second.load("persisted")?.data).toEqual({ user: "aiko" });
			second.close();
		} finally {
			dir.cleanup();
		}
	});

	test("a corrupt row is dropped instead of throwing mid-request", () => {
		const adapter = new SqliteAdapter({ path: ":memory:" });
		try {
			adapter.db.query("INSERT INTO sessions (id, data, expires) VALUES (?, ?, ?)").run("bad", "{not json", nowSeconds() + 60);
			expect(adapter.load("bad")).toBeUndefined();
			expect(adapter.size()).toBe(0);
		} finally {
			adapter.close();
		}
	});

	test("refuses a table name it would have to interpolate blind", () => {
		expect(() => new SqliteAdapter({ path: ":memory:", table: "sessions; DROP TABLE users" })).toThrow();
	});

	test("survives a hundred writes to one row without corrupting it", async () => {
		const adapter = new SqliteAdapter({ path: ":memory:" });
		try {
			const writes = Array.from({ length: 100 }, (_, i) =>
				Promise.resolve(adapter.save({ id: "hot", data: { i }, expires: nowSeconds() + 60 })),
			);
			await Promise.all(writes);
			expect(adapter.size()).toBe(1);
			expect(adapter.load("hot")?.data).toEqual({ i: 99 });
		} finally {
			adapter.close();
		}
	});
});

describe("SessionManager", () => {
	test("create mints a uuid and keeps the instance live", async () => {
		const manager = new SessionManager({ sweepInterval: 0 });
		const session = manager.create();
		expect(session.id).toMatch(/^[0-9a-f-]{36}$/);
		expect(await manager.get(session.id)).toBe(session);
		await manager.close();
	});

	test("two lookups of one id give the same object — no lost updates", async () => {
		const manager = new SessionManager({ sweepInterval: 0 });
		const created = manager.create();
		created.Set("v", 1);
		await manager.persist(created);
		manager.evict();

		const [a, b] = await Promise.all([manager.get(created.id), manager.get(created.id)]);
		expect(a).toBe(b as Session);

		a?.Set("fromA", true);
		b?.Set("fromB", true);
		await manager.persist(a as Session);
		manager.evict();

		const reloaded = await manager.get(created.id);
		expect(reloaded?.Get<boolean>("fromA")).toBe(true);
		expect(reloaded?.Get<boolean>("fromB")).toBe(true);
		await manager.close();
	});

	test("interleaved saves do not lose the later write", async () => {
		const manager = new SessionManager({ sweepInterval: 0 });
		const session = manager.create();

		session.Set("a", 1);
		const first = session.Save();
		session.Set("b", 2);
		const second = session.Save();
		session.Set("c", 3);
		const third = session.Save();
		await Promise.all([first, second, third]);

		manager.evict();
		const reloaded = await manager.get(session.id);
		// v1 dropped saves that arrived while one was in flight.
		expect(reloaded?.data).toEqual({ a: 1, b: 2, c: 3 });
		await manager.close();
	});

	test("an expired session is not handed out, and is removed", async () => {
		const manager = new SessionManager({ ttl: 1, sweepInterval: 0 });
		const session = manager.create();
		session.expire = nowSeconds() - 1;
		await session.Save();
		expect(await manager.get(session.id)).toBeUndefined();
		expect(await manager.adapter.load(session.id)).toBeUndefined();
		await manager.close();
	});

	test("an expired session held only in the store is not resurrected", async () => {
		const adapter = new MemoryAdapter();
		const manager = new SessionManager({ adapter, sweepInterval: 0 });
		adapter.save({ id: "stale", data: { a: 1 }, expires: nowSeconds() - 5 });
		expect(await manager.get("stale")).toBeUndefined();
		await manager.close();
	});

	test("persist writes only when something changed", async () => {
		const manager = new SessionManager({ sweepInterval: 0 });
		let writes = 0;
		const original = manager.adapter.save.bind(manager.adapter);
		manager.adapter.save = (record) => {
			writes++;
			return original(record);
		};

		const session = manager.create();
		await manager.persist(session);
		expect(writes).toBe(1);
		await manager.persist(session);
		expect(writes).toBe(1);
		session.Set("x", 1);
		await manager.persist(session);
		expect(writes).toBe(2);
		await manager.close();
	});

	test("sweep clears expired instances as well as stored rows", async () => {
		const manager = new SessionManager({ sweepInterval: 0 });
		const live = manager.create();
		const dead = manager.create();
		dead.expire = nowSeconds() - 1;
		await manager.persist(live);
		await manager.persist(dead);

		await manager.sweep();
		expect(manager.liveCount()).toBe(1);
		expect(await manager.get(live.id)).toBe(live);
		await manager.close();
	});

	test("attachCookie sets a constrained cookie", async () => {
		const manager = new SessionManager({ cookieName: "TEST_SID", sweepInterval: 0 });
		const ctx = new Context(new Request("http://a.test/"));
		const session = manager.create();
		manager.attachCookie(ctx, session);
		const cookie = ctx.response.headers.get("set-cookie") ?? "";
		expect(cookie).toContain(`TEST_SID=${session.id}`);
		expect(cookie).toContain("HttpOnly");
		expect(cookie).toContain("SameSite=Lax");
		expect(cookie).toContain("Path=/");
		expect(cookie).toMatch(/Max-Age=\d+/);
		await manager.close();
	});

	test("registered hooks are exposed for the middleware to run", async () => {
		const manager = new SessionManager({ sweepInterval: 0 });
		manager.registerMiddleware("audit", () => {});
		expect([...manager.getAllMiddleware().keys()]).toEqual(["audit"]);
		await manager.close();
	});
});

describe("cookie hardening from config", () => {
	let running: RunningApp | undefined;

	afterEach(async () => {
		await running?.stop();
		running = undefined;
	});

	function managerFor(general: Record<string, unknown>, session: Record<string, unknown> = {}) {
		reset({ General: { logFormat: "", logLevel: "silent", ...general }, Session: { driver: "memory", sweepInterval: 0, ...session } });
		return SessionManager.fromConfig(config);
	}

	test("an https public url makes the cookie Secure and __Host- prefixed", () => {
		const manager = managerFor({ url: "https://shop.test" });
		expect(manager.cookie.secure).toBe(true);
		expect(manager.cookieName).toBe("__Host-NATSU_SESSION");
	});

	test("an http public url leaves the cookie as configured", () => {
		const manager = managerFor({ url: "http://shop.test" });
		expect(manager.cookie.secure).toBe(false);
		expect(manager.cookieName).toBe("NATSU_SESSION");
	});

	test("a Domain cookie cannot take the __Host- prefix but is still Secure", () => {
		const manager = managerFor({ url: "https://shop.test" }, { cookie: { domain: "shop.test" } });
		expect(manager.cookie.secure).toBe(true);
		expect(manager.cookieName).toBe("NATSU_SESSION");
	});

	test("a name that already carries a prefix is kept", () => {
		expect(managerFor({ url: "https://shop.test" }, { CookieName: "__Secure-SID" }).cookieName).toBe("__Secure-SID");
	});

	test("the Set-Cookie header carries Secure and the prefixed name", async () => {
		reset({ General: { logFormat: "", logLevel: "silent", url: "https://shop.test" } });
		new Router().get("/", (ctx) => {
			ctx.session.Set("a", 1);
			ctx.response.body = "ok";
		});
		running = await startApp(new Application());
		const setCookie = (await running.fetch("/")).headers.get("set-cookie") ?? "";
		expect(setCookie).toStartWith("__Host-NATSU_SESSION=");
		expect(setCookie).toContain("Secure");
	});
});

describe("default headers on session pages", () => {
	let running: RunningApp | undefined;

	afterEach(async () => {
		await running?.stop();
		running = undefined;
	});

	async function app() {
		const manager = new SessionManager({ cookieName: "SID", sweepInterval: 0 });
		new Router().get("/mine", (ctx) => {
			ctx.session.Set("a", 1);
			ctx.response.body = "mine";
		});
		new Router().get("/kept", (ctx) => {
			ctx.session.Set("a", 1);
			ctx.response.headers.set("Cache-Control", "public, max-age=60");
			ctx.response.body = "kept";
		});
		new Router().get("/plain", (ctx) => {
			ctx.response.body = "plain";
		});
		running = await startApp(new Application({ sessions: manager }));
		const cookie = (await running.fetch("/mine")).headers.get("set-cookie")!.split(";")[0]!;
		return cookie;
	}

	test("a page that touches the session is private, no-store and nosniff", async () => {
		const cookie = await app();
		const response = await running!.fetch("/mine", { headers: { cookie } });
		expect(response.headers.get("cache-control")).toBe("private, no-store");
		expect(response.headers.get("x-content-type-options")).toBe("nosniff");
	});

	test("a value the app set is kept, except that public becomes private beside a cookie", async () => {
		const cookie = await app();
		const response = await running!.fetch("/kept", { headers: { cookie } });
		expect(response.headers.get("cache-control")).toBe("private, max-age=60");
	});

	test("a page that never touches the session gets no-store or nosniff, only private", async () => {
		const cookie = await app();
		const response = await running!.fetch("/plain", { headers: { cookie } });
		expect(response.headers.get("cache-control")).toBe("private");
		expect(response.headers.get("x-content-type-options")).toBeNull();
	});
});

describe("anonymous session lifetime", () => {
	const horizon = (seconds: number) => nowSeconds() + seconds;

	test("a session with no data expires on the short bound", () => {
		const manager = new SessionManager({ ttl: 1000, anonymousTtl: 10, sweepInterval: 0 });
		const session = manager.create();
		expect(session.expire).toBeLessThanOrEqual(horizon(10));
		expect(session.expire).toBeGreaterThan(horizon(5));
	});

	test("the first Set promotes it to the full lifetime", () => {
		const manager = new SessionManager({ ttl: 1000, anonymousTtl: 10, sweepInterval: 0 });
		const session = manager.create();
		session.Set("user", "aiko");
		expect(session.expire).toBeGreaterThan(horizon(900));
	});

	test("renewing a still-anonymous session keeps the short bound", () => {
		const manager = new SessionManager({ ttl: 1000, anonymousTtl: 10, sweepInterval: 0 });
		const session = manager.create();
		session.Renew();
		expect(session.expire).toBeLessThanOrEqual(horizon(10));
	});

	test("without the option the lifetime is the ttl, as before", () => {
		const manager = new SessionManager({ ttl: 1000, sweepInterval: 0 });
		expect(manager.create().expire).toBeGreaterThan(horizon(900));
	});

	test("the config default is an hour", () => {
		reset({ Session: { driver: "memory", sweepInterval: 0, ttl: 86400 } });
		const manager = SessionManager.fromConfig(config);
		expect(manager.anonymousTtl).toBe(3600);
	});
});

describe("rotate", () => {
	let running: RunningApp | undefined;

	afterEach(async () => {
		await running?.stop();
		running = undefined;
	});

	test("destroys the old id, issues a new one and keeps the data", async () => {
		const manager = new SessionManager({ cookieName: "SID", sweepInterval: 0 });
		new Router().get("/seed", (ctx) => {
			ctx.session.Set("user", "aiko");
			ctx.response.body = ctx.session.id;
		});
		new Router().get("/login", async (ctx) => {
			const before = ctx.session.id;
			const next = await manager.rotate(ctx);
			ctx.response.body = `${before} ${next.id} ${String(next.Get("user"))}`;
		});
		running = await startApp(new Application({ sessions: manager }));

		const seed = await running.fetch("/seed");
		const oldId = await seed.text();
		const cookie = (seed.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
		const login = await running.fetch("/login", { headers: { cookie } });
		const [before, after, user] = (await login.text()).split(" ");

		expect(before).toBe(oldId);
		expect(after).not.toBe(oldId);
		expect(user).toBe("aiko");
		expect((await manager.get(after!))!.expire).toBeGreaterThan(nowSeconds() + 3600);
		expect(login.headers.get("set-cookie")).toContain(`SID=${after}`);
		expect(await manager.get(oldId)).toBeUndefined();
		expect((await manager.get(after!))?.Get("user")).toBe("aiko");
	});

	test("keepData: false starts the new session empty", async () => {
		const manager = new SessionManager({ cookieName: "SID", sweepInterval: 0 });
		const old = manager.create();
		old.Set("user", "aiko");
		await old.Save();
		const ctx = new Context(new Request("http://x.test/"));
		ctx.sessions = manager;
		ctx.session = old;

		const next = await manager.rotate(ctx, { keepData: false });

		expect(next.id).not.toBe(old.id);
		expect(next.Get("user")).toBe(false);
		expect(ctx.session).toBe(next);
	});
});

describe("middleware", () => {
	let running: RunningApp | undefined;

	afterEach(async () => {
		await running?.stop();
		running = undefined;
	});

	test("a request that never touches the session gets no cookie and no row", async () => {
		reset();
		const manager = new SessionManager({ sweepInterval: 0 });
		new Router().get("/plain", (ctx) => {
			ctx.response.body = "no session here";
		});
		running = await startApp(new Application({ sessions: manager }));

		const response = await running.fetch("/plain");
		expect(response.headers.get("set-cookie")).toBeNull();
		expect(await manager.adapter.size()).toBe(0);
	});

	test("touching the session mints one, sets a cookie, and persists it", async () => {
		reset();
		const manager = new SessionManager({ cookieName: "SID", sweepInterval: 0 });
		new Router().get("/login", (ctx) => {
			ctx.session.Set("user", "aiko");
			ctx.response.body = ctx.session.id;
		});
		running = await startApp(new Application({ sessions: manager }));

		const response = await running.fetch("/login");
		const id = await response.text();
		expect(response.headers.get("set-cookie")).toContain(`SID=${id}`);
		expect((await manager.adapter.load(id))?.data).toEqual({ user: "aiko" });
	});

	test("the cookie carries the session into the next request", async () => {
		reset();
		const manager = new SessionManager({ cookieName: "SID", sweepInterval: 0 });
		const routes = new Router();
		routes.get("/set", (ctx) => {
			ctx.session.Set("user", "aiko");
			ctx.response.body = "set";
		});
		routes.get("/read", (ctx) => {
			ctx.response.body = String(ctx.session.Get("user"));
		});
		running = await startApp(new Application({ sessions: manager }));

		const first = await running.fetch("/set");
		const cookie = (first.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
		const second = await running.fetch("/read", { headers: { cookie } });
		expect(await second.text()).toBe("aiko");
	});

	test("an unknown cookie id yields a fresh session, not a resurrected one", async () => {
		reset();
		const manager = new SessionManager({ cookieName: "SID", sweepInterval: 0 });
		new Router().get("/read", (ctx) => {
			ctx.response.body = ctx.session.id;
		});
		running = await startApp(new Application({ sessions: manager }));

		const response = await running.fetch("/read", { headers: { cookie: "SID=00000000-0000-0000-0000-000000000000" } });
		const id = await response.text();
		expect(id).not.toBe("00000000-0000-0000-0000-000000000000");
		expect(response.headers.get("set-cookie")).toContain(`SID=${id}`);
	});

	test("concurrent requests on one cookie share the session", async () => {
		reset();
		const manager = new SessionManager({ cookieName: "SID", sweepInterval: 0 });
		const routes = new Router();
		routes.get("/start", (ctx) => {
			ctx.session.Set("hits", 0);
			ctx.response.body = "ok";
		});
		routes.get("/bump", async (ctx) => {
			const current = Number(ctx.session.Get("hits") || 0);
			// Yield between read and write: the window where two copies of one
			// session would clobber each other.
			await Bun.sleep(5);
			ctx.session.Set("hits", current + 1);
			ctx.response.body = "bumped";
		});
		running = await startApp(new Application({ sessions: manager }));

		const start = await running.fetch("/start");
		const cookie = (start.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
		await Promise.all(Array.from({ length: 5 }, () => running?.fetch("/bump", { headers: { cookie } })));

		const id = cookie.split("=")[1] ?? "";
		const stored = await manager.adapter.load(id);
		// One shared instance means the last writer wins per write, but the
		// session is never split in two — the count is at least 1 and the row
		// is intact.
		expect(typeof stored?.data.hits).toBe("number");
		expect(manager.liveCount()).toBe(1);
	});

	test("rolling expiry pushes the session forward on each request", async () => {
		reset();
		const manager = new SessionManager({ cookieName: "SID", ttl: 100, sweepInterval: 0 });
		new Router().get("/touch", (ctx) => {
			ctx.response.body = String(ctx.session.expire);
		});
		running = await startApp(new Application({ sessions: manager }));

		const first = await running.fetch("/touch");
		const cookie = (first.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
		const id = cookie.split("=")[1] ?? "";
		const session = await manager.get(id);
		const before = session?.expire ?? 0;
		session!.expire = before - 50;

		await running.fetch("/touch", { headers: { cookie } });
		expect((await manager.get(id))?.expire).toBeGreaterThan(before - 50);
	});

	test("ctx.session throws when sessions are switched off", async () => {
		reset();
		new Router().get("/nope", (ctx) => {
			ctx.response.body = ctx.session.id;
		});
		running = await startApp(new Application({ sessions: false }));
		expect((await running.fetch("/nope")).status).toBe(500);
	});
});
