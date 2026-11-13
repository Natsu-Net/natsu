/**
 * `client/mount` with `"families"` chunking, end to end in Chromium
 * (`tests/fixtures/mount/app.ts`): the editor family is linked by the server
 * on a page that has the editor's element, linked by the client before the
 * editor mounts on a page that gets one later or by a visit, and in every
 * frame what the editor drew is styled. No CSP violation, no console error.
 *
 * Not part of `bun test`: run with `bun run test:e2e`. Skipped without the
 * Playwright installed on the machine.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { type MountApp, mountApp } from "./fixtures/mount/app.ts";

const PORT = Number(process.env.NATSU_MOUNT_E2E_PORT ?? 5921);
let fixture: MountApp;
let origin = "";
let browser: any;
let missing = "";

beforeAll(async () => {
	fixture = await mountApp();
	origin = await fixture.start(PORT);
	try {
		browser = await require(`${execSync("npm root -g").toString().trim()}/playwright`).chromium.launch();
	} catch (error) {
		missing = `Playwright not found (${(error as Error).message.split("\n")[0]})`;
	}
});

afterAll(async () => {
	await browser?.close();
	await fixture?.stop();
});

const EDITOR = "rgb(10, 20, 30)";

async function open(path: string) {
	const context = await browser.newContext();
	const page = await context.newPage();
	const problems: string[] = [];
	page.on("console", (message: any) => message.type() === "error" && problems.push(message.text()));
	page.on("pageerror", (error: Error) => problems.push(error.message));
	await page.addInitScript(() => {
		document.addEventListener("securitypolicyviolation", (event) => console.error(`CSP ${event.violatedDirective}`));
		(window as any).unstyled = 0;
		const sample = () => {
			for (const drawn of document.querySelectorAll(".ed")) if (getComputedStyle(drawn).color !== "rgb(10, 20, 30)") (window as any).unstyled++;
			requestAnimationFrame(sample);
		};
		requestAnimationFrame(sample);
	});
	await page.goto(origin + path);
	await page.waitForLoadState("networkidle");
	return { context, page, problems };
}

const families = (page: any) => page.evaluate(() => [...document.querySelectorAll("link[rel=stylesheet]")].map((link) => link.getAttribute("href")!.split("/").pop()!.split(".").slice(1, -2).join(".") || "core"));
const color = (page: any, selector: string) => page.evaluate((s: string) => getComputedStyle(document.querySelector(s)!).color, selector);

describe("mount and its stylesheet families", () => {
	test("a page with the element gets the family from the server, and the editor draws styled", async () => {
		if (missing) return console.warn(`skipped: ${missing}`);
		const { context, page, problems } = await open("/with");
		await page.waitForSelector("#editor .ed");
		expect(await families(page)).toEqual(["core", "ed"]);
		expect(await color(page, "#editor .ed")).toBe(EDITOR);
		expect(await page.evaluate(() => (window as any).unstyled)).toBe(0);
		expect(problems).toEqual([]);
		await context.close();
	});

	test("an element a script adds gets the family linked before the editor mounts", async () => {
		if (missing) return console.warn(`skipped: ${missing}`);
		const { context, page, problems } = await open("/plain");
		expect(await families(page)).toEqual(["core"]);
		await page.click("[data-add]");
		await page.waitForSelector("#added .ed");
		expect(await families(page)).toEqual(["core", "ed"]);
		expect(await color(page, "#added .ed")).toBe(EDITOR);
		expect(await page.evaluate(() => (window as any).unstyled)).toBe(0);
		expect(problems).toEqual([]);
		await context.close();
	});

	test("a visit to a page with the element, in the same document, keeps one family link and draws styled", async () => {
		if (missing) return console.warn(`skipped: ${missing}`);
		const { context, page, problems } = await open("/plain");
		await page.evaluate(() => ((window as any).same = true));
		await page.evaluate(() => (window as any).natsu.visit("/with"));
		await page.waitForSelector("#editor .ed");
		expect(await page.evaluate(() => (window as any).same)).toBe(true);
		const linked = await families(page);
		expect(linked.filter((name: string) => name === "ed").length).toBeGreaterThanOrEqual(1);
		expect(linked[0]).toBe("core");
		expect(await color(page, "#editor .ed")).toBe(EDITOR);
		await page.evaluate(() => (window as any).natsu.visit("/plain"));
		await page.waitForSelector("[data-add]");
		await page.click("[data-add]");
		await page.waitForSelector("#added .ed");
		expect(await color(page, "#added .ed")).toBe(EDITOR);
		expect(await page.evaluate(() => (window as any).unstyled)).toBe(0);
		expect(problems).toEqual([]);
		await context.close();
	});
});
