import { afterEach, describe, expect, test } from "bun:test";
import { resetLive } from "../src/live.ts";
import { Application } from "../src/server.ts";
import { reset, startApp, type RunningApp } from "./helpers.ts";

let running: RunningApp | undefined;
afterEach(async () => {
	await running?.stop();
	resetLive();
	running = undefined;
});

describe("a socket upgrade racing the end of its session", () => {
	test("is not bound to a session destroyed while the handshake waited", async () => {
		reset();
		const app = new Application();
		const seen: string[] = [];
		running = await startApp(app, { liveHooks: { open: (who) => void seen.push(who.sessionId) } });
		const sessions = app.sessions!;
		const session = sessions.create();
		session.Set("k", "v");
		await sessions.persist(session);
		const real = sessions.get.bind(sessions);
		sessions.get = async (id) => {
			const found = await real(id);
			await sessions.destroy(id);
			return found;
		};
		const ws = new WebSocket(`${running.base.replace("http", "ws")}/_uwu/socket`, { headers: { cookie: `${sessions.cookieName}=${session.id}` } } as never);
		await new Promise((resolve) => (ws.onopen = resolve));
		await Bun.sleep(30);
		ws.close();
		expect(seen).toEqual([""]);
	});
});
