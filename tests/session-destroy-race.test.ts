import { afterEach, describe, expect, test } from "bun:test";
import { Router } from "../src/router.ts";
import { reset, startApp, type RunningApp } from "./helpers.ts";
import { Application } from "../src/server.ts";

let running: RunningApp | undefined;
afterEach(async () => {
	await running?.stop();
	running = undefined;
});

async function boot() {
	reset();
	const r = new Router();
	let release: () => void = () => {};
	const gate = new Promise<void>((resolve) => (release = resolve));
	r.get("/login", (ctx) => {
		ctx.session.Set("user", "ann");
		ctx.response.body = "ok";
	});
	r.get("/slow", async (ctx) => {
		ctx.session.Set("touched", 1);
		await gate;
		ctx.response.body = "slow";
	});
	r.get("/logout", async (ctx) => {
		await ctx.sessions!.destroy(ctx.session.id);
		ctx.response.body = "out";
	});
	r.get("/rotate", async (ctx) => {
		await ctx.sessions!.rotate(ctx);
		ctx.response.body = "rotated";
	});
	const app = new Application();
	running = await startApp(app);
	const login = await running.fetch("/login");
	const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
	const id = decodeURIComponent(cookie.split("=")[1]!);
	return { app, cookie, id, release };
}

describe("a destroyed session stays destroyed", () => {
	test("a request already in flight does not write it back after logout", async () => {
		const { app, cookie, id, release } = await boot();
		const slow = running!.fetch("/slow", { headers: { cookie } });
		await Bun.sleep(50);
		await running!.fetch("/logout", { headers: { cookie } });
		release();
		await (await slow).text();
		expect(await app.sessions!.adapter.load(id)).toBeUndefined();
		const again = await running!.fetch("/slow", { headers: { cookie } });
		expect(again.headers.get("set-cookie")).not.toContain(id);
	});

	test("a request already in flight does not revive the old id after rotate", async () => {
		const { app, cookie, id, release } = await boot();
		const slow = running!.fetch("/slow", { headers: { cookie } });
		await Bun.sleep(50);
		await running!.fetch("/rotate", { headers: { cookie } });
		release();
		await (await slow).text();
		expect(await app.sessions!.adapter.load(id)).toBeUndefined();
		expect(await app.sessions!.get(id)).toBeUndefined();
	});
});
