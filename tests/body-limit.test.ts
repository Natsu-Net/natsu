import { afterEach, describe, expect, test } from "bun:test";
import { Router } from "../src/router.ts";
import { Application } from "../src/server.ts";
import { reset, startApp, type RunningApp } from "./helpers.ts";

let running: RunningApp | undefined;
afterEach(async () => {
	await running?.stop();
	running = undefined;
});

async function boot(limit: number) {
	reset({ General: { maxRequestBodySize: limit } });
	new Router().post("/echo", async (ctx) => {
		const body = await ctx.request.text();
		return String(body.length);
	});
	running = await startApp(new Application());
	return new URL(running.base);
}

function chunked(url: URL, total: number): Promise<string> {
	return new Promise((resolve) => {
		let received = "";
		const done = () => resolve(received);
		Bun.connect({
			hostname: url.hostname,
			port: Number(url.port),
			socket: {
				open(socket) {
					socket.write(`POST /echo HTTP/1.1\r\nHost: ${url.host}\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n`);
					const chunk = "a".repeat(1024);
					for (let sent = 0; sent < total; sent += chunk.length) socket.write(`${chunk.length.toString(16)}\r\n${chunk}\r\n`);
					socket.write("0\r\n\r\n");
				},
				data(_socket, data) {
					received += data.toString();
				},
				close: done,
				error: done,
			},
		}).catch(done);
		setTimeout(done, 3000);
	});
}

describe("request body limit on every route", () => {
	test("a declared length over the limit is refused", async () => {
		await boot(10_000);
		const answer = await running!.fetch("/echo", { method: "POST", body: "x".repeat(20_000) });
		expect(answer.status).toBe(413);
	});

	test("a body under the limit goes through", async () => {
		await boot(10_000);
		const answer = await running!.fetch("/echo", { method: "POST", body: "x".repeat(5_000) });
		expect(await answer.text()).toBe("5000");
	});

	test("a chunked body is held to the limit while it streams in", async () => {
		const url = await boot(10_000);
		const raw = await chunked(url, 200_000);
		expect(raw).toContain("413");
	});

	test("the default limit is explicit and finite", async () => {
		reset();
		const { config } = await import("../src/config.ts");
		expect(config.General.maxRequestBodySize).toBeGreaterThan(0);
		expect(config.General.maxRequestBodySize).toBeLessThan(128 * 1024 * 1024);
	});
});
