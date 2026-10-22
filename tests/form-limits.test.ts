import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Invalid, action, clearActions, inputOf, valuesOf } from "../src/pages/actions.ts";
import { clearSources } from "../src/pages/data.ts";
import { type PagesOptions, type PageSite, mountPages } from "../src/pages/mount.ts";
import { Application } from "../src/server.ts";
import { type RunningApp, reset, startApp } from "./helpers.ts";

let dir: string;
let running: RunningApp | undefined;
let site: PageSite | undefined;

beforeEach(() => {
	reset({ General: { logFormat: "", logLevel: "silent", url: "https://shop.test" } });
	clearSources();
	clearActions();
	dir = mkdtempSync(join(tmpdir(), "natsu-form-"));
});

afterEach(async () => {
	site?.close();
	site = undefined;
	await running?.stop();
	running = undefined;
	rmSync(dir, { recursive: true, force: true });
});

async function serve(options: Omit<PagesOptions, "dir"> = {}) {
	const full = join(dir, "pages", "index.uwu");
	mkdirSync(dirname(full), { recursive: true });
	writeFileSync(full, `<page><action go="x.go"></page><template><form @submit="action:go"><input name="a"></form></template>`);
	const app = new Application();
	site = await mountPages({ dir, app, ...options });
	running = await startApp(app);
	const first = await running.fetch("/");
	const cookie = first.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
	const token = /name="_csrf" value="([^"]+)"/.exec(await first.text())![1]!;
	const post = (fields: string) =>
		running!.fetch("/", {
			method: "POST",
			redirect: "manual",
			body: `_action=go&_csrf=${encodeURIComponent(token)}&${fields}`,
			headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
		});
	return { post };
}

describe("an action's post", () => {
	test("a repeated field is gathered in linear time", () => {
		const form = new FormData();
		for (let i = 0; i < 100_000; i++) form.append("a", String(i));
		const started = performance.now();
		const input = inputOf(form);
		expect(performance.now() - started).toBeLessThan(500);
		expect((input.a as string[]).length).toBe(100_000);
	});

	test("more fields than allowed is refused before the action runs", async () => {
		let ran = 0;
		action("x.go", () => void ran++, { public: true });
		const { post } = await serve();
		const started = performance.now();
		const refused = await post(Array(5000).fill("a=1").join("&"));
		expect(refused.status).toBe(413);
		expect(performance.now() - started).toBeLessThan(1500);
		expect(ran).toBe(0);
		expect((await post(Array(500).fill("a=1").join("&"))).status).toBe(303);
		expect(ran).toBe(1);
	});

	test("the limit is the app's to set", async () => {
		action("x.go", () => {}, { public: true });
		const { post } = await serve({ maxFields: 10 });
		expect((await post(Array(20).fill("a=1").join("&"))).status).toBe(413);
		expect((await post(Array(5).fill("a=1").join("&"))).status).toBe(303);
	});

	test("__proto__, constructor and repeated __proto__ fields are plain keys", async () => {
		let seen: Record<string, unknown> | undefined;
		action("x.go", ({ input }) => {
			seen = input;
			throw new Invalid({ a: "no" });
		}, { public: true });
		const { post } = await serve();
		await post("__proto__=1&__proto__=2&constructor=x&a=1");
		expect(Object.getPrototypeOf(seen)).toBeNull();
		expect(seen!.__proto__).toEqual(["1", "2"]);
		expect(({} as Record<string, unknown>)["1"]).toBeUndefined();
		const shown = valuesOf(inputOf(new URLSearchParams("__proto__=1&__proto__=2") as unknown as FormData));
		expect(Object.getPrototypeOf(shown)).toBeNull();
		expect(Object.keys(shown)).toEqual(["__proto__"]);
	});
});
