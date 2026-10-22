import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { action, clearActions } from "../src/pages/actions.ts";
import { clearSources } from "../src/pages/data.ts";
import { type PageSite, mountPages } from "../src/pages/mount.ts";
import { Application } from "../src/server.ts";
import { type RunningApp, reset, startApp } from "./helpers.ts";

let dir: string;
let running: RunningApp | undefined;
let site: PageSite | undefined;

beforeEach(() => {
	reset({ General: { logFormat: "", logLevel: "silent" } });
	clearSources();
	clearActions();
	dir = mkdtempSync(join(tmpdir(), "natsu-csrf-rotate-"));
});

afterEach(async () => {
	site?.close();
	site = undefined;
	await running?.stop();
	running = undefined;
	rmSync(dir, { recursive: true, force: true });
});

function jarOf(headers: Headers, into: Map<string, string> = new Map()): Map<string, string> {
	for (const line of headers.getSetCookie()) {
		const [pair] = line.split(";");
		const cut = pair!.indexOf("=");
		into.set(pair!.slice(0, cut), pair!.slice(cut + 1));
	}
	return into;
}
const header = (jar: Map<string, string>) => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
const tokenIn = (html: string) => /name="_csrf" value="([^"]+)"/.exec(html)![1]!;

describe("the form token after a session changes inside an action", () => {
	test("a form drawn by the action that rotated the session posts again", async () => {
		action("login", async ({ ctx }) => {
			await ctx.sessions!.rotate(ctx);
			return { show: { code: "abc" } };
		}, { auth: "anonymous" });
		action("next", () => ({ flash: "ok" }), { auth: "anonymous" });
		mkdirSync(join(dir, "pages"), { recursive: true });
		writeFileSync(join(dir, "pages", "index.uwu"), `<page><action login="login">\n<action next="next"></page><template><form @submit="action:login"><button>a</button></form><form @submit="action:next"><button>b</button></form></template>`);
		const app = new Application();
		site = await mountPages({ dir, app });
		running = await startApp(app);

		const first = await running.fetch("/");
		const jar = jarOf(first.headers);
		const post = (action: string, token: string) =>
			running!.fetch("/", { method: "POST", redirect: "manual", headers: { cookie: header(jar) }, body: new URLSearchParams({ _action: action, _csrf: token }) });

		const login = await post("login", tokenIn(await first.text()));
		expect(login.status).toBe(200);
		jarOf(login.headers, jar);
		const next = await post("next", tokenIn(await login.text()));
		expect(next.status).toBe(303);
	});
});
