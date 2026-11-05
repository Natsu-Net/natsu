import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Context } from "../src/context.ts";
import { Application } from "../src/server.ts";
import { Router } from "../src/router.ts";
import { reset, startApp, type RunningApp } from "./helpers.ts";

let running: RunningApp | undefined;
let seen: { route?: string; controllerMs?: number; sessionMs?: number } | undefined;

beforeEach(() => {
	reset();
	seen = undefined;
});

afterEach(async () => {
	await running?.stop();
	running = undefined;
});

describe("request timings", () => {
	test("the route pattern and the controller time reach the context", async () => {
		const router = new Router();
		let held: Context | undefined;
		router.get("/t/:id", (ctx) => {
			held = ctx;
			ctx.response.body = "ok";
		});
		running = await startApp(new Application());
		const response = await running.fetch("/t/7");
		expect(await response.text()).toBe("ok");
		seen = held ? { route: held.route, controllerMs: held.timings.controllerMs } : undefined;
		expect(seen?.route).toBe("/t/:id");
		expect(typeof seen?.controllerMs).toBe("number");
	});

	test("a session cookie measures the session load", async () => {
		const router = new Router();
		router.get("/s", (ctx) => {
			seen = { sessionMs: ctx.timings.sessionMs };
			ctx.response.body = "ok";
		});
		running = await startApp(new Application());
		await running.fetch("/s", { headers: { cookie: "NATSU_SESSION=missing" } });
		expect(typeof seen?.sessionMs).toBe("number");
	});

	test("an unanswered path leaves the pattern unset", async () => {
		running = await startApp(new Application());
		const response = await running.fetch("/nowhere");
		expect(response.status).toBe(404);
	});
});
