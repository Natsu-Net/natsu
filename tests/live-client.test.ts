/**
 * The browser half of the live link, against a real server and a real socket.
 *
 * `live()` reads `location` only to build its default URL, so each test hands
 * it the URL instead; Bun's own WebSocket stands in for the browser's.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Application } from "../src/server.ts";
import { resetLive } from "../src/live.ts";
import { Action, Networked, State, resetState, resolveState, type StateClass } from "../src/state.ts";
import { live, type LiveConnection } from "../src/client/live.ts";
import { reset, startApp, type RunningApp } from "./helpers.ts";

@State("counter", { scope: "global" })
class Counter {
	@Networked() online = 0;
	@Networked({ writable: true }) topic = "hello";
	@Networked() people: Array<{ name: string }> = [];

	@Action()
	bump(by = 1) {
		this.online += by;
	}
}

const AsClass = <T extends object>(c: unknown) => c as StateClass<T>;

let running: RunningApp | undefined;
let link: LiveConnection | undefined;

beforeEach(() => {
	reset();
	resetState();
	resetLive();
});

afterEach(async () => {
	link?.close();
	link = undefined;
	await running?.stop();
	running = undefined;
	resetLive();
});

async function until(check: () => boolean, timeout = 2000): Promise<void> {
	const deadline = Date.now() + timeout;
	while (!check() && Date.now() < deadline) await Bun.sleep(5);
	expect(check()).toBe(true);
}

function connect(): LiveConnection {
	return (link = live({ url: `${running!.base.replace("http", "ws")}/_uwu/socket`, stores: ["counter"] }));
}

describe("live()", () => {
	test("holds a store whole after hello, then follows patches", async () => {
		running = await startApp(new Application());
		const seen: string[][] = [];
		const client = connect();
		client.on("counter", (_value, paths) => seen.push(paths));

		await until(() => client.stores.counter?.topic === "hello");
		expect(client.status).toBe("open");
		expect(seen[0]).toEqual(["*"]);

		const counter = resolveState(AsClass<Counter>(Counter), "");
		counter.online = 7;
		counter.people = [{ name: "a" }, { name: "b" }];
		await until(() => client.stores.counter?.online === 7);
		await until(() => (client.stores.counter?.people as unknown[] | undefined)?.length === 2);
		expect(seen.flat()).toContain("online");
	});

	test("calls an action and writes a writable field", async () => {
		running = await startApp(new Application());
		const client = connect();
		await until(() => client.status === "open");

		client.call("counter", "bump", 3);
		client.set("counter", "topic", "changed");
		const counter = resolveState(AsClass<Counter>(Counter), "");
		await until(() => counter.online === 3 && counter.topic === "changed");
		await until(() => client.stores.counter?.online === 3);
	});

	test("a store the page does not hold is ignored", async () => {
		running = await startApp(new Application());
		const client = live({ url: `${running.base.replace("http", "ws")}/_uwu/socket`, stores: [] });
		link = client;
		await until(() => client.status === "open");
		resolveState(AsClass<Counter>(Counter), "").online = 2;
		await Bun.sleep(50);
		expect(Object.keys(client.stores)).toEqual([]);
	});

	test("close stops it for good", async () => {
		running = await startApp(new Application());
		const statuses: string[] = [];
		const client = (link = live({ url: `${running.base.replace("http", "ws")}/_uwu/socket`, stores: ["counter"], onStatus: (s) => statuses.push(s) }));
		await until(() => client.status === "open");
		client.close();
		expect(client.status).toBe("closed");
		await Bun.sleep(50);
		expect(statuses).toEqual(["open", "closed"]);
	});
});
