/**
 * The live socket, against a real server and a real WebSocket.
 *
 * Every assertion below is a round trip through `Bun.serve`: no mocked socket,
 * no hand-called handler. That matters because the things worth proving here
 * are protocol-level — that a `hello` gets a snapshot, that a write to a
 * read-only field changes nothing, that a client cannot name somebody else's
 * scope — and a mock would prove them about the mock.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Application } from "../src/server.ts";
import { endSession, resetLive } from "../src/live.ts";
import { Action, Networked, State, caller, grantRoom, hasRoom, resetState, resolveState, type StateClass } from "../src/state.ts";
import { Router } from "../src/router.ts";
import { SessionManager } from "../src/session/session.ts";
import { reset, startApp, type RunningApp } from "./helpers.ts";

@State("room", { scope: "global" })
class Room {
	@Networked() online = 0;
	@Networked({ writable: true }) topic = "hello";

	@Action()
	bump(by = 1) {
		this.online += by;
	}

	notAnAction() {
		this.online = -1;
	}
}

@State("cart")
class Cart {
	@Networked() items = 0;
}

@State("party", { scope: "room" })
class Party {
	@Networked() at = 0;
	@Networked() host = "";
	@Networked() log: string[] = [];

	@Action()
	seek(to: number) {
		this.at = to;
	}

	/** First one in takes the room; nobody else may take it off them. */
	@Action()
	claim() {
		const who = caller()?.sessionId ?? "";
		if (this.host && this.host !== who) return;
		this.host = who;
	}

	/** Only the host may move everybody. */
	@Action()
	hostSeek(to: number) {
		if (caller()?.sessionId !== this.host) return;
		this.at = to;
	}

	@Action()
	say(text: string) {
		const user = caller()?.session?.Get("user");
		this.log = [...this.log, `${String(user)}: ${text}`];
	}
}

const AsClass = <T extends object>(c: unknown) => c as StateClass<T>;

let running: RunningApp | undefined;

beforeEach(() => {
	reset();
	resetState();
	resetLive();
});

afterEach(async () => {
	await running?.stop();
	running = undefined;
	resetLive();
});

/** Open a socket and collect frames until `want` of them have arrived. */
function open(base: string, headers?: Record<string, string>): {
	socket: WebSocket;
	ready: Promise<void>;
	frames: Array<Record<string, unknown>>;
	next(want: number, timeout?: number): Promise<Array<Record<string, unknown>>>;
} {
	// Bun's WebSocket takes headers as a second argument; the DOM lib types
	// that slot as a protocol list, hence the cast.
	const socket = new WebSocket(
		`${base.replace("http", "ws")}/_uwu/socket`,
		(headers ? { headers } : undefined) as unknown as string[],
	);
	const frames: Array<Record<string, unknown>> = [];
	socket.addEventListener("message", (event) => {
		frames.push(JSON.parse(String((event as MessageEvent).data)) as Record<string, unknown>);
	});
	const ready = new Promise<void>((resolve, reject) => {
		socket.addEventListener("open", () => resolve());
		socket.addEventListener("error", () => reject(new Error("socket refused")));
	});
	return {
		socket,
		ready,
		frames,
		async next(want, timeout = 2000) {
			const deadline = Date.now() + timeout;
			while (frames.length < want && Date.now() < deadline) {
				await Bun.sleep(5);
			}
			return frames;
		},
	};
}

describe("the handshake", () => {
	test("hello gets a snapshot of each store the page holds", async () => {
		running = await startApp(new Application());
		const client = open(running.base);
		await client.ready;

		client.socket.send(JSON.stringify({ t: "hello", stores: ["room"] }));
		const frames = await client.next(1);

		expect(frames[0]).toEqual({ t: "sync", store: "room", value: { online: 0, topic: "hello" } });
		client.socket.close();
	});

	test("an unknown store is ignored rather than answered", async () => {
		running = await startApp(new Application());
		const client = open(running.base);
		await client.ready;

		client.socket.send(JSON.stringify({ t: "hello", stores: ["nope", "room"] }));
		const frames = await client.next(1);

		expect(frames.length).toBe(1);
		expect(frames[0]?.store).toBe("room");
		client.socket.close();
	});

	test("a malformed frame does not take the connection down", async () => {
		running = await startApp(new Application());
		const client = open(running.base);
		await client.ready;

		client.socket.send("not json at all");
		client.socket.send(JSON.stringify({ t: "hello", stores: ["room"] }));
		const frames = await client.next(1);

		expect(frames[0]?.t).toBe("sync");
		expect(client.socket.readyState).toBe(WebSocket.OPEN);
		client.socket.close();
	});
});

describe("patches", () => {
	test("a server-side write reaches a connected client", async () => {
		running = await startApp(new Application());
		const client = open(running.base);
		await client.ready;
		client.socket.send(JSON.stringify({ t: "hello", stores: ["room"] }));
		await client.next(1);

		resolveState(AsClass<Room>(Room), "").online = 12;
		const frames = await client.next(2);

		expect(frames[1]).toEqual({ t: "patch", store: "room", patches: [{ path: "online", value: 12 }] });
		client.socket.close();
	});

	test("two clients on a global store both see it", async () => {
		running = await startApp(new Application());
		const a = open(running.base);
		const b = open(running.base);
		await Promise.all([a.ready, b.ready]);
		a.socket.send(JSON.stringify({ t: "hello", stores: ["room"] }));
		b.socket.send(JSON.stringify({ t: "hello", stores: ["room"] }));
		await Promise.all([a.next(1), b.next(1)]);

		resolveState(AsClass<Room>(Room), "").online = 3;
		await Promise.all([a.next(2), b.next(2)]);

		expect(a.frames[1]).toEqual(b.frames[1]!);
		expect((a.frames[1] as { patches: Array<{ value: unknown }> }).patches[0]?.value).toBe(3);
		a.socket.close();
		b.socket.close();
	});

	test("a burst of writes in one tick is one frame", async () => {
		running = await startApp(new Application());
		const client = open(running.base);
		await client.ready;
		client.socket.send(JSON.stringify({ t: "hello", stores: ["room"] }));
		await client.next(1);

		const room = resolveState(AsClass<Room>(Room), "");
		room.online = 1;
		room.online = 2;
		room.online = 3;
		await client.next(2);
		await Bun.sleep(80);

		// One patch frame, carrying the settled value — not three.
		expect(client.frames.length).toBe(2);
		expect((client.frames[1] as { patches: Array<{ path: string; value: unknown }> }).patches).toEqual([
			{ path: "online", value: 3 },
		]);
		client.socket.close();
	});
});

describe("writes from the client", () => {
	test("a writable field is accepted and echoed back as a patch", async () => {
		running = await startApp(new Application());
		const client = open(running.base);
		await client.ready;
		client.socket.send(JSON.stringify({ t: "hello", stores: ["room"] }));
		await client.next(1);

		client.socket.send(JSON.stringify({ t: "set", store: "room", key: "topic", value: "changed" }));
		await client.next(2);

		expect(resolveState(AsClass<Room>(Room), "").topic).toBe("changed");
		client.socket.close();
	});

	test("a read-only field is refused and nothing changes", async () => {
		running = await startApp(new Application());
		const client = open(running.base);
		await client.ready;
		client.socket.send(JSON.stringify({ t: "hello", stores: ["room"] }));
		await client.next(1);

		client.socket.send(JSON.stringify({ t: "set", store: "room", key: "online", value: 999 }));
		await Bun.sleep(80);

		expect(resolveState(AsClass<Room>(Room), "").online).toBe(0);
		expect(client.frames.length).toBe(1);
		client.socket.close();
	});

	test("a field the class never declared is refused", async () => {
		running = await startApp(new Application());
		const client = open(running.base);
		await client.ready;
		client.socket.send(JSON.stringify({ t: "hello", stores: ["room"] }));
		await client.next(1);

		client.socket.send(JSON.stringify({ t: "set", store: "room", key: "invented", value: "x" }));
		await Bun.sleep(80);

		expect(client.frames.length).toBe(1);
		client.socket.close();
	});
});

describe("actions", () => {
	test("an @Action runs on the server and its effect comes back", async () => {
		running = await startApp(new Application());
		const client = open(running.base);
		await client.ready;
		client.socket.send(JSON.stringify({ t: "hello", stores: ["room"] }));
		await client.next(1);

		client.socket.send(JSON.stringify({ t: "call", store: "room", method: "bump", args: [4] }));
		const frames = await client.next(2);

		expect(resolveState(AsClass<Room>(Room), "").online).toBe(4);
		expect((frames[1] as { patches: Array<{ value: unknown }> }).patches[0]?.value).toBe(4);
		client.socket.close();
	});

	test("an undecorated method is refused", async () => {
		running = await startApp(new Application());
		const client = open(running.base);
		await client.ready;
		client.socket.send(JSON.stringify({ t: "hello", stores: ["room"] }));
		await client.next(1);

		client.socket.send(JSON.stringify({ t: "call", store: "room", method: "notAnAction", args: [] }));
		await Bun.sleep(80);

		expect(resolveState(AsClass<Room>(Room), "").online).toBe(0);
		expect(client.frames.length).toBe(1);
		client.socket.close();
	});
});

describe("isolation", () => {
	test("a session store is invisible to a connection with no session", async () => {
		// This is the property the protocol is built around: a frame names a
		// store, never a scope, so there is nothing for an anonymous client to
		// say that would reach somebody's cart.
		running = await startApp(new Application());
		const client = open(running.base);
		await client.ready;

		client.socket.send(JSON.stringify({ t: "hello", stores: ["cart"] }));
		await Bun.sleep(120);

		expect(client.frames.length).toBe(0);
		client.socket.close();
	});

	test("a write to a session store from an anonymous connection changes nothing", async () => {
		running = await startApp(new Application());
		const cart = resolveState(AsClass<Cart>(Cart), "someone-elses-session");
		cart.items = 5;

		const client = open(running.base);
		await client.ready;
		client.socket.send(JSON.stringify({ t: "set", store: "cart", key: "items", value: 0 }));
		await Bun.sleep(120);

		expect(resolveState(AsClass<Cart>(Cart), "someone-elses-session").items).toBe(5);
		client.socket.close();
	});

	test("a request-scoped store is not addressable on the wire at all", async () => {
		@State("ephemeral", { scope: "request" })
		class Ephemeral {
			@Networked() n = 0;
		}
		void Ephemeral;

		running = await startApp(new Application());
		const client = open(running.base);
		await client.ready;
		client.socket.send(JSON.stringify({ t: "hello", stores: ["ephemeral"] }));
		await Bun.sleep(120);

		expect(client.frames.length).toBe(0);
		client.socket.close();
	});
});

describe("living beside an app's own socket", () => {
	test("the live socket can be turned off, freeing the path", async () => {
		running = await startApp(new Application(), { live: false });
		let refused = false;
		const socket = new WebSocket(`${running.base.replace("http", "ws")}/_uwu/socket`);
		socket.addEventListener("error", () => {
			refused = true;
		});
		await Bun.sleep(150);
		expect(refused).toBe(true);
		socket.close();
	});
});

describe("rooms", () => {
	/** Start an app with sessions and a route that joins a party. */
	async function partyApp() {
		const manager = new SessionManager({ cookieName: "SID", sweepInterval: 0 });
		new Router().get("/join/:code", (ctx) => {
			ctx.session.Set("user", ctx.query.as ?? "someone");
			ctx.joinRoom(AsClass<Party>(Party), ctx.params.code ?? "");
			ctx.response.body = ctx.session.id;
		});
		return await startApp(new Application({ sessions: manager }));
	}

	/** Join a room in a fresh session and return the cookie that proves it. */
	async function join(base: string, code: string, as = "someone"): Promise<string> {
		const response = await fetch(`${base}/join/${code}?as=${as}`);
		return (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
	}


	test("a room you joined streams to you, under its own key", async () => {
		running = await partyApp();
		const cookie = await join(running.base, "room-a");

		const client = open(running.base, { cookie });
		await client.ready;
		client.socket.send(JSON.stringify({ t: "hello", stores: ["party:room-a"] }));
		const frames = await client.next(1);

		// The key carries the room, so the browser's own store matches.
		expect(frames[0]).toEqual({ t: "sync", store: "party:room-a", value: { at: 0, host: "", log: [] } });

		resolveState(AsClass<Party>(Party), "room-a").at = 42;
		await client.next(2);
		expect(client.frames[1]).toEqual({ t: "patch", store: "party:room-a", patches: [{ path: "at", value: 42 }] });
		client.socket.close();
	});

	test("a room you were never granted is not addressable", async () => {
		// The whole point of the grant: the room id is in a URL somebody can
		// guess or be sent, so naming it must not be enough.
		running = await partyApp();
		const cookie = await join(running.base, "room-a");
		resolveState(AsClass<Party>(Party), "room-b").at = 99;

		const client = open(running.base, { cookie });
		await client.ready;
		client.socket.send(JSON.stringify({ t: "hello", stores: ["party:room-b"] }));
		client.socket.send(JSON.stringify({ t: "call", store: "party:room-b", method: "seek", args: [0] }));
		await Bun.sleep(150);

		expect(client.frames.length).toBe(0);
		expect(resolveState(AsClass<Party>(Party), "room-b").at).toBe(99);
		client.socket.close();
	});

	test("an anonymous connection cannot address any room", async () => {
		running = await partyApp();
		await join(running.base, "room-a");

		const client = open(running.base);
		await client.ready;
		client.socket.send(JSON.stringify({ t: "hello", stores: ["party:room-a"] }));
		await Bun.sleep(150);

		expect(client.frames.length).toBe(0);
		client.socket.close();
	});

	test("the bare class key names no room at all", async () => {
		running = await partyApp();
		const cookie = await join(running.base, "room-a");

		const client = open(running.base, { cookie });
		await client.ready;
		client.socket.send(JSON.stringify({ t: "hello", stores: ["party"] }));
		await Bun.sleep(150);

		expect(client.frames.length).toBe(0);
		client.socket.close();
	});

	test("two rooms in flight do not reach each other", async () => {
		running = await partyApp();
		const a = open(running.base, { cookie: await join(running.base, "room-a") });
		const b = open(running.base, { cookie: await join(running.base, "room-b") });
		await Promise.all([a.ready, b.ready]);
		a.socket.send(JSON.stringify({ t: "hello", stores: ["party:room-a"] }));
		b.socket.send(JSON.stringify({ t: "hello", stores: ["party:room-b"] }));
		await Promise.all([a.next(1), b.next(1)]);

		a.socket.send(JSON.stringify({ t: "call", store: "party:room-a", method: "seek", args: [300] }));
		await a.next(2);
		await Bun.sleep(80);

		expect(resolveState(AsClass<Party>(Party), "room-a").at).toBe(300);
		expect(resolveState(AsClass<Party>(Party), "room-b").at).toBe(0);
		expect(b.frames.length).toBe(1);
		a.socket.close();
		b.socket.close();
	});
});

describe("a session ending", () => {
	test("takes its state, its rooms and its fan-out with it", async () => {
		// Otherwise every visitor who ever connected leaves a store, a grant
		// and a live subscription behind.
		running = await startApp(new Application());
		const cart = resolveState(AsClass<Cart>(Cart), "session-a");
		cart.items = 3;
		grantRoom("session-a", AsClass(Party), "room-a");

		endSession("session-a");

		expect(hasRoom("session-a", "party", "room-a")).toBe(false);
		expect(resolveState(AsClass<Cart>(Cart), "session-a").items).toBe(0);
	});

	test("destroying a session through the manager does the same", async () => {
		const manager = new SessionManager({ cookieName: "SID", sweepInterval: 0 });
		new Router().get("/login", (ctx) => {
			ctx.session.Set("user", "aiko");
			ctx.joinRoom(AsClass<Party>(Party), "room-a");
			ctx.response.body = ctx.session.id;
		});
		running = await startApp(new Application({ sessions: manager }));

		const id = await (await running.fetch("/login")).text();
		expect(hasRoom(id, "party", "room-a")).toBe(true);

		await manager.destroy(id);
		expect(hasRoom(id, "party", "room-a")).toBe(false);
	});
});

describe("who is calling", () => {
	async function partyApp() {
		const manager = new SessionManager({ cookieName: "SID", sweepInterval: 0 });
		new Router().get("/join/:code", (ctx) => {
			ctx.session.Set("user", ctx.query.as ?? "someone");
			ctx.joinRoom(AsClass<Party>(Party), ctx.params.code ?? "");
			ctx.response.body = ctx.session.id;
		});
		return await startApp(new Application({ sessions: manager }));
	}

	async function joined(base: string, code: string, as: string) {
		const response = await fetch(`${base}/join/${code}?as=${as}`);
		const id = await response.text();
		const cookie = (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
		const client = open(base, { cookie });
		await client.ready;
		client.socket.send(JSON.stringify({ t: "hello", stores: [`party:${code}`] }));
		await client.next(1);
		return { id, client };
	}

	test("an action can tell one caller from another", async () => {
		// Without this a shared store has no authority: any member could seek
		// the room, because the action cannot see who asked.
		running = await partyApp();
		const alice = await joined(running.base, "room-a", "alice");
		const bob = await joined(running.base, "room-a", "bob");

		alice.client.socket.send(JSON.stringify({ t: "call", store: "party:room-a", method: "claim", args: [] }));
		await Bun.sleep(80);
		expect(resolveState(AsClass<Party>(Party), "room-a").host).toBe(alice.id);

		// Bob is in the room and may say so; he still may not take it over.
		bob.client.socket.send(JSON.stringify({ t: "call", store: "party:room-a", method: "claim", args: [] }));
		bob.client.socket.send(JSON.stringify({ t: "call", store: "party:room-a", method: "hostSeek", args: [600] }));
		await Bun.sleep(80);

		expect(resolveState(AsClass<Party>(Party), "room-a").host).toBe(alice.id);
		expect(resolveState(AsClass<Party>(Party), "room-a").at).toBe(0);

		alice.client.socket.send(JSON.stringify({ t: "call", store: "party:room-a", method: "hostSeek", args: [600] }));
		await Bun.sleep(80);
		expect(resolveState(AsClass<Party>(Party), "room-a").at).toBe(600);

		alice.client.socket.close();
		bob.client.socket.close();
	});

	test("an action can read the caller's session", async () => {
		running = await partyApp();
		const alice = await joined(running.base, "room-a", "alice");
		const bob = await joined(running.base, "room-a", "bob");

		alice.client.socket.send(JSON.stringify({ t: "call", store: "party:room-a", method: "say", args: ["hi"] }));
		await Bun.sleep(60);
		bob.client.socket.send(JSON.stringify({ t: "call", store: "party:room-a", method: "say", args: ["hello"] }));
		await Bun.sleep(80);

		// The name is the server's, from the session — never a field the
		// client put in the frame.
		expect(resolveState(AsClass<Party>(Party), "room-a").log).toEqual(["alice: hi", "bob: hello"]);

		alice.client.socket.close();
		bob.client.socket.close();
	});
});

describe("connection hooks", () => {
	test("an app is told when a live socket opens and closes", async () => {
		// Presence is the case: the socket is natsu's, so an app has no other
		// way to know who is on the other end of one.
		const seen: string[] = [];
		const manager = new SessionManager({ cookieName: "SID", sweepInterval: 0 });
		new Router().get("/login", (ctx) => {
			ctx.session.Set("user", "aiko");
			ctx.response.body = ctx.session.id;
		});
		running = await startApp(new Application({ sessions: manager }), {
			liveHooks: {
				open: (who) => seen.push(`open:${String(who.session?.Get("user"))}`),
				close: (who) => seen.push(`close:${String(who.session?.Get("user"))}`),
			},
		});

		const response = await running.fetch("/login");
		const cookie = (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
		const client = open(running.base, { cookie });
		await client.ready;
		await Bun.sleep(60);
		client.socket.close();
		await Bun.sleep(120);

		expect(seen).toEqual(["open:aiko", "close:aiko"]);
	});

	test("a hook that throws does not take the connection down", async () => {
		running = await startApp(new Application(), {
			liveHooks: {
				open() {
					throw new Error("nope");
				},
			},
		});
		const client = open(running.base);
		await client.ready;
		client.socket.send(JSON.stringify({ t: "hello", stores: ["room"] }));
		const frames = await client.next(1);

		expect(frames[0]?.t).toBe("sync");
		client.socket.close();
	});
});
