import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Application, Assets, Router, navigable } from "../index.ts";
import type { Context } from "../index.ts";
import { reset } from "./helpers.ts";

const PORT = Number(process.env.NATSU_E2E_PWA_PORT ?? 5921);
const ORIGIN = `http://127.0.0.1:${PORT}`;
let browser: any;
let missing = "";
let dir: string;
let app: Application | undefined;

const page = (title: string, nonce: string, assets: Assets) =>
	`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title><link rel="stylesheet" href="/site.css"></head>` +
	`<body><nav><a id="to-home" href="/">Home</a> <a id="to-about" href="/about">About</a> <a id="to-account" href="/account">Account</a></nav>` +
	`<main id="main" data-natsu-region><h1>${title}</h1><form id="f" method="post" action="/about"><button id="send">Send</button></form></main>` +
	`<script src="${assets.url("ver")}" nonce="${nonce}" defer data-natsu-once></script></body></html>`;

async function serve(version: string) {
	reset();
	writeFileSync(join(dir, "site.css"), "body{margin:0}h1{font-size:2em}");
	writeFileSync(join(dir, "ver.js"), `window.__version=${JSON.stringify(version)};`);
	const assets = new Assets({
		outDir: join(dir, `out-${version}`),
		styles: { site: [join(dir, "site.css")] },
		files: { ver: join(dir, "ver.js") },
		rewrite: { "/site.css": "site" },
		minify: true,
		navigate: true,
		pwa: {
			manifest: { name: "Shop", theme_color: "#0b1020", icons: [{ src: "/icon.png", sizes: "512x512" }] },
			offline: ["/", "/about"],
		},
	});
	const draw = (title: string) =>
		navigable((ctx: Context) => {
			const nonce = crypto.randomUUID().replaceAll("-", "");
			ctx.response.headers.set("content-security-policy", `script-src 'nonce-${nonce}' 'strict-dynamic'; object-src 'none'`);
			return page(title, nonce, assets);
		});
	const router = new Router();
	router.get("/", draw("Home"));
	router.get("/about", draw("About"));
	router.get("/account", draw("Account"));
	router.post("/about", draw("Sent"));
	await assets.build();
	const a = new Application();
	a.use(assets.middleware());
	await a.start({ port: PORT, hostname: "127.0.0.1", quiet: true });
	return a;
}

function playwright() {
	try {
		return require(`${execSync("npm root -g").toString().trim()}/playwright`);
	} catch (e) {
		missing = `Playwright not found (${(e as Error).message.split("\n")[0]})`;
	}
}

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), "natsu-pwa-e2e-"));
	app = await serve("one");
	const pw = playwright();
	if (!pw) return;
	try {
		browser = await pw.chromium.launch();
	} catch (e) {
		missing = `Chromium did not start (${(e as Error).message.split("\n")[0]})`;
	}
});

afterAll(async () => {
	await browser?.close();
	await app?.close(true);
	rmSync(dir, { recursive: true, force: true });
});

const e2e = (name: string, fn: () => Promise<void>) =>
	test(
		name,
		async () => {
			if (!browser) return void console.warn(`skipped: ${missing || "no browser"}`);
			await fn();
		},
		{ timeout: 30_000 },
	);

async function controlled() {
	const context = await browser.newContext();
	const tab = await context.newPage();
	tab.setDefaultTimeout(8_000);
	await tab.addInitScript(() => {
		const w = window as unknown as { __loads: number };
		w.__loads = (Number(sessionStorage.getItem("loads")) || 0) + 1;
		sessionStorage.setItem("loads", String(w.__loads));
	});
	await tab.goto(`${ORIGIN}/`);
	await tab.evaluate(() => navigator.serviceWorker.ready);
	await tab.reload();
	await tab.waitForFunction(() => navigator.serviceWorker.controller !== null);
	return { context, tab };
}

describe("pwa in Chromium", () => {
	e2e("installable: a manifest the browser reads and a worker that controls the page", async () => {
		const { context, tab } = await controlled();
		const manifest = await tab.evaluate(async () => (await fetch((document.querySelector('link[rel="manifest"]') as HTMLLinkElement).href)).json());
		expect(manifest.name).toBe("Shop");
		expect(manifest.display).toBe("standalone");
		expect(await tab.evaluate(() => navigator.serviceWorker.controller!.scriptURL)).toBe(`${ORIGIN}/sw.js`);
		await context.close();
	});

	e2e("offline: a listed page loads from the worker; any other visit shows the modal and stays", async () => {
		const { context, tab } = await controlled();
		await tab.click("#to-about");
		await tab.waitForFunction(() => document.title === "About");
		await tab.click("#to-home");
		await tab.waitForFunction(() => document.title === "Home");
		const loads = await tab.evaluate(() => (window as any).__loads);
		await context.setOffline(true);

		await tab.click("#to-account");
		await tab.waitForSelector("natsu-offline:not([hidden])");
		expect(await tab.evaluate(() => [document.title, location.pathname, (window as any).__loads])).toEqual(["Home", "/", loads]);
		expect(await tab.textContent("natsu-offline span")).toBe("This page needs a network connection.");

		await tab.click("natsu-offline button");
		await tab.waitForSelector("natsu-offline:not([hidden])");

		await tab.click("#send");
		await tab.waitForSelector("natsu-offline:not([hidden])");
		expect(await tab.evaluate(() => document.title)).toBe("Home");

		await tab.goto(`${ORIGIN}/about`);
		expect(await tab.evaluate(() => document.title)).toBe("About");
		const cold = await tab.goto(`${ORIGIN}/account`);
		expect(cold.status()).toBe(503);
		expect(await tab.textContent("p")).toBe("This page needs a network connection.");

		await context.setOffline(false);
		await tab.goto(`${ORIGIN}/account`);
		expect(await tab.evaluate(() => document.title)).toBe("Account");
		await context.close();
	});

	e2e("a deploy shows the update toast; Reload hands over to the new worker", async () => {
		const { context, tab } = await controlled();
		expect(await tab.evaluate(() => (window as any).__version)).toBe("one");
		await app!.close(true);
		app = await serve("two");
		await tab.evaluate(async () => (await navigator.serviceWorker.getRegistration())!.update());
		await tab.waitForSelector("natsu-toast:not([hidden])");
		const before = await tab.evaluate(() => (window as any).__loads);
		await tab.click("natsu-toast button");
		await tab.waitForFunction((n: number) => (window as any).__loads === n + 1, before);
		await tab.waitForFunction(() => (window as any).__version === "two");
		expect(await tab.isHidden("natsu-toast")).toBe(true);
		await context.close();
	});
});
