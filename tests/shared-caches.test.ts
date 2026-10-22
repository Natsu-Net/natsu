import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Router } from "../src/router.ts";
import { Application } from "../src/server.ts";
import { reset, startApp, tempDir, type RunningApp } from "./helpers.ts";

const dir = tempDir("natsu-shared-");
let running: RunningApp;
let sessionCookie: string;

beforeAll(async () => {
	const root = join(dir.path, "public");
	mkdirSync(root, { recursive: true });
	writeFileSync(join(root, "app.js"), "console.log(1)");
	reset({ Static: { enabled: true, root } });
	new Router().get("/shared", (ctx) => {
		ctx.response.headers.set("cache-control", "public, max-age=60, s-maxage=600, immutable");
		return "shared";
	});
	new Router().get("/plain", () => "plain");
	const app = new Application();
	const session = app.sessions!.create();
	session.Set("a", 1);
	await app.sessions!.persist(session);
	sessionCookie = `${app.sessions!.cookieName}=${session.id}`;
	running = await startApp(app);
});

afterAll(async () => {
	await running.stop();
	dir.cleanup();
});

describe("a response that sets a cookie is never public", () => {
	test("a static file asked for with a session cookie is private, and keeps its max-age", async () => {
		const answer = await running.fetch("/app.js", { headers: { cookie: sessionCookie } });
		expect(answer.headers.getSetCookie().length).toBe(1);
		expect(answer.headers.get("cache-control")).toBe("private, max-age=18000");
	});

	test("the same file asked for without one stays public", async () => {
		const answer = await running.fetch("/app.js");
		expect(answer.headers.getSetCookie().length).toBe(0);
		expect(answer.headers.get("cache-control")).toBe("public, max-age=18000");
	});

	test("s-maxage goes, the rest of the directives stay", async () => {
		const answer = await running.fetch("/shared", { headers: { cookie: sessionCookie } });
		expect(answer.headers.get("cache-control")).toBe("private, max-age=60, immutable");
		const bare = await running.fetch("/shared");
		expect(bare.headers.get("cache-control")).toBe("public, max-age=60, s-maxage=600, immutable");
	});

	test("static files say nosniff", async () => {
		expect((await running.fetch("/app.js")).headers.get("x-content-type-options")).toBe("nosniff");
	});
});

describe("a Host that is not a host", () => {
	async function withHost(host: string, path: string): Promise<string> {
		const url = new URL(running.base);
		return await new Promise<string>((resolve) => {
			let received = "";
			const timer = setTimeout(() => resolve(received), 1500);
			void Bun.connect({
				hostname: url.hostname,
				port: Number(url.port),
				socket: {
					open: (socket) => void socket.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`),
					data: (_socket, chunk) => void (received += chunk.toString()),
					close: () => {
						clearTimeout(timer);
						resolve(received);
					},
				},
			});
		});
	}

	test("is a 400 on a path no route has, and the route still answers", async () => {
		expect((await withHost("<red>x", "/nowhere")).startsWith("HTTP/1.1 400")).toBe(true);
		expect((await withHost("<red>x", "/plain")).startsWith("HTTP/1.1 200")).toBe(true);
		expect((await withHost("ok.test", "/nowhere")).startsWith("HTTP/1.1 404")).toBe(true);
	});
});
