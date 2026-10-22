import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearActions } from "../src/pages/actions.ts";
import { clearSources, source } from "../src/pages/data.ts";
import { type PageSite, mountPages } from "../src/pages/mount.ts";
import { Application } from "../src/server.ts";
import { type RunningApp, reset, startApp } from "./helpers.ts";

let dir: string;
let running: RunningApp | undefined;
let site: PageSite | undefined;

beforeEach(() => {
	reset({ General: { logFormat: "", logLevel: "silent", url: "https://shop.test" } });
	clearSources();
	clearActions();
	dir = mkdtempSync(join(tmpdir(), "natsu-kept-"));
});

afterEach(async () => {
	site?.close();
	site = undefined;
	await running?.stop();
	running = undefined;
	rmSync(dir, { recursive: true, force: true });
});

describe("the tags kept pages are remembered by", () => {
	test("are bounded, and a page whose tag is forgotten is drawn again", async () => {
		let draws = 0;
		source("hit", () => ({ n: ++draws }), { tags: ({ query }) => [`hit:${query.q}`] });
		mkdirSync(join(dir, "pages"), { recursive: true });
		writeFileSync(join(dir, "pages", "index.uwu"), "<template><p>{{hit.n}}</p></template>");
		const app = new Application();
		site = await mountPages({ dir, app, cache: { fresh: 600 }, maxKeptTags: 4 });
		running = await startApp(app);
		for (let q = 1; q <= 12; q++) await running.fetch(`/?q=${q}`);
		expect(draws).toBe(12);
		await running.fetch("/?q=12");
		expect(draws).toBe(12);
		await running.fetch("/?q=1");
		expect(draws).toBe(13);
	});
});
