/**
 * The page-switching runtime in a real browser (Chromium through the
 * Playwright installed on the machine; nothing is installed for it).
 *
 * Not part of `bun test`: its name does not match the test pattern. Run it
 * with `bun run test:e2e`. It needs Playwright's Chromium; without one the
 * suite is skipped, saying so.
 *
 * A small Bun server stands in for natsu's server step and speaks the wire
 * format exactly: a GET carrying a well-formed `Natsu-Nav` (and no
 * `Sec-Fetch-Mode: navigate`) gets a part, `204 Natsu-Location`,
 * `204 Natsu-Reload` or `204 Natsu-Prefetch: skip`; anything else gets the
 * full page with the runtime injected before `</head>`. Every HTML answer
 * carries a CSP with a fresh nonce and `'strict-dynamic'`, so a script runs
 * only if the parser met it with that nonce or a trusted script created it.
 *
 * The pages use different stylesheets cut from one source in source order,
 * as Assets cuts them. A sheet that lacks a rule the current page uses, but
 * repeats an earlier rule that competes with it (`.hidden` against
 * `.lg:grid`, or against `.md:flex` for a region-only chunk), hides that
 * element if it lands after the old sheet; the runtime inserts it before,
 * so the old sheet keeps winning until the swap removes it. Page scripts use
 * `natsu.mount`, except one that does not.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const PORT = Number(process.env.NATSU_E2E_PORT ?? 5920);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const FONT = ["/usr/share/fonts/truetype/liberation/LiberationSerif-Regular.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf"].find(
	(f) => existsSync(f),
);

// --- the fixture server -------------------------------------------------------

/** The source stylesheet, rule by rule, in source order. */
const RULES: Record<string, string> = {
	font: `@font-face{font-family:Probe;src:url(/_a/probe.ttf) format("truetype");font-display:block}`,
	base: `body{margin:0;font:16px/1.4 Probe,monospace}header{position:fixed;top:0;left:0;right:0;height:40px;background:#fff}main{padding-top:48px}`,
	hidden: `.hidden{display:none}`,
	tall: `.tall{height:5000px}`,
	red: `.text-red{color:rgb(200,0,0)}`,
	probe: `.probe{display:inline-block;white-space:nowrap}`,
	mdflex: `@media (min-width:768px){.md\\:flex{display:flex}}`,
	lggrid: `@media (min-width:1024px){.lg\\:grid{display:grid}}`,
};
const cut = (names: string[]) =>
	Object.entries(RULES)
		.filter(([k]) => names.includes(k))
		.map(([, v]) => v)
		.join("\n");
/**
 * Each page's sheet: the rules its shape uses, header included, like Assets'
 * chunks. Only page A uses `lg:grid`. `r` is no page's sheet: it is the
 * region-only chunk of map 1's probe, which lacks the header's rules.
 */
const SHEETS: Record<string, string> = {
	a: cut(["font", "base", "hidden", "tall", "probe", "mdflex", "lggrid"]),
	b: cut(["font", "base", "hidden", "tall", "red", "probe", "mdflex"]),
	c: cut(["font", "base", "hidden", "probe", "mdflex"]),
	r: cut(["hidden", "red"]),
};

const SCRIPTS: Record<string, string> = {
	// Converted: binds per element through mount, and its document listener goes with the signal.
	"counter.js": `natsu.mount("[data-counter]", (el, signal) => {
		document.addEventListener("click", (e) => {
			if (!e.target.matches("[data-counter]")) return;
			window.__clicks = (window.__clicks || 0) + 1;
			e.target.textContent = String(+e.target.textContent + 1);
		}, { signal });
	});`,
	"b-only.js": `document.body.dataset.bOnly = "ran"; natsu.mount("#main", () => {});`,
	// Unconverted: never calls mount.
	"legacy.js": `window.__legacy = (window.__legacy || 0) + 1;`,
};

interface Def {
	title: string;
	sheet: string;
	main: string;
	scripts?: string[];
	html?: string;
	prefetch?: false;
	/** Answer a navigation request only after 400 ms, and then with `Natsu-Reload: route`. */
	slow?: true;
}

const PAGES: Record<string, Def> = {
	"/a": {
		title: "A",
		sheet: "a",
		main: `<h1>Page A</h1><div id="wide" class="hidden lg:grid">wide</div><a id="jump" href="#results">results</a><button id="count" data-counter>0</button><div class="tall"></div><div id="results">results</div>`,
		scripts: ["counter.js"],
	},
	"/b": {
		title: "B",
		sheet: "b",
		main: `<h1 class="text-red">Page B</h1><button id="count" data-counter>0</button><div data-ad-spot id="ad">ad</div><noscript><style>[data-ad-spot]{display:none}</style></noscript><div class="tall"></div>`,
		scripts: ["counter.js", "b-only.js"],
	},
	"/c": { title: "C", sheet: "c", main: `<h1>Page C</h1>` },
	"/legacy": { title: "Legacy", sheet: "c", main: `<h1>Legacy</h1>`, scripts: ["legacy.js"] },
	"/quiet": { title: "Quiet", sheet: "c", main: `<h1>Quiet</h1>`, prefetch: false },
	"/vt": { title: "VT", sheet: "c", main: `<h1>VT</h1>`, html: ` data-natsu-transition` },
	"/slow": { title: "Slow", sheet: "c", main: `<h1>Slow</h1>`, slow: true },
};

const SHELL =
	`<header id="hdr"><nav id="nav" class="hidden md:flex">` +
	["a", "b", "c", "legacy", "old", "quiet", "vt", "slow"].map((p) => `<a id="to-${p}" href="/${p}">${p}</a> `).join("") +
	`</nav><span class="probe" id="probe">Probe WWW iii</span></header>`;
const SHELL_KEY = Bun.hash(`${SHELL}|main foot`).toString(36).slice(0, 13);
const BUILD = "e2e";

/** What the server saw: path, and the two navigation headers. */
const seen: { path: string; nav: string | null; prefetch: string | null }[] = [];
let cssDelay = 0;
/** `'strict-dynamic'` as natsu's server step sends it, or a bare nonce, where only the nonce lets a created script run. */
let strict = true;
let runtime = "";

function serve(req: Request): Response | Promise<Response> {
	const url = new URL(req.url);
	const path = url.pathname;
	if (path === "/_a/natsu.js") return new Response(runtime, { headers: { "content-type": "text/javascript", "cache-control": "public, max-age=31536000, immutable" } });
	if (path.startsWith("/_a/js/")) {
		const body = SCRIPTS[path.slice(7)];
		return body ? new Response(body, { headers: { "content-type": "text/javascript" } }) : new Response("", { status: 404 });
	}
	if (path === "/_a/probe.ttf" && FONT) return new Response(readFileSync(FONT), { headers: { "content-type": "font/ttf", "cache-control": "public, max-age=31536000, immutable" } });
	const sheet = /^\/_a\/site\.(\w)\.css$/.exec(path)?.[1];
	if (sheet && SHEETS[sheet]) {
		const res = () => new Response(SHEETS[sheet], { headers: { "content-type": "text/css", "cache-control": "no-store" } });
		return cssDelay ? Bun.sleep(cssDelay).then(res) : res();
	}

	// The server step, as natsu's speaks it.
	const nonce = crypto.randomUUID().replaceAll("-", "");
	const csp = `default-src 'self'; script-src 'nonce-${nonce}'${strict ? " 'strict-dynamic'" : ""}; style-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'`;
	const docKey = Bun.hash(BUILD + csp.replace(/'nonce-[^']*'/g, "")).toString(36).slice(0, 13);
	const key = `${docKey}.${SHELL_KEY}`;
	const nav = req.headers.get("natsu-nav");
	const asked =
		req.method === "GET" &&
		nav !== null &&
		/^[a-z0-9]{1,13}\.[a-z0-9]{1,13}$/.test(nav) &&
		req.headers.get("sec-fetch-mode") !== "navigate" &&
		req.headers.get("sec-fetch-dest") !== "document";
	const prefetch = asked ? req.headers.get("natsu-prefetch") : null;
	seen.push({ path: path + url.search, nav: asked ? nav : null, prefetch });
	const control = (headers: Record<string, string>) =>
		new Response(null, { status: 204, headers: { vary: "Natsu-Nav", "cache-control": "private, no-store", ...headers } });
	if (path === "/old") return asked ? control({ "natsu-location": `${ORIGIN}/c` }) : Response.redirect(`${ORIGIN}/c`, 302);
	const def = PAGES[path];
	if (!def) return new Response("not found", { status: 404 });
	if (prefetch === "1" && def.prefetch === false) return control({ "natsu-prefetch": "skip" });
	if (asked && def.slow) return Bun.sleep(400).then(() => control({ "natsu-reload": "route" }));
	const head = `<meta charset="utf-8"><title>${def.title}</title><link rel="stylesheet" href="/_a/site.${def.sheet}.css">`;
	const regions = `<main id="main" data-natsu-region>${def.main}</main><footer id="foot" data-natsu-region>footer ${def.title}</footer>`;
	const scripts = (n?: string) => (def.scripts ?? []).map((s) => `<script src="/_a/js/${s}"${n ? ` nonce="${n}"` : ""} defer></script>`).join("");
	if (asked) {
		if (nav !== key) return control({ "natsu-reload": nav!.split(".")[0] === docKey ? "shell" : "document" });
		return new Response(`<!doctype html><html><head>${head}<meta name="natsu" content="${key}"></head><body>${regions}${scripts()}</body></html>`, {
			headers: { "content-type": "text/html; charset=utf-8", "natsu-part": "1", vary: "Natsu-Nav", "cache-control": "private, no-store" },
		});
	}
	return new Response(
		`<!doctype html><html lang="en"${def.html ?? ""}><head>${head}<meta name="natsu" content="${key}">` +
			`<script src="/_a/natsu.js" nonce="${nonce}" defer></script></head><body>${SHELL}${regions}${scripts(nonce)}</body></html>`,
		// No cache-control, as natsu sends none for a page: the back/forward cache may keep it.
		{ headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": csp, vary: "Natsu-Nav" } },
	);
}

// --- the browser ----------------------------------------------------------------

let server: ReturnType<typeof Bun.serve> | undefined;
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
	const built = await Bun.build({
		entrypoints: [new URL("../src/client/navigate.ts", import.meta.url).pathname],
		format: "iife",
		minify: true,
		define: { NATSU_DEV: "false" },
	});
	runtime = await built.outputs[0]!.text();
	server = Bun.serve({ port: PORT, hostname: "127.0.0.1", fetch: serve });
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
	server?.stop(true);
});

/** A desktop-sized page that records CSP violations and real loads. */
async function open(path: string) {
	const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
	const page = await context.newPage();
	await page.addInitScript(() => {
		const w = window as unknown as { __csp: string[]; __loads: number };
		w.__csp = [];
		addEventListener("pageshow", (e) => ((w as unknown as { __restored: boolean }).__restored = (e as PageTransitionEvent).persisted));
		w.__loads = (Number(sessionStorage.getItem("loads")) || 0) + 1;
		sessionStorage.setItem("loads", String(w.__loads));
		document.addEventListener("securitypolicyviolation", (e) => w.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
	});
	await page.goto(ORIGIN + path);
	await page.waitForFunction(() => document.readyState === "complete");
	return page;
}
const h1 = (page: { textContent(sel: string): Promise<string> }) => page.textContent("main h1");
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

const e2e = (name: string, fn: () => Promise<void>) =>
	test(
		name,
		async () => {
			if (!browser) {
				console.warn(`skipped: ${missing || "no browser"}`);
				return;
			}
			await fn();
		},
		{ timeout: 30_000 },
	);

describe("navigate in Chromium", () => {
	e2e("scripts the runtime creates run under 'strict-dynamic', carrying the boot nonce", async () => {
		const page = await open("/a");
		await page.click("#to-b");
		await page.waitForFunction(() => document.body.dataset.bOnly === "ran");
		expect(await h1(page)).toBe("Page B");
		const nonces = await page.evaluate(() => {
			const boot = (document.querySelector('script[src="/_a/natsu.js"]') as HTMLScriptElement).nonce;
			const added = document.querySelector('script[src="/_a/js/b-only.js"]') as HTMLScriptElement;
			return { boot, added: added.nonce, async: added.async };
		});
		expect(nonces.boot.length).toBe(32);
		expect(nonces.added).toBe(nonces.boot);
		expect(nonces.async).toBe(false);
		// No script was refused. (Page B's `<noscript><style>` draws a style
		// report from DOMParser; the noscript test pins that down.)
		expect(await page.evaluate(() => (window as any).__csp.filter((v: string) => v.startsWith("script-src")))).toEqual([]);
		expect(await page.evaluate(() => (window as any).__loads)).toBe(1);
		await page.context().close();
	});

	e2e("under a nonce without 'strict-dynamic', the boot nonce is what lets those scripts run", async () => {
		strict = false;
		try {
			const page = await open("/a");
			await page.click("#to-b");
			await page.waitForFunction(() => document.body.dataset.bOnly === "ran");
			expect(await page.evaluate(() => (window as any).__csp.filter((v: string) => v.startsWith("script-src")))).toEqual([]);
			// The policy is live: a created script without the nonce is refused.
			await page.evaluate(() => {
				const s = document.createElement("script");
				s.src = "/_a/js/legacy.js";
				document.body.append(s);
			});
			await page.waitForFunction(() => (window as any).__csp.some((v: string) => v.startsWith("script-src")));
			expect(await page.evaluate(() => (window as any).__legacy)).toBeUndefined();
			expect(await page.evaluate(() => (window as any).__loads)).toBe(1);
			await page.context().close();
		} finally {
			strict = true;
		}
	});

	e2e("the header's hidden md:flex nav stays visible through a stylesheet swap at desktop width", async () => {
		const page = await open("/a");
		// The hazard is real in Chromium (map 1's probe): a chunk that repeats
		// `.hidden` without the header's `.md:flex` hides the nav when it comes
		// after the old sheet, and does not when it comes before.
		const order = (where: "before" | "after") =>
			page.evaluate(
				(where: string) =>
					new Promise<string>((done) => {
						const old = document.querySelector('link[rel="stylesheet"]')!;
						const l = document.createElement("link");
						l.rel = "stylesheet";
						l.href = "/_a/site.r.css";
						l.onload = () => {
							const d = getComputedStyle(document.getElementById("nav")!).display;
							l.remove();
							done(d);
						};
						if (where == "before") old.before(l);
						else old.after(l);
					}),
				where,
			);
		expect(await order("after")).toBe("none");
		expect(await order("before")).toBe("flex");
		cssDelay = 400;
		try {
			// Sample every frame, every head change and every load event (the
			// moment the new sheet applies, before the swap): the nav must be
			// flex throughout, and page A's `hidden lg:grid` element, whose rule
			// page B's sheet lacks, grid for as long as it is on screen.
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
			const sheets = await page.evaluate(() => [...document.querySelectorAll('link[rel="stylesheet"]')].map((l) => l.getAttribute("href")));
			expect(sheets).toEqual(["/_a/site.b.css"]);
			expect(await page.evaluate(() => getComputedStyle(document.querySelector("main h1")!).color)).toBe("rgb(200, 0, 0)");
		} finally {
			cssDelay = 0;
		}
		await page.context().close();
	});

	e2e("back and forward restore scroll both ways; focus and the announcement follow", async () => {
		const page = await open("/a");
		await scrollTo(page, 1200);
		await page.click("#to-b");
		await page.waitForFunction(() => document.title === "B");
		expect(await page.evaluate(() => scrollY)).toBe(0);
		expect(await page.evaluate(() => document.activeElement?.textContent)).toBe("Page B");
		expect(await page.textContent('[role="status"]')).toBe("B");
		await scrollTo(page, 2000);
		await page.goBack();
		await page.waitForFunction(() => document.title === "A");
		expect(await h1(page)).toBe("Page A");
		expect(await page.evaluate(() => scrollY)).toBe(1200);
		await page.goForward();
		await page.waitForFunction(() => document.title === "B");
		expect(await page.evaluate(() => scrollY)).toBe(2000);
		expect(await page.evaluate(() => (window as any).__loads)).toBe(1);
		await page.context().close();
	});

	e2e("a hash link's entry (null state), then a visit, then Back shows the right page", async () => {
		const page = await open("/a");
		await page.click("#jump");
		await page.waitForFunction(() => location.hash === "#results");
		expect(await page.evaluate(() => history.state)).toBeNull();
		const y = await page.evaluate(() => scrollY);
		expect(y).toBeGreaterThan(4000);
		await page.click("#to-b");
		await page.waitForFunction(() => document.title === "B");
		await page.goBack();
		await page.waitForFunction(() => document.title === "A");
		expect(await page.evaluate(() => location.pathname + location.hash)).toBe("/a#results");
		expect(await h1(page)).toBe("Page A");
		expect(await page.evaluate(() => scrollY)).toBe(y);
		await page.goBack();
		await page.waitForFunction(() => location.hash === "");
		expect(await h1(page)).toBe("Page A");
		expect(await page.evaluate(() => (window as any).__loads)).toBe(1);
		await page.context().close();
	});

	e2e("listeners do not stack across visits", async () => {
		const page = await open("/a");
		for (const to of ["#to-b", "#to-a", "#to-b", "#to-a", "#to-b"]) {
			const title = to === "#to-b" ? "B" : "A";
			await page.click(to);
			await page.waitForFunction((t: string) => document.title === t, title);
		}
		await page.evaluate(() => ((window as any).__clicks = 0));
		await page.click("#count");
		expect(await page.evaluate(() => (window as any).__clicks)).toBe(1);
		expect(await page.textContent("#count")).toBe("1");
		expect(await page.evaluate(() => document.querySelectorAll('script[src="/_a/js/counter.js"]').length)).toBe(1);
		expect(await page.evaluate(() => (window as any).__loads)).toBe(1);
		await page.context().close();
	});

	e2e("an unconverted script makes the next click a full load", async () => {
		const page = await open("/a");
		await page.click("#to-legacy");
		await page.waitForFunction(() => document.title === "Legacy");
		expect(await page.evaluate(() => [(window as any).__legacy, (window as any).__loads])).toEqual([1, 1]);
		await page.click("#to-a");
		await page.waitForFunction(() => document.title === "A" && (window as any).__loads === 2);
		expect(await h1(page)).toBe("Page A");
		expect(seen.at(-1)).toEqual({ path: "/a", nav: null, prefetch: null });
		await page.context().close();
	});

	e2e("<noscript> in a part is stripped: DOMParser reads it as markup, and its style would hide the ad", async () => {
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
		await page.waitForFunction(() => document.title === "B");
		await page.waitForTimeout(100);
		expect(await page.evaluate(() => getComputedStyle(document.getElementById("ad")!).display)).toBe("block");
		expect(await page.evaluate(() => document.querySelectorAll("noscript").length)).toBe(0);
		// The style element DOMParser made inside the noscript is never used,
		// but Chromium still reports it against the page's style-src. Parsing
		// any inline style does this; only noscript adds reports a real load
		// would not. Stripping noscript from parts on the server would end it.
		expect(await page.evaluate(() => (window as any).__csp)).toEqual(["style-src-elem inline"]);
		await page.context().close();
	});

	e2e("a redirect is followed softly; a hover prefetches and the click uses it; a refused prefetch is fetched again", async () => {
		const page = await open("/a");
		await page.click("#to-old");
		await page.waitForFunction(() => document.title === "C");
		expect(await page.evaluate(() => location.pathname)).toBe("/c");
		const before = seen.length;
		await page.hover("#to-b");
		await page.waitForFunction(() => performance.getEntriesByName(`${location.origin}/b`).length > 0);
		await page.waitForTimeout(50);
		expect(seen.slice(before).map((s) => [s.path, s.prefetch])).toEqual([["/b", "1"]]);
		await page.click("#to-b");
		await page.waitForFunction(() => document.title === "B");
		expect(seen.slice(before).filter((s) => s.path === "/b").length).toBe(1);
		await page.hover("#to-quiet");
		await page.waitForTimeout(250);
		await page.click("#to-quiet");
		await page.waitForFunction(() => document.title === "Quiet");
		expect(seen.slice(before).filter((s) => s.path === "/quiet").map((s) => s.prefetch)).toEqual(["1", null]);
		expect(await page.evaluate(() => (window as any).__loads)).toBe(1);
		await page.context().close();
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
		await page.waitForFunction(() => document.title === "Slow");
		expect(await page.evaluate(() => (window as any).__loads)).toBe(2);
		// A restore from the cache fires no load event, which goBack waits for by default.
		await page.goBack({ waitUntil: "commit" });
		await page.waitForFunction(() => document.title === "A");
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
		await page.waitForFunction(() => document.title === "B");
		expect(await page.evaluate(() => (window as any).__loads)).toBe(1);
		await page.context().close();
	});

	e2e("a view transition runs only when <html data-natsu-transition> opts in", async () => {
		const page = await open("/c");
		await page.evaluate(() => {
			const w = window as unknown as { __vt: number };
			w.__vt = 0;
			const start = document.startViewTransition.bind(document);
			document.startViewTransition = (cb?: ViewTransitionUpdateCallback) => (w.__vt++, start(cb));
		});
		await page.click("#to-a");
		await page.waitForFunction(() => document.title === "A");
		expect(await page.evaluate(() => (window as any).__vt)).toBe(0);
		const vt = await open("/vt");
		await vt.evaluate(() => {
			const w = window as unknown as { __vt: number };
			w.__vt = 0;
			const start = document.startViewTransition.bind(document);
			document.startViewTransition = (cb?: ViewTransitionUpdateCallback) => (w.__vt++, start(cb));
		});
		await vt.click("#to-c");
		await vt.waitForFunction(() => document.title === "C");
		expect(await vt.evaluate(() => (window as any).__vt)).toBe(1);
		await page.context().close();
		await vt.context().close();
	});

	// The spec's font guard (load the new sheet's copies of loaded faces
	// first) is not in the runtime because of what this showed: with the font
	// cacheable, as natsu serves /_a/, Chromium takes the new face from the
	// memory cache and nothing flashes with or without the guard; served
	// no-store, the text flashes with or without it, because removing the old
	// sheet makes Chromium build every face afresh (and right after a sheet's
	// load event, document.fonts still lists all faces as unloaded).
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
		await page.waitForFunction(() => document.title === "C");
		await page.waitForTimeout(300);
		const widths: number[] = await page.evaluate(() => ((window as any).__stop = true) && (window as any).__widths);
		expect([...new Set(widths)]).toEqual([width]);
		await page.context().close();
	});
});
