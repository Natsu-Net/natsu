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
import { resetLive } from "../src/live.ts";
import { Action, Networked, State, resetState, resolveState, type StateClass } from "../src/state.ts";
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
function open(base: string): {
	socket: WebSocket;
	ready: Promise<void>;
	frames: Array<Record<string, unknown>>;
	next(want: number, timeout?: number): Promise<Array<Record<string, unknown>>>;
} {
	const socket = new WebSocket(`${base.replace("http", "ws")}/_uwu/socket`);
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
		expect((client.frames[1] as { patches: Array<{ value: unknown }> }).patches).toEqual([{ path: "online", value: 3 }]);
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
