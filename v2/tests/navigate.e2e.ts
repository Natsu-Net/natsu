/**
 * Page switching end to end: natsu's server step and its client runtime,
 * together, in a real browser (Chromium through the Playwright installed on
 * the machine; nothing is installed for it).
 *
 * Not part of `bun test`: its name does not match the test pattern. Run it
 * with `bun run test:e2e`. It needs Playwright's Chromium; without one the
 * suite is skipped, saying so. The port is 5920 unless `NATSU_E2E_PORT`
 * says otherwise; `NATSU_E2E_DEV=1` runs the app in development, so the
 * runtime it builds is the readable one with its console lines.
 *
 * The server is a real natsu app (`tests/fixtures/navigate/app.ts`):
 * `Application`, `Router`, `Assets` with `navigate: true` building the
 * runtime and cutting every page's stylesheet chunk, `PageCache` keeping the
 * pages everyone sees alike, `compress()`, and a CSP with a fresh nonce and
 * `'strict-dynamic'` on every page. So what is checked here is the whole
 * path: the key natsu writes into a page, the header the runtime sends back,
 * the part or the refusal natsu answers, and what the runtime does with it.
 *
 * The pages' stylesheets are cut from one source in source order, as Assets
 * cuts them. A chunk that lacks a rule the current page uses, but repeats an
 * earlier rule competing with it (`.hidden` against `.lg:grid`, or against
 * `.md:flex` for a region-only chunk), hides that element if it lands after
 * the old sheet; the runtime inserts it before, so the old sheet keeps
 * winning until the swap removes it.
 *
 * The last test measures: bytes on the wire for a full load and a part of
 * the same page, the time a full load and a soft visit take in the browser
 * (a click at once, and a click after the pointer rested on the link), and
 * the server's time for each. It prints them; it asserts only that the part
 * is smaller.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { FONT, MAIN_A, type NavigateApp, navigateApp } from "./fixtures/navigate/app.ts";

const PORT = Number(process.env.NATSU_E2E_PORT ?? 5920);
let ORIGIN = "";
let fixture: NavigateApp;

/** Playwright is loaded at run time from the global install, so it has no types here. */
let browser: any;
let missing = "";
/** Whether the browser running is the full Chromium; the headless shell never uses the back/forward cache. */
let full = false;

function playwright() {
	try {
		return require(`${execSync("npm root -g").toString().trim()}/playwright`);
	} catch (e) {
		missing = `Playwright not found (${(e as Error).message.split("\n")[0]})`;
	}
}

beforeAll(async () => {
	// NATSU_E2E_DEV=1 runs the app in development: the runtime readable, with its console lines.
	fixture = await navigateApp({ development: process.env.NATSU_E2E_DEV === "1" });
	ORIGIN = await fixture.start(PORT);
	const pw = playwright();
	if (!pw) return;
	// The full Chromium (new headless) first, with the back/forward cache on as
	// in real browsers (Playwright turns it off by default); then the
	// headless shell; then the machine's own copy.
	const keep = { ignoreDefaultArgs: ["--disable-back-forward-cache"] };
	const tries: [object, boolean][] = [
		[{ ...keep, channel: "chromium" }, true],
		[keep, false],
		[{ ...keep, executablePath: "/opt/pw-browsers/chromium" }, true],
	];
	for (const [options, isFull] of tries) {
		try {
			browser = await pw.chromium.launch(options);
			full = isFull;
			return;
		} catch (e) {
			missing = `Chromium did not start (${(e as Error).message.split("\n")[0]})`;
		}
	}
});

afterAll(async () => {
	await browser?.close();
	await fixture?.stop();
});

// --- helpers ---------------------------------------------------------------------

/** A desktop-sized page, as `visitor`, that records CSP violations and real loads. */
async function open(path: string, visitor = "anon") {
	const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
	await context.addCookies([{ name: "visitor", value: visitor, url: ORIGIN }]);
	const page = await context.newPage();
	// Well inside the test's own timeout: a step that hangs fails with Playwright's
	// account of it, rather than bun ending the test and the browser with it.
	page.setDefaultTimeout(8_000);
	await page.addInitScript(() => {
		const w = window as unknown as { __csp: string[]; __loads: number; __restored: boolean };
		w.__csp = [];
		addEventListener("pageshow", (e) => (w.__restored = (e as PageTransitionEvent).persisted));
		w.__loads = (Number(sessionStorage.getItem("loads")) || 0) + 1;
		sessionStorage.setItem("loads", String(w.__loads));
		document.addEventListener("securitypolicyviolation", (e) => w.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
	});
	await page.goto(ORIGIN + path);
	await page.waitForFunction(() => document.readyState === "complete");
	return page;
}

const h1 = (page: { textContent(sel: string): Promise<string> }) => page.textContent("main h1");
const loads = (page: any): Promise<number> => page.evaluate(() => (window as any).__loads);
const title = (page: any, text: string) => page.waitForFunction((t: string) => document.title === t, text);

async function scrollTo(page: any, y: number) {
	await page.evaluate(
		(y: number) =>
			new Promise<void>((done) => {
				addEventListener("scroll", () => requestAnimationFrame(() => done()), { once: true });
				scrollTo(0, y);
			}),
		y,
	);
}

/** The stylesheet a full load of `path` links, as natsu cuts it. */
async function sheetOf(path: string): Promise<string> {
	const html = await (await fetch(ORIGIN + path)).text();
	return /<link rel="stylesheet" href="([^"]+)"/.exec(html)?.[1] ?? "";
}

/** What the server saw from `from` on, for one path: [answer, how the browser asked]. */
const asked = (from: number, path: string) =>
	fixture.seen.slice(from).filter((s) => s.path === path).map((s) => [s.answer, s.mode === "navigate" ? "load" : s.prefetch ? "prefetch" : "fetch"]);

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;

const e2e = (name: string, fn: () => Promise<void>, timeout = 30_000) =>
	test(
		name,
		async () => {
			if (!browser) {
				console.warn(`skipped: ${missing || "no browser"}`);
				return;
			}
			await fn();
		},
		{ timeout },
	);

// --- the suite ---------------------------------------------------------------------

describe("page switching in Chromium, against a natsu app", () => {
	e2e("a soft visit swaps only the regions, and links the chunk a full load of that page links", async () => {
		const page = await open("/a");
		const from = fixture.seen.length;
		await page.evaluate(() => {
			const w = window as any;
			w.__hdr = document.getElementById("hdr");
			w.__main = document.getElementById("main");
			w.__foot = document.getElementById("foot");
		});
		await page.click("#to-b");
		await title(page, "B");
		await page.waitForFunction(() => document.body.dataset.bOnly === "ran");
		// One request for page B, and it was the runtime's: a part.
		expect(asked(from, "/b")).toEqual([["part", "fetch"]]);
		const kept = await page.evaluate(() => {
			const w = window as any;
			return {
				header: document.getElementById("hdr") === w.__hdr,
				main: document.getElementById("main") === w.__main,
				footer: document.getElementById("foot") === w.__foot,
				foot: document.getElementById("foot")!.textContent,
				nav: getComputedStyle(document.getElementById("nav")!).display,
				sheets: [...document.querySelectorAll('link[rel="stylesheet"]')].map((l) => l.getAttribute("href")),
			};
		});
		expect(kept).toEqual({ header: true, main: false, footer: false, foot: "footer B", nav: "flex", sheets: [await sheetOf("/b")] });
		expect(kept.sheets[0]).not.toBe(await sheetOf("/a"));
		expect(await h1(page)).toBe("Page B");
		expect(await loads(page)).toBe(1);
		await page.context().close();
	});

	e2e("scripts the runtime creates run under 'strict-dynamic', carrying the boot nonce", async () => {
		const page = await open("/a");
		await page.click("#to-b");
		await page.waitForFunction(() => document.body.dataset.bOnly === "ran");
		expect(await h1(page)).toBe("Page B");
		const nonces = await page.evaluate(() => {
			const boot = (document.querySelector('script[src*="/natsu-navigate."]') as HTMLScriptElement).nonce;
			const added = document.querySelector('script[src*="/b-only."]') as HTMLScriptElement;
			return { boot, added: added.nonce, async: added.async };
		});
		expect(nonces.boot.length).toBe(32);
		expect(nonces.added).toBe(nonces.boot);
		expect(nonces.async).toBe(false);
		// No script was refused.
		expect(await page.evaluate(() => (window as any).__csp.filter((v: string) => v.startsWith("script-src")))).toEqual([]);
		expect(await loads(page)).toBe(1);
		await page.context().close();
	});

	e2e("under a nonce without 'strict-dynamic', the boot nonce is what lets those scripts run", async () => {
		fixture.state.strict = false;
		try {
			const page = await open("/a");
			await page.click("#to-b");
			await page.waitForFunction(() => document.body.dataset.bOnly === "ran");
			expect(await page.evaluate(() => (window as any).__csp.filter((v: string) => v.startsWith("script-src")))).toEqual([]);
			// The policy is live: a created script without the nonce is refused.
			const legacy = /src="(\/_a\/legacy\.[^"]+)"/.exec(await (await fetch(`${ORIGIN}/legacy`)).text())?.[1];
			await page.evaluate((src: string) => {
				const s = document.createElement("script");
				s.src = src;
				document.body.append(s);
			}, legacy);
			await page.waitForFunction(() => (window as any).__csp.some((v: string) => v.startsWith("script-src")));
			expect(await page.evaluate(() => (window as any).__legacy)).toBeUndefined();
			expect(await loads(page)).toBe(1);
			await page.context().close();
		} finally {
			fixture.state.strict = true;
		}
	});

	e2e("the header's hidden md:flex nav stays visible through a stylesheet swap at desktop width", async () => {
		const page = await open("/a");
		// The hazard is real with natsu's own chunks: the chunk cut for page A's
		// regions alone repeats `.hidden` without the header's `.md:flex`, and
		// hides the nav when it comes after the page's sheet, not before.
		const regionsOnly = fixture.assets.pageStyle("site", `<main id="main" data-natsu-region>${MAIN_A}</main><footer id="foot" data-natsu-region class="foot">footer A</footer>`);
		const order = (where: "before" | "after") =>
			page.evaluate(
				([where, href]: string[]) =>
					new Promise<string>((done) => {
						const old = document.querySelector('link[rel="stylesheet"]')!;
						const l = document.createElement("link");
						l.rel = "stylesheet";
						l.href = href!;
						l.onload = () => {
							const d = getComputedStyle(document.getElementById("nav")!).display;
							l.remove();
							done(d);
						};
						if (where == "before") old.before(l);
						else old.after(l);
					}),
				[where, regionsOnly],
			);
		expect(await order("after")).toBe("none");
		expect(await order("before")).toBe("flex");
		fixture.state.cssDelay = 400;
		try {
			// Sample every frame, every head change and every load event (the
			// moment the new sheet applies, before the swap): the nav must be
			// flex throughout, and page A's `hidden lg:grid` element, whose rule
			// page B's chunk lacks, grid for as long as it is on screen.
			await page.evaluate(() => {
				const w = window as unknown as { __display: string[]; __stop: boolean };
				w.__display = [];
				const nav = document.getElementById("nav")!;
				const wide = document.getElementById("wide")!;
				const sample = () => {
					w.__display.push(`nav ${getComputedStyle(nav).display}`);
					if (wide.isConnected) w.__display.push(`wide ${getComputedStyle(wide).display}`);
				};
				new MutationObserver(sample).observe(document.head, { childList: true });
				document.addEventListener("load", sample, true);
				const frame = () => {
					sample();
					if (!w.__stop) requestAnimationFrame(frame);
				};
				frame();
			});
			await page.click("#to-b");
			await page.waitForFunction(() => document.querySelector("main h1")?.textContent === "Page B");
			await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
			const display: string[] = await page.evaluate(() => ((window as any).__stop = true) && (window as any).__display);
			expect(display.length).toBeGreaterThan(20); // frames sampled while the new sheet loaded
			expect([...new Set(display)].sort()).toEqual(["nav flex", "wide grid"]);
		} finally {
			fixture.state.cssDelay = 0;
		}
		const sheets = await page.evaluate(() => [...document.querySelectorAll('link[rel="stylesheet"]')].map((l) => l.getAttribute("href")));
		expect(sheets).toEqual([await sheetOf("/b")]);
		expect(await page.evaluate(() => getComputedStyle(document.querySelector("main h1")!).color)).toBe("rgb(200, 0, 0)");
		await page.context().close();
	});

	e2e("back and forward restore scroll both ways; focus and the announcement follow", async () => {
		const page = await open("/a");
		await scrollTo(page, 1200);
		await page.click("#to-b");
		await title(page, "B");
		expect(await page.evaluate(() => scrollY)).toBe(0);
		expect(await page.evaluate(() => document.activeElement?.textContent)).toBe("Page B");
		expect(await page.textContent('[role="status"]')).toBe("B");
		await scrollTo(page, 2000);
		await page.goBack();
		await title(page, "A");
		expect(await h1(page)).toBe("Page A");
		expect(await page.evaluate(() => scrollY)).toBe(1200);
		await page.goForward();
		await title(page, "B");
		expect(await page.evaluate(() => scrollY)).toBe(2000);
		expect(await loads(page)).toBe(1);
		await page.context().close();
	});

	e2e("a hash link's entry, then a visit, then Back shows the right page", async () => {
		const page = await open("/a");
		const shown = await page.evaluate(() => history.state.natsu.p);
		await page.click("#jump");
		await page.waitForFunction(() => location.hash === "#results");
		// The browser made the entry with no state; the runtime marks it as the same page.
		expect(await page.evaluate(() => history.state.natsu.p)).toBe(shown);
		const y = await page.evaluate(() => scrollY);
		expect(y).toBeGreaterThan(4000);
		await page.click("#to-b");
		await title(page, "B");
		await page.goBack();
		await title(page, "A");
		expect(await page.evaluate(() => location.pathname + location.hash)).toBe("/a#results");
		expect(await h1(page)).toBe("Page A");
		expect(await page.evaluate(() => scrollY)).toBe(y);
		await page.goBack();
		await page.waitForFunction(() => location.hash === "");
		expect(await h1(page)).toBe("Page A");
		expect(await loads(page)).toBe(1);
		await page.context().close();
	});

	e2e("Back pressed while the new page's script still loads stays a swap; the script counts once it has run", async () => {
		const page = await open("/a");
		let release!: () => void;
		const held = new Promise<void>((y) => (release = y));
		await page.route(/b-only/, async (r: any) => {
			await held;
			await r.continue();
		});
		await page.click("#to-b");
		await title(page, "B");
		await page.goBack();
		await title(page, "A");
		expect(await h1(page)).toBe("Page A");
		expect(await loads(page)).toBe(1);
		release();
		await page.waitForFunction(() => document.body.dataset.bOnly === "ran");
		// It called mount when it ran: the next visit is a swap too, and it is not created again.
		await page.click("#to-b");
		await title(page, "B");
		expect(await h1(page)).toBe("Page B");
		expect(await page.evaluate(() => document.querySelectorAll("script[src*=b-only]").length)).toBe(1);
		expect(await loads(page)).toBe(1);
		await page.context().close();
	});

	e2e("page scripts' mounts run once per visit, clean up when swapped out, and never stack", async () => {
		const page = await open("/a");
		const counts = () =>
			page.evaluate(() => {
				const w = window as any;
				return [w.__mounts ?? 0, w.__cleanups ?? 0];
			});
		expect(await counts()).toEqual([1, 0]);
		let visits = 0;
		for (const [to, name] of [["#to-b", "B"], ["#to-a", "A"], ["#to-b", "B"], ["#to-a", "A"], ["#to-b", "B"]] as const) {
			await page.click(to);
			await title(page, name);
			visits++;
			// One mount on the new page's counter, one cleanup for the old one's.
			expect(await counts()).toEqual([visits + 1, visits]);
		}
		await page.evaluate(() => ((window as any).__clicks = 0));
		await page.click("#count");
		expect(await page.evaluate(() => (window as any).__clicks)).toBe(1);
		expect(await page.textContent("#count")).toBe("1");
		expect(await page.evaluate(() => document.querySelectorAll('script[src*="/counter."]').length)).toBe(1);
		// Page C has a counter too but does not list counter.js: its mount stays off there.
		await page.click("#to-c");
		await title(page, "C");
		expect(await counts()).toEqual([visits + 1, visits + 1]);
		await page.evaluate(() => ((window as any).__clicks = 0));
		await page.click("#count");
		expect(await page.evaluate(() => (window as any).__clicks)).toBe(0);
		expect(await loads(page)).toBe(1);

		// In the account layout, a clock's interval is stopped by its cleanup: one ticks at a time.
		await page.click("#to-account");
		await title(page, "Account");
		expect(await loads(page)).toBe(2); // another layout is another shell
		for (const [to, name] of [["#side-orders", "Orders"], ["#side-account", "Account"], ["#side-orders", "Orders"]] as const) {
			await page.click(to);
			await title(page, name);
			// The swap runs inside a view transition here, so the new mount lands a moment after the title.
			await page.waitForFunction(() => (window as any).__clocks === 1);
			await page.waitForTimeout(120);
			expect(await page.evaluate(() => (window as any).__clocks)).toBe(1);
		}
		expect(await loads(page)).toBe(2);
		await page.context().close();
	});

	e2e("an unconverted script gets its page loaded for real, and makes the next click a full load", async () => {
		const page = await open("/a");
		const start = fixture.seen.length;
		await page.click("#to-legacy");
		// Swapped in, its new script ran and never called natsu.mount (one that waits
		// for DOMContentLoaded, which never comes again, would leave the page dead):
		// the page is loaded again, for real, and the script runs once in it.
		await page.waitForFunction(() => document.title === "Legacy" && (window as any).__loads === 2);
		expect(await page.evaluate(() => (window as any).__legacy)).toBe(1);
		// A part first (a hover may have asked for it already), then the page.
		expect(asked(start, "/legacy").map((a) => a[0])).toContain("part");
		expect(asked(start, "/legacy").at(-1)).toEqual(["page", "load"]);
		const from = fixture.seen.length;
		await page.click("#to-a");
		await page.waitForFunction(() => document.title === "A" && (window as any).__loads === 3);
		expect(await h1(page)).toBe("Page A");
		expect(asked(from, "/a")).toEqual([["page", "load"]]);
		expect(fixture.seen.slice(from).every((s) => s.nav === null)).toBe(true);
		await page.context().close();
	});

	e2e("<noscript> never reaches a part: DOMParser would read it as markup, and its style would hide the ad", async () => {
		const page = await open("/a");
		expect(
			await page.evaluate(async () => {
				const tag = new DOMParser().parseFromString("<noscript><style>p{}</style></noscript>", "text/html").querySelector("noscript")!.firstElementChild?.localName;
				// This parse draws a report of its own, which arrives as a task.
				await new Promise((r) => setTimeout(r, 100));
				(window as any).__csp = [];
				return tag;
			}),
		).toBe("style");
		await page.click("#to-b");
		await title(page, "B");
		await page.waitForTimeout(100);
		expect(await loads(page)).toBe(1);
		expect(await page.evaluate(() => getComputedStyle(document.getElementById("ad")!).display)).toBe("block");
		expect(await page.evaluate(() => document.querySelectorAll("noscript").length)).toBe(0);
		// The server dropped it, so DOMParser made no style for Chromium to report.
		expect(await page.evaluate(() => (window as any).__csp)).toEqual([]);
		await page.context().close();
	});

	e2e("noscript content a full load reads as text never becomes live markup after a swap", async () => {
		const whole = await open("/ns");
		expect(await whole.evaluate(() => document.getElementById("escaped") === null)).toBe(true);
		await whole.context().close();
		const page = await open("/a");
		await page.evaluate(() => (window as any).natsu.visit("/ns"));
		await title(page, "NS");
		expect(await loads(page)).toBe(1);
		expect(await page.evaluate(() => document.getElementById("escaped") === null)).toBe(true);
		await page.context().close();
	});

	e2e("a redirect is followed softly with its cookie; a hover prefetches and the click uses it; a refused prefetch is fetched again", async () => {
		const page = await open("/a");
		let from = fixture.seen.length;
		await page.click("#to-old");
		await title(page, "C");
		expect(await page.evaluate(() => location.pathname)).toBe("/c");
		// The 204 carried the flash cookie; the part showed it, and shown() cleared it.
		expect(await page.textContent("#flash")).toBe("moved");
		expect(await page.evaluate(() => document.cookie.includes("flash="))).toBe(false);
		expect(asked(from, "/old")).toEqual([["location /c", "fetch"]]);
		expect(asked(from, "/c")).toEqual([["part", "fetch"]]);

		from = fixture.seen.length;
		await page.hover("#to-b");
		await page.waitForFunction(() => performance.getEntriesByName(`${location.origin}/b`).length > 0);
		await page.waitForTimeout(50);
		expect(asked(from, "/b")).toEqual([["part", "prefetch"]]);
		await page.click("#to-b");
		await title(page, "B");
		// No second request: the click used the prefetched part.
		expect(asked(from, "/b")).toEqual([["part", "prefetch"]]);

		await page.hover("#to-quiet");
		await page.waitForTimeout(250);
		await page.click("#to-quiet");
		await title(page, "Quiet");
		expect(asked(from, "/quiet")).toEqual([["skip", "prefetch"], ["part", "fetch"]]);
		expect(await loads(page)).toBe(1);
		await page.context().close();
	});

	e2e("a GET form swaps softly; a POST, a data-natsu-reload link and a redirect to another origin load for real", async () => {
		const page = await open("/a");
		let from = fixture.seen.length;
		await page.click("#hard");
		await page.waitForFunction(() => document.title === "B" && (window as any).__loads === 2);
		expect(asked(from, "/b")).toEqual([["page", "load"]]);

		// The header's search form is a GET: a soft visit, query and all.
		from = fixture.seen.length;
		await page.fill('input[name="q"]', "mecha");
		await page.press('input[name="q"]', "Enter");
		await page.waitForFunction(() => location.search === "?q=mecha");
		await title(page, "Catalog");
		expect(asked(from, "/catalog?q=mecha")).toEqual([["part", "fetch"]]);
		expect(await loads(page)).toBe(2);

		// A POST is the browser's own: the product's form goes to /cart, which has no route.
		await page.click("#to-p1");
		await title(page, "Product 1");
		from = fixture.seen.length;
		await page.click("main form button");
		await page.waitForFunction(() => location.pathname === "/cart" && (window as any).__loads === 3);
		expect(fixture.seen.slice(from).filter((s) => s.path === "/cart").map((s) => [s.mode, s.nav, s.status])).toEqual([["navigate", null, 404]]);

		// A redirect to another origin (localhost is not 127.0.0.1) is told to the runtime, which leaves.
		await page.goto(`${ORIGIN}/a`);
		await title(page, "A");
		from = fixture.seen.length;
		await page.click("#to-away");
		await page.waitForFunction(() => location.hostname === "localhost" && document.title === "C");
		const port = new URL(ORIGIN).port;
		expect(asked(from, "/away")).toEqual([[`location http://localhost:${port}/c`, "fetch"]]);
		expect(asked(from, "/c")).toEqual([["page", "load"]]);
		await page.context().close();
	});

	e2e("an island in the shell is filled after load, kept across soft visits, and fetched again by natsu.island(); one naming another route is refused", async () => {
		const page = await open("/a", "alice");
		await page.waitForFunction(() => document.getElementById("bell-count") !== null);
		const filled = fixture.calls.bell;
		const text = await page.textContent("#bell");
		expect(text).toBe(`${filled} new for tok-alice`);
		for (const [to, name] of [["#to-b", "B"], ["#to-c", "C"], ["#to-a", "A"]] as const) {
			await page.click(to);
			await title(page, name);
		}
		await page.waitForTimeout(100);
		// The shell is mounted once: no fetch per visit, and the content stays.
		expect(fixture.calls.bell).toBe(filled);
		expect(await page.textContent("#bell")).toBe(text);
		await page.evaluate(() => (window as any).natsu.island(document.getElementById("bell")));
		expect(fixture.calls.bell).toBe(filled + 1);
		expect(await page.textContent("#bell-count")).toBe(String(filled + 1));
		// The attribute slipped into content, naming a route that is not an
		// island(): refused before its handler runs, and nothing is drawn.
		const plain = fixture.calls.plain;
		await page.evaluate(() => {
			const el = Object.assign(document.createElement("div"), { id: "slipped", textContent: "kept" });
			el.setAttribute("data-natsu-island", "/plain");
			document.body.append(el);
			return (window as any).natsu.island(el);
		});
		expect(fixture.calls.plain).toBe(plain);
		expect(await page.textContent("#slipped")).toBe("kept");
		expect(await loads(page)).toBe(1);
		await page.context().close();
	});

	e2e("refusals: a route not navigable, no route, another CSP or another shell are real loads; a 404 page swaps", async () => {
		const page = await open("/a");

		// Not navigable: refused before the handler, which then draws once, for the real load.
		let from = fixture.seen.length;
		const plain = fixture.calls.plain;
		await page.click("#to-plain");
		await page.waitForFunction(() => document.title === "Plain" && (window as any).__loads === 2);
		expect(asked(from, "/plain")).toEqual([["reload route", "fetch"], ["page", "load"]]);
		expect(fixture.calls.plain).toBe(plain + 1);

		// A 404 page drawn in the shell is a part like any other, with its status.
		from = fixture.seen.length;
		await page.click("#to-missing");
		await title(page, "Not found");
		expect(await h1(page)).toBe("Not found");
		expect(fixture.seen.slice(from).filter((s) => s.path === "/missing").map((s) => [s.status, s.answer])).toEqual([[404, "part"]]);
		expect(await loads(page)).toBe(2);

		// No route at all: natsu's own 404, loaded for real.
		from = fixture.seen.length;
		await page.click("#to-nowhere");
		await page.waitForFunction(() => location.pathname === "/nowhere" && (window as any).__loads === 3);
		expect(await page.evaluate(() => document.body.textContent)).toBe("Not Found");
		expect(asked(from, "/nowhere")).toEqual([["reload response", "fetch"], ["other", "load"]]);

		// Another CSP (one more image host): stale() leaves before drawing, and the real load draws it once.
		await page.goto(`${ORIGIN}/a`);
		await title(page, "A");
		from = fixture.seen.length;
		const ads = fixture.calls.ads;
		await page.click("#to-ads");
		await page.waitForFunction(() => document.title === "Ads" && (window as any).__loads === 5);
		expect(asked(from, "/ads")).toEqual([["reload document", "fetch"], ["page", "load"]]);
		expect(fixture.calls.ads).toBe(ads + 1);

		// Another shell: a banner in the header is a real load, and then it shows.
		await page.goto(`${ORIGIN}/a`);
		await title(page, "A");
		fixture.state.banner = "Maintenance at noon";
		try {
			from = fixture.seen.length;
			await page.click("#to-c");
			await page.waitForFunction(() => document.title === "C" && (window as any).__loads === 7);
			expect(await page.textContent("#banner")).toBe("Maintenance at noon");
			expect(asked(from, "/c")).toEqual([["reload shell", "fetch"], ["page", "load"]]);
			// And from there, with the banner in both shells, soft again.
			await page.click("#to-b");
			await title(page, "B");
			expect(await loads(page)).toBe(7);
		} finally {
			fixture.state.banner = "";
		}
		await page.context().close();
	});

	e2e("a crawler or a plain GET never gets a part, before or after parts of the same kept page", async () => {
		const plainGet = async (path: string, headers: Record<string, string> = {}) => {
			const answer = await fetch(ORIGIN + path, { headers });
			const html = await answer.text();
			return {
				part: answer.headers.get("natsu-part"),
				shell: html.includes('<header id="hdr"'),
				meta: html.includes('<meta name="natsu"'),
				vary: answer.headers.get("vary")?.includes("Natsu-Nav"),
			};
		};
		const whole = { part: null, shell: true, meta: true, vary: true };
		expect(await plainGet("/p/1")).toEqual(whole);
		expect(await plainGet("/p/1", { "user-agent": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)" })).toEqual(whole);

		// A browser soft-visits it: a part, cut from the page PageCache keeps.
		const page = await open("/catalog");
		const fresh = fixture.pages.counts.fresh;
		await page.click("#to-p1");
		await title(page, "Product 1");
		expect(fixture.pages.counts.fresh).toBeGreaterThan(fresh);
		const key = await page.evaluate(() => document.querySelector<HTMLMetaElement>('meta[name="natsu"]')!.content);

		// The kept page is still whole for anyone who did not ask for a part,
		// and a browser load carrying the header (Sec-Fetch-Mode: navigate) is not asking.
		expect(await plainGet("/p/1")).toEqual(whole);
		expect(await plainGet("/p/1", { "natsu-nav": key, "sec-fetch-mode": "navigate" })).toEqual(whole);
		expect(await plainGet("/p/1", { "natsu-nav": key, "sec-fetch-dest": "document" })).toEqual(whole);
		const crawler = await browser.newContext();
		await crawler.setExtraHTTPHeaders({ "Natsu-Nav": key });
		const tab = await crawler.newPage();
		const from = fixture.seen.length;
		const answer = await tab.goto(`${ORIGIN}/p/1`);
		expect(answer.headers()["natsu-part"]).toBeUndefined();
		expect(await tab.evaluate(() => [document.getElementById("hdr") !== null, document.documentElement.lang])).toEqual([true, "en"]);
		expect(fixture.seen.slice(from).find((s) => s.path === "/p/1")).toMatchObject({ nav: key, mode: "navigate", answer: "page" });
		await crawler.close();
		await page.context().close();
	});

	e2e("two visitors' secrets never cross through a kept page's parts", async () => {
		// Alice draws /p/2 first, so PageCache keeps it with marks for the secrets.
		const alice = await open("/p/2", "alice");
		const rendered = fixture.calls.product;
		expect(await alice.evaluate(() => document.querySelector<HTMLInputElement>('main input[name="csrf"]')!.value)).toBe("tok-alice");

		// Bob comes to it softly: his part is the kept page filled with his own.
		const bob = await open("/catalog", "bob");
		const fresh = fixture.pages.counts.fresh;
		await bob.click("#to-p2");
		await title(bob, "Product 2");
		expect(fixture.calls.product).toBe(rendered); // not drawn again: cut from the kept page
		expect(fixture.pages.counts.fresh).toBeGreaterThan(fresh);
		const seenByBob = await bob.evaluate(() => ({
			region: document.querySelector<HTMLInputElement>('main input[name="csrf"]')!.value,
			header: document.querySelector<HTMLInputElement>('header input[name="csrf"]')!.value,
			html: document.documentElement.outerHTML,
		}));
		expect(seenByBob.region).toBe("tok-bob");
		expect(seenByBob.header).toBe("tok-bob");
		expect(seenByBob.html).not.toContain("tok-alice");
		expect(seenByBob.html).not.toContain("natsu-secret-");
		expect(await loads(bob)).toBe(1);

		// Alice's key does not open Bob's shell: her token is in it.
		const aliceKey = await alice.evaluate(() => document.querySelector<HTMLMetaElement>('meta[name="natsu"]')!.content);
		const crossed = await fetch(`${ORIGIN}/p/2`, { headers: { "natsu-nav": aliceKey, cookie: "visitor=bob" } });
		expect([crossed.status, crossed.headers.get("natsu-reload")]).toEqual([204, "shell"]);
		await alice.context().close();
		await bob.context().close();
	});

	e2e("back to a page the back/forward cache kept clears html[data-natsu-loading] on pageshow", async () => {
		if (!full) return console.warn("skipped: the headless shell never uses the back/forward cache");
		const page = await open("/a");
		// Chromium says why, should it not keep the page.
		const cdp = await page.context().newCDPSession(page);
		await cdp.send("Page.enable");
		let why = "";
		cdp.on("Page.backForwardCacheNotUsed", (e: { notRestoredExplanations: unknown }) => (why = JSON.stringify(e.notRestoredExplanations)));
		await page.click("#to-slow");
		// Over 300 ms: marked loading; then the answer says reload, and the browser loads /slow.
		await title(page, "Slow");
		expect(await loads(page)).toBe(2);
		// A restore from the cache fires no load event, which goBack waits for by default.
		await page.goBack({ waitUntil: "commit" });
		await title(page, "A");
		const after = await page.evaluate(() => ({
			restored: (window as any).__restored,
			loads: (window as any).__loads,
			loading: document.documentElement.hasAttribute("data-natsu-loading"),
		}));
		if (!after.restored) console.warn(`the back/forward cache did not keep /a: ${why}`);
		expect(after.restored).toBe(true);
		expect(after.loads).toBe(1); // the same document, not a new load
		expect(after.loading).toBe(false);
		// And it still switches pages softly.
		await page.click("#to-b");
		await title(page, "B");
		expect(await loads(page)).toBe(1);
		await page.context().close();
	});

	e2e("a converted script a loader appends to the body still mounts on a page swapped in", async () => {
		const page = await open("/w1");
		await page.waitForFunction(() => document.getElementById("w")!.textContent === "mounted");
		await page.evaluate(() => (window as any).natsu.visit("/w2"));
		await title(page, "W2");
		await page.waitForTimeout(300);
		// A full load of W2 shows "mounted": its loader loads the widget, which mounts.
		expect([await loads(page), await page.textContent("#w")]).toEqual([1, "mounted"]);
		await page.context().close();
	});

	e2e("a page the back/forward cache kept while a Back was on its way: restored, it shows the page its URL names", async () => {
		if (!full) return console.warn("skipped: the headless shell never uses the back/forward cache");
		const page = await open("/a");
		const cdp = await page.context().newCDPSession(page);
		await cdp.send("Page.enable");
		let why = "";
		cdp.on("Page.backForwardCacheNotUsed", (e: { notRestoredExplanations: unknown }) => (why = JSON.stringify(e.notRestoredExplanations)));
		await page.click("#to-b");
		await title(page, "B");
		// The part for /a comes back in 100 ms; the answer for /plain (a real load: not navigable) in 300 ms.
		const hold = (ms: number) => async (r: any) => {
			if (r.request().headers()["natsu-nav"]) await new Promise((y) => setTimeout(y, ms));
			await r.continue();
		};
		await page.route(/\/a$/, hold(100));
		await page.route(/\/plain$/, hold(300));
		// Back, and while /a is on its way, a click on B's header link to /plain.
		await page.evaluate(() => {
			addEventListener("popstate", () => setTimeout(() => document.getElementById("to-plain")!.click(), 10), { once: true });
			history.back();
		});
		await title(page, "Plain");
		await page.goBack({ waitUntil: "commit" });
		await new Promise((r) => setTimeout(r, 1000));
		const got = await page.evaluate(() => ({
			restored: (window as any).__restored,
			url: location.pathname,
			h1: document.querySelector("main h1")?.textContent,
		}));
		if (!got.restored) console.warn(`not restored from the back/forward cache: ${why}`);
		expect(got.url == "/a" ? got.h1 : "Page A").toBe("Page A");
		await page.context().close();
	});

	e2e("refresh() that the server answers with a real load (the shell changed after an action) reloads the page and keeps the scroll, as location.reload() does", async () => {
		const results: unknown[] = [];
		for (const hash of [false, true]) {
			const page = await open("/a");
			if (hash) {
				await page.click("#jump");
				await page.waitForFunction(() => location.hash === "#results");
			}
			await scrollTo(page, 1500);
			await new Promise((r) => setTimeout(r, 300));
			// An action signed the visitor in: the header (shell) differs, so the server answers the refresh with a real load.
			fixture.state.banner = "Signed in";
			try {
				await page.evaluate(() => (window as any).natsu.refresh());
				await new Promise((r) => setTimeout(r, 1500));
				await page.waitForFunction(() => document.readyState === "complete");
				const got = await page.evaluate(() => ({
					loads: (window as any).__loads,
					banner: document.getElementById("banner")?.textContent ?? null,
					y: scrollY,
				}));
				results.push({ hash, ...got });
			} finally {
				fixture.state.banner = "";
				await page.context().close();
			}
		}
		expect(results).toEqual([
			{ hash: false, loads: 2, banner: "Signed in", y: 1500 },
			{ hash: true, loads: 2, banner: "Signed in", y: 1500 },
		]);
	});

	e2e("a redirect whose target's natsu:visit is cancelled leaves no html[data-natsu-loading]", async () => {
		const page = await open("/a");
		await page.evaluate(() => {
			document.addEventListener("natsu:visit", (e: any) => new URL(e.detail.url).pathname === "/c" && e.preventDefault());
		});
		await page.click("#to-old");
		await page.waitForTimeout(700);
		expect(await page.evaluate(() => [location.pathname, document.documentElement.hasAttribute("data-natsu-loading")])).toEqual(["/a", false]);
		await page.context().close();
	});

	e2e("an inline <style nonce> in the head: kept when unchanged, and a page's own applies after a soft visit", async () => {
		const page = await open("/account");
		const color = (id: string) => page.evaluate((id: string) => getComputedStyle(document.getElementById(id)!).color, id);
		const layoutStyle = await page.evaluateHandle(() => document.querySelector("head style"));
		expect(await color("clock")).toBe("rgb(0, 128, 0)");
		await page.click("#side-orders");
		await title(page, "Orders");
		// The layout's style is the same element, still applied; the page's own got the document's nonce.
		expect(await page.evaluate((s: Element) => s === document.querySelector("head style") && s.isConnected, layoutStyle)).toBe(true);
		expect(await color("clock")).toBe("rgb(0, 128, 0)");
		expect(await color("orders-note")).toBe("rgb(0, 0, 200)");
		expect(await page.evaluate(() => document.head.querySelectorAll("style").length)).toBe(2);
		// Chromium reports each inline style DOMParser reads in the part against
		// the page's policy, nonce or not: two here, the layout's and the page's.
		// They are reports only (both styles above apply); a real load has none.
		expect(await page.evaluate(() => (window as any).__csp)).toEqual(["style-src-elem inline", "style-src-elem inline"]);
		await page.click("#side-account");
		await title(page, "Account");
		expect(await page.evaluate(() => document.head.querySelectorAll("style").length)).toBe(1);
		expect(await color("clock")).toBe("rgb(0, 128, 0)");
		expect(await loads(page)).toBe(1);
		await page.context().close();
	});

	e2e("the loading bar shows under the page's CSP while a slow visit waits; a link in view is fetched ahead; Back reuses the kept part", async () => {
		const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
		await context.addCookies([{ name: "visitor", value: "anon", url: ORIGIN }]);
		const page = await context.newPage();
		page.setDefaultTimeout(8_000);
		// Before the runtime boots: the header's link to /c asks to be fetched once in view.
		await page.addInitScript(() => {
			(window as any).__csp = [];
			document.addEventListener("securitypolicyviolation", (e) => (window as any).__csp.push(e.violatedDirective));
			document.addEventListener("DOMContentLoaded", () => document.getElementById("to-c")?.setAttribute("data-natsu-prefetch", "viewport"));
		});
		let from = fixture.seen.length;
		await page.goto(ORIGIN + "/a");
		await page.waitForFunction(() => performance.getEntriesByName(`${location.origin}/c`).length > 0);
		await page.waitForTimeout(50);
		expect(asked(from, "/c")).toEqual([["part", "prefetch"]]);

		// The bar: there, invisible, until a visit takes 150 ms.
		const bar = () =>
			page.evaluate(() => {
				const el = document.querySelector("natsu-bar")!;
				const s = getComputedStyle(el);
				return { loading: document.documentElement.hasAttribute("data-natsu-loading"), position: s.position, opacity: s.opacity, height: s.height };
			});
		expect(await bar()).toEqual({ loading: false, position: "fixed", opacity: "0", height: "2px" });
		from = fixture.seen.length;
		await page.click("#to-b");
		await title(page, "B");
		await page.click("#to-c");
		await title(page, "C");
		// Back: /b comes from the part it was shown from, not asked again.
		await page.goBack({ waitUntil: "commit" });
		await title(page, "B");
		expect(asked(from, "/b")).toEqual([["part", "fetch"]]);

		page.click("#to-slow");
		await page.waitForFunction(() => document.documentElement.hasAttribute("data-natsu-loading"));
		await page.waitForTimeout(100);
		const shown = await bar();
		expect(shown.loading).toBe(true);
		expect(Number(shown.opacity)).toBe(1);
		await title(page, "Slow");
		expect(await page.evaluate(() => (window as any).__csp)).toEqual([]);
		await context.close();
	});

	e2e("a view transition runs only when <html data-natsu-transition> opts in", async () => {
		const count = async (page: any) =>
			page.evaluate(() => {
				const w = window as unknown as { __vt: number };
				w.__vt = 0;
				const start = document.startViewTransition.bind(document);
				document.startViewTransition = (cb?: ViewTransitionUpdateCallback) => (w.__vt++, start(cb));
			});
		const site = await open("/c");
		await count(site);
		await site.click("#to-a");
		await title(site, "A");
		expect(await site.evaluate(() => (window as any).__vt)).toBe(0);
		// The account layout opts in on its <html>.
		const account = await open("/account");
		await count(account);
		await account.click("#side-orders");
		await title(account, "Orders");
		expect(await account.evaluate(() => (window as any).__vt)).toBe(1);
		expect(await loads(account)).toBe(1);
		await site.context().close();
		await account.context().close();
	});

	// The spec's font guard (load the new sheet's copies of loaded faces
	// first) is not in the runtime because of what this showed: with the font
	// cacheable, Chromium takes the new face from the memory cache and nothing
	// flashes; served no-store, the text flashes with or without the guard,
	// because removing the old sheet makes Chromium build every face afresh.
	e2e("text in a web font never falls back while the sheet that declares it is swapped", async () => {
		if (!FONT) return console.warn("skipped: no font file to serve");
		const page = await open("/a");
		await page.evaluate(() => document.fonts.ready);
		await page.waitForFunction(() => document.fonts.check("16px Probe"));
		const width = await page.evaluate(() => document.getElementById("probe")!.getBoundingClientRect().width);
		await page.evaluate(() => {
			const w = window as unknown as { __widths: number[]; __stop: boolean };
			w.__widths = [];
			const probe = document.getElementById("probe")!;
			const sample = () => w.__widths.push(probe.getBoundingClientRect().width);
			new MutationObserver(sample).observe(document, { childList: true, subtree: true });
			const frame = () => {
				sample();
				if (!w.__stop) requestAnimationFrame(frame);
			};
			frame();
		});
		await page.click("#to-c");
		await title(page, "C");
		await page.waitForTimeout(300);
		const widths: number[] = await page.evaluate(() => ((window as any).__stop = true) && (window as any).__widths);
		expect([...new Set(widths)]).toEqual([width]);
		await page.context().close();
	});

	e2e(
		"the network: a soft visit fetches only the part; bytes and times for a full load and a soft visit",
		async () => {
			const rows: string[] = [];
			const page = await open("/a", "alice");
			/** Every request the page makes from now on, with its bytes on the wire. */
			const log: { url: string; type: string; status: number; body: number; headers: number; part: boolean }[] = [];
			page.on("requestfinished", async (request: any) => {
				const response = await request.response();
				const sizes = await request.sizes();
				log.push({
					url: request.url().replace(ORIGIN, ""),
					type: request.resourceType(),
					status: response?.status() ?? 0,
					body: sizes.responseBodySize,
					headers: sizes.responseHeadersSize,
					part: (await response?.allHeaders())?.["natsu-part"] === "1",
				});
			});
			const settle = () => page.waitForTimeout(150);

			// A soft visit: one request to the app, the part; the rest are chunks this document lacks.
			await settle();
			log.length = 0;
			await page.click("#to-catalog");
			await title(page, "Catalog");
			await settle();
			const app = log.filter((r) => !r.url.startsWith("/_a/") && !r.url.startsWith("/fonts/"));
			expect(app.map((r) => [r.url, r.type, r.status, r.part])).toEqual([["/catalog", "fetch", 200, true]]);
			expect(log.filter((r) => r.type === "document")).toEqual([]);
			expect(log.every((r) => r.part || r.url.startsWith("/_a/") || r.url.startsWith("/fonts/"))).toBe(true);

			// Bytes: the document of a full load against the part of a soft visit, both brotli'd by compress().
			const bytes: Record<string, { full: number; part: number; fullHeaders: number; partHeaders: number }> = {};
			for (const [path, link, name] of [["/catalog", "#to-catalog", "Catalog"], ["/p/1", "#to-p1", "Product 1"]] as const) {
				log.length = 0;
				await page.goto(ORIGIN + path);
				await title(page, name);
				await settle();
				const doc = log.find((r) => r.type === "document" && r.url === path)!;
				await page.goto(`${ORIGIN}/a`);
				await title(page, "A");
				await settle();
				log.length = 0;
				await page.click(link);
				await title(page, name);
				await settle();
				const part = log.find((r) => r.part && r.url === path)!;
				bytes[path] = { full: doc.body, part: part.body, fullHeaders: doc.headers, partHeaders: part.headers };
				expect(part.body).toBeLessThan(doc.body);
			}

			// Times in the browser, warm: a full load (navigation start to the load
			// event) and a soft visit (natsu:visit to natsu:load), five each, alternating.
			const fullMs: Record<string, number[]> = { "/catalog": [], "/p/1": [] };
			const softMs: Record<string, number[]> = { "/catalog": [], "/p/1": [] };
			const swapMs: Record<string, number[]> = { "/catalog": [], "/p/1": [] };
			for (let i = 0; i < 6; i++) {
				for (const [path, name] of [["/catalog", "Catalog"], ["/p/1", "Product 1"]] as const) {
					await page.goto(ORIGIN + path);
					await title(page, name);
					await page.waitForFunction(() => (performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming).loadEventEnd > 0);
					const t = await page.evaluate(() => (performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming).loadEventEnd);
					if (i > 0) fullMs[path]!.push(t);
				}
			}
			await page.goto(`${ORIGIN}/p/1`);
			await title(page, "Product 1");
			await page.evaluate(() => {
				const w = window as any;
				w.__times = [];
				let start = 0;
				let swap = 0;
				document.addEventListener("natsu:visit", () => (start = performance.now()));
				document.addEventListener("natsu:before-swap", () => (swap = performance.now()));
				document.addEventListener("natsu:load", () => w.__times.push([location.pathname, swap - start, performance.now() - start]));
			});
			for (let i = 0; i < 6; i++) {
				for (const [link, name] of [["#to-catalog", "Catalog"], ["#to-p1", "Product 1"]] as const) {
					await page.click(link);
					await title(page, name);
					await page.waitForFunction((n: number) => (window as any).__times.length === n, i * 2 + (name === "Catalog" ? 1 : 2));
				}
			}
			const times: [string, number, number][] = await page.evaluate(() => (window as any).__times);
			times.slice(2).forEach(([path, swap, done]) => {
				swapMs[path]!.push(swap);
				softMs[path]!.push(done);
			});
			// And as a visitor clicks: the pointer rests on the link a moment first
			// (250 ms here), long enough for the hover prefetch to bring the part.
			const hoverMs: Record<string, number[]> = { "/catalog": [], "/p/1": [] };
			await page.evaluate(() => ((window as any).__times = []));
			for (let i = 0; i < 5; i++) {
				for (const [link, name] of [["#to-catalog", "Catalog"], ["#to-p1", "Product 1"]] as const) {
					await page.hover(link);
					await page.waitForTimeout(250);
					await page.click(link);
					await title(page, name);
					await page.waitForFunction((n: number) => (window as any).__times.length === n, i * 2 + (name === "Catalog" ? 1 : 2));
					await page.mouse.move(5, 700);
				}
			}
			for (const [path, , done] of (await page.evaluate(() => (window as any).__times)) as [string, number, number][]) hoverMs[path]!.push(done);
			expect(await loads(page)).toBeGreaterThan(1);

			// The server's time for each, as the app measured it (compression
			// included), and the same in process through app.handle, 200 times.
			const serverMs = (path: string, answer: string, mode: string) =>
				median(fixture.seen.filter((s) => s.path === path && s.answer === answer && s.mode === mode).map((s) => s.ms));
			const socket = Object.fromEntries(
				["/catalog", "/p/1"].map((path) => [path, { full: serverMs(path, "page", "navigate"), part: serverMs(path, "part", "cors") }]),
			);
			const key = await page.evaluate(() => document.querySelector<HTMLMetaElement>('meta[name="natsu"]')!.content);
			const handle = async (path: string, headers: Record<string, string>) => {
				const runs = 200;
				const ms: number[] = [];
				for (let i = 0; i < runs; i++) {
					const started = Bun.nanoseconds();
					const answer = await fixture.app.handle(new Request(ORIGIN + path, { headers: { cookie: "visitor=alice", "accept-encoding": "br", ...headers } }));
					await answer.arrayBuffer();
					ms.push((Bun.nanoseconds() - started) / 1e6);
				}
				return median(ms);
			};

			rows.push("| Page | Full document (brotli body + headers) | Part (brotli body + headers) | Saved: body / all |", "|---|---|---|---|");
			for (const [path, b] of Object.entries(bytes)) {
				const saved = (part: number, whole: number) => `${Math.round((1 - part / whole) * 100)}%`;
				rows.push(
					`| ${path} | ${b.full} + ${b.fullHeaders} B | ${b.part} + ${b.partHeaders} B | ` +
						`${saved(b.part, b.full)} / ${saved(b.part + b.partHeaders, b.full + b.fullHeaders)} |`,
				);
			}
			rows.push(
				"",
				"| Page | Full load, nav start to load (median ms) | Soft visit, natsu:visit to swap / to natsu:load | After a 250 ms hover, to natsu:load | Server, full page (socket / handle) | Server, part (socket / handle) |",
				"|---|---|---|---|---|---|",
			);
			for (const path of ["/catalog", "/p/1"]) {
				const fullHandle = await handle(path, {});
				const partHandle = await handle(path, { "natsu-nav": key });
				rows.push(
					`| ${path} | ${median(fullMs[path]!).toFixed(1)} | ${median(swapMs[path]!).toFixed(1)} / ${median(softMs[path]!).toFixed(1)} | ${median(hoverMs[path]!).toFixed(1)} | ` +
						`${socket[path]!.full.toFixed(3)} / ${fullHandle.toFixed(3)} | ${socket[path]!.part.toFixed(3)} / ${partHandle.toFixed(3)} |`,
				);
			}
			console.log(`\n${rows.join("\n")}\n`);
			await page.context().close();
		},
		90_000,
	);
});
