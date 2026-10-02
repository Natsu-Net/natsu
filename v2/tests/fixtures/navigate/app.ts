/**
 * A small natsu app for the page-switching browser suite
 * (`tests/navigate.e2e.ts`), written the way an app writes one: natsu's own
 * `Application`, `Router`, `Assets` with `navigate: true`, `PageCache` for
 * the pages every visitor sees alike, `compress()`, and a CSP with a fresh
 * nonce and `'strict-dynamic'` on every page. Nothing in it fakes the wire
 * format; whatever the browser sees is what natsu answered.
 *
 * Two layouts. The site layout is a fixed header (whose nav is
 * `hidden md:flex`, the class pair a region-only stylesheet would break), a
 * `main` region and a `footer` region. The account layout adds a sidebar to
 * the shell and opts into view transitions on `<html>`, so going from one
 * layout to the other is a different shell and a real load, and moving
 * within the account layout is a soft visit.
 *
 * The pages, each there for a case the suite checks:
 *
 *  - `/a`, `/b`, `/c`: plain pages with different stylesheet chunks. A and B
 *    list `counter.js` (a converted script), B also `b-only.js`; B's main
 *    holds an ad spot with a `<noscript><style>` that would hide it; `/c`
 *    shows and clears a flash cookie through `ctx.nav.shown()`.
 *  - `/p/1` to `/p/40` and `/catalog`: kept by PageCache with the nonce and the
 *    visitor's CSRF token as secrets; the product page also has the token in
 *    a form inside its main region.
 *  - `/legacy`: lists a script that never calls `natsu.mount`. Page A also
 *    has a link marked `data-natsu-reload`.
 *  - `/quiet`: navigable without prefetch. `/slow`: a navigation answered
 *    after 400 ms with `ctx.nav.reload()`. `/old`: a redirect to `/c` that
 *    sets the flash; `/away`, one to another origin. `/plain`: not navigable. `/missing`: a 404 page in the
 *    shell. `/ads`: a CSP that allows another image host, checked with
 *    `ctx.nav.stale()` before anything is drawn.
 *  - The header holds a search form (GET `/catalog`) and an island,
 *    `data-natsu-island="/bell"`, filled after load from `/bell`.
 *  - `/account`, `/account/orders`: the account layout, with an inline
 *    `<style nonce>` of its own in the head and the orders page one more;
 *    `account.js` runs a clock that its cleanup must stop.
 *
 * `state` changes the app from a test: a banner in the header (a different
 * shell), a held stylesheet, `'strict-dynamic'` on or off. `seen` records
 * every request with its navigation headers (read before natsu deletes them),
 * the answer natsu gave, and the time it took.
 *
 * Run on its own for a look in a browser:
 * `bun run tests/fixtures/navigate/app.ts` (port 5940, or `PORT`).
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Application, Assets, PageCache, Router, compress, navigable, resetConfig, setConfig } from "../../../index.ts";
import type { Context, Handler, Middleware } from "../../../index.ts";

const HERE = import.meta.dir;

/** A font the suite can watch for a fallback flash; the first one this machine has. */
export const FONT = [
	"/usr/share/fonts/truetype/liberation/LiberationSerif-Regular.ttf",
	"/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf",
].find((file) => existsSync(file));

/** Page A's main, for building the stylesheet a region-only cut would give it. */
export const MAIN_A =
	`<h1>Page A</h1><div id="wide" class="hidden lg:grid">wide</div><a id="jump" href="#results">results</a>` +
	`<button id="count" data-counter>0</button><a id="hard" href="/b" data-natsu-reload>B, loaded for real</a>` +
	`<div class="tall"></div><div id="results">results</div>`;

const MAIN_B =
	`<h1 class="text-red">Page B</h1><button id="count" data-counter>0</button><div data-ad-spot id="ad">ad</div>` +
	`<noscript><style>[data-ad-spot]{display:none}</style></noscript><div class="tall"></div>`;

/** Every link the header carries, the same on every page so the shell is too. */
const LINKS = ["a", "b", "c", "legacy", "old", "away", "quiet", "slow", "plain", "missing", "nowhere", "ads", "p/1", "p/2", "catalog", "account"];

export interface Seen {
	path: string;
	/** `Natsu-Nav` and `Natsu-Prefetch` as they arrived. */
	nav: string | null;
	prefetch: string | null;
	/** `Sec-Fetch-Mode`: `navigate` for a browser load, `cors` for the runtime's fetch. */
	mode: string | null;
	status: number;
	/** What natsu answered: "part", "page", "reload <reason>", "location <url>", "skip", or "other". */
	answer: string;
	/** Server time, from the outermost middleware (compression included), in milliseconds. */
	ms: number;
}

export interface NavigateApp {
	app: Application;
	assets: Assets;
	pages: PageCache;
	/** What a test may change. */
	state: { banner: string; cssDelay: number; strict: boolean };
	seen: Seen[];
	/** How often some handlers drew their page. */
	calls: { plain: number; ads: number; product: number; bell: number };
	start(port: number): Promise<string>;
	stop(): Promise<void>;
}

/** Words for a page's text, the same for the same seed: text that compresses like text, not like a repeated line. */
const WORDS = (
	"anime season episode studio release review score opening ending soundtrack character story arc volume chapter " +
	"manga light novel adaptation director voice cast premiere finale special edition box set collector bonus artbook " +
	"poster figure scale limited stock shipping order cart price discount bundle preorder delivery region subtitle dub " +
	"streaming platform weekly ranking popular trending classic modern action drama comedy romance mystery fantasy " +
	"science fiction slice of life sports music idol mecha isekai thriller horror historical school adventure friendship"
).split(" ");
function words(seed: number, count: number): string {
	let x = (seed * 2654435761) >>> 0 || 1;
	const out: string[] = [];
	for (let i = 0; i < count; i++) {
		x ^= x << 13;
		x ^= x >>> 17;
		x ^= x << 5;
		x >>>= 0;
		out.push(WORDS[x % WORDS.length]!);
	}
	return out.join(" ");
}

/** The header's browse menu. */
const GENRES = ["action", "adventure", "comedy", "drama", "fantasy", "horror", "mecha", "music", "mystery", "romance", "sports", "thriller"];

const escape = (text: string): string =>
	text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Build the app: its assets, its routes, its middleware. Routes go into natsu's global table. */
export async function navigateApp(options: { development?: boolean } = {}): Promise<NavigateApp> {
	resetConfig();
	setConfig({
		General: { logFormat: "", logLevel: options.development ? "info" : "silent", development: options.development ?? false },
		Session: { driver: "memory", sweepInterval: 0 },
		Static: { enabled: false },
	});
	Router.clear();

	const outDir = mkdtempSync(join(tmpdir(), "natsu-navigate-e2e-"));
	const assets = new Assets({
		outDir,
		minify: true,
		styles: { site: [join(HERE, "site.css")] },
		classicScripts: {
			counter: join(HERE, "js/counter.js"),
			"b-only": join(HERE, "js/b-only.js"),
			legacy: join(HERE, "js/legacy.js"),
			account: join(HERE, "js/account.js"),
		},
		rewrite: {
			"/assets/site.css": "site",
			"/assets/js/counter.js": "counter",
			"/assets/js/b-only.js": "b-only",
			"/assets/js/legacy.js": "legacy",
			"/assets/js/account.js": "account",
		},
		navigate: true,
	});
	await assets.build();
	const pages = new PageCache({ prepare: (html) => assets.rewrite(html) });

	const state = { banner: "", cssDelay: 0, strict: true };
	const seen: Seen[] = [];
	const calls = { plain: 0, ads: 0, product: 0, bell: 0 };

	// --- the page ---------------------------------------------------------------

	/** A fresh nonce and the policy that carries it; `extra` adds directives. */
	const policy = (nonce: string, extra = ""): string =>
		`default-src 'self'; script-src 'nonce-${nonce}'${state.strict ? " 'strict-dynamic'" : ""}; style-src 'self' 'nonce-${nonce}'; ` +
		`font-src 'self'; img-src 'self'${extra}; object-src 'none'; base-uri 'none'`;
	const nonceOf = (): string => crypto.randomUUID().replaceAll("-", "");
	const secure = (ctx: Context, extra = ""): string => {
		const nonce = nonceOf();
		ctx.response.headers.set("content-security-policy", policy(nonce, extra));
		return nonce;
	};
	/** The visitor's CSRF token, from a cookie the suite sets: the same for every page they see. */
	const csrfOf = (ctx: Context): string => {
		const visitor = ctx.cookies.get("visitor") ?? "";
		return `tok-${/^[a-z]{1,20}$/.test(visitor) ? visitor : "anon"}`;
	};

	interface Page {
		nonce: string;
		csrf: string;
		title: string;
		main: string;
		/** More for the head; `{nonce}` stands for this response's nonce. */
		head?: string;
		scripts?: string[];
		layout?: "site" | "account";
	}

	const header = (csrf: string): string =>
		`<header id="hdr" class="hdr"><nav id="nav" class="hidden md:flex">` +
		LINKS.map((to) => `<a id="to-${to.replace("/", "")}" href="/${to}">${to}</a> `).join("") +
		`</nav><span class="probe" id="probe">Probe WWW iii</span>` +
		`<form role="search" method="get" action="/catalog"><input type="search" name="q" placeholder="Search the catalog" aria-label="Search"></form>` +
		`<details class="menu"><summary>Browse</summary><ul>` +
		GENRES.map((genre) => `<li><a href="/catalog?genre=${genre}">${genre[0]!.toUpperCase()}${genre.slice(1)}</a></li>`).join("") +
		`</ul></details>` +
		// An island: the shell holds only its frame, so who is asking never changes the shell.
		`<div id="bell" data-natsu-island="/bell">…</div>` +
		`<form method="post" action="/logout"><input type="hidden" name="csrf" value="${csrf}"></form>` +
		(state.banner ? `<p id="banner" class="banner">${escape(state.banner)}</p>` : "") +
		`</header>`;

	const layout = (page: Page): string => {
		const account = page.layout === "account";
		const main = `<main id="main" data-natsu-region>${page.main}</main>`;
		return `<!doctype html><html lang="en"${account ? " data-natsu-transition" : ""}><head><meta charset="utf-8">` +
			`<meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(page.title)}</title>` +
			`<link rel="stylesheet" href="/assets/site.css">` +
			// The account layout's own inline style, the same on its every page.
			(account ? `<style nonce="${page.nonce}">#clock{color:rgb(0,128,0)}</style>` : "") +
			(page.head ?? "").replaceAll("{nonce}", page.nonce) +
			`</head><body>${header(page.csrf)}` +
			(account
				? `<div class="account"><aside class="side"><a id="side-account" href="/account">Account</a> ` +
					`<a id="side-orders" href="/account/orders">Orders</a></aside>${main}</div>`
				: main) +
			`<footer id="foot" data-natsu-region class="foot">footer ${escape(page.title)}</footer>` +
			(page.scripts ?? []).map((name) => `<script src="/assets/js/${name}.js" nonce="${page.nonce}" defer></script>`).join("") +
			`</body></html>`;
	};

	type Draw = (ctx: Context, csrf: string) => Omit<Page, "nonce" | "csrf">;

	/** A page drawn per request. */
	const own = (draw: Draw): Handler => (ctx) => {
		const csrf = csrfOf(ctx);
		return layout({ nonce: secure(ctx), csrf, ...draw(ctx, csrf) });
	};

	/**
	 * A page kept for everyone: drawn once with marks where the nonce and
	 * the visitor's token go, and filled in with each visitor's own.
	 */
	const shared = (draw: Draw): Handler => async (ctx) => {
		const kept = await pages.serve(ctx.path, [secure(ctx), csrfOf(ctx)], async ([nonce, csrf]) => ({
			body: layout({ nonce: nonce!, csrf: csrf!, ...draw(ctx, csrf!) }),
			status: 200,
		}));
		if (kept?.prepared) assets.markRewritten(ctx);
		return kept?.body;
	};

	// --- the routes ---------------------------------------------------------------

	const Routes = new Router();
	Routes.get("/a", navigable(own(() => ({ title: "A", main: MAIN_A, scripts: ["counter"] }))));
	Routes.get("/b", navigable(own(() => ({ title: "B", main: MAIN_B, scripts: ["counter", "b-only"] }))));
	Routes.get("/c", navigable((ctx) => {
		const flash = ctx.cookies.get("flash");
		// A prefetch must not use the flash up unseen; a refused answer must not clear it.
		if (flash && ctx.nav.skip()) return;
		if (flash) ctx.nav.shown(() => ctx.deleteCookie("flash", { path: "/" }));
		const note = flash ? `<p id="flash" class="flash">${escape(flash)}</p>` : "";
		// A counter with no counter.js listed: its mount must not run here.
		return layout({ nonce: secure(ctx), csrf: csrfOf(ctx), title: "C", main: `${note}<h1>Page C</h1><button id="count" data-counter>0</button>` });
	}));
	Routes.get("/legacy", navigable(own(() => ({ title: "Legacy", main: "<h1>Legacy</h1>", scripts: ["legacy"] }))));
	Routes.get("/quiet", navigable(own(() => ({ title: "Quiet", main: "<h1>Quiet</h1>" })), { prefetch: false }));
	Routes.get("/slow", navigable(async (ctx) => {
		if (ctx.nav.requested) {
			await Bun.sleep(400);
			ctx.nav.reload("the suite's slow page");
			return;
		}
		return layout({ nonce: secure(ctx), csrf: csrfOf(ctx), title: "Slow", main: "<h1>Slow</h1>" });
	}));
	Routes.get("/old", navigable((ctx) => {
		ctx.setCookie("flash", "moved", { path: "/" });
		ctx.response.redirect("/c");
	}));
	// Followed softly only on this origin: localhost is another origin than 127.0.0.1.
	Routes.get("/away", navigable((ctx) => ctx.response.redirect(`http://localhost:${ctx.url.port}/c`)));
	// The island's content: a plain GET with no navigation header, drawn per visitor.
	Routes.get("/bell", (ctx) => {
		calls.bell++;
		return `<span id="bell-count">${calls.bell}</span> new for ${escape(csrfOf(ctx))}`;
	});
	Routes.get("/plain", (ctx) => {
		calls.plain++;
		return layout({ nonce: secure(ctx), csrf: csrfOf(ctx), title: "Plain", main: "<h1>Plain</h1>" });
	});
	Routes.get("/missing", navigable(own((ctx) => {
		ctx.response.status = 404;
		return { title: "Not found", main: "<h1>Not found</h1>" };
	})));
	Routes.get("/ads", navigable((ctx) => {
		const nonce = nonceOf();
		const csp = policy(nonce, " https://ads.example.com");
		// Before any data is fetched: a document whose CSP differs cannot take this page.
		if (ctx.nav.stale(new Headers({ "content-security-policy": csp }))) return;
		calls.ads++;
		ctx.response.headers.set("content-security-policy", csp);
		return layout({ nonce, csrf: csrfOf(ctx), title: "Ads", main: "<h1>Ads</h1>" });
	}));
	// Products are routes of their own rather than `/p/:id`, so app.handle
	// (which matches paths literally) can measure them too.
	for (let id = 1; id <= 40; id++) {
		Routes.get(`/p/${id}`, navigable(shared((_ctx, csrf) => {
			calls.product++;
			const specs = Array.from({ length: 16 }, (_, i) => `<li><span class="muted">${words(id * 100 + i, 2)}</span> ${words(id * 1000 + i, 5)}</li>`).join("");
			const reviews = Array.from({ length: 5 }, (_, i) => `<article class="card"><h2>${words(id * 77 + i, 4)}</h2><p>${words(id * 911 + i, 45)}</p></article>`).join("");
			return {
				title: `Product ${id}`,
				main:
					`<h1>Product ${id}</h1><p class="price">${id * 9}.99</p><p>${words(id, 120)}</p><ul>${specs}</ul>` +
					`<form method="post" action="/cart"><input type="hidden" name="csrf" value="${csrf}"><button>Add to cart</button></form>` +
					`<section>${reviews}</section>`,
				scripts: ["counter"],
			};
		})));
	}
	Routes.get("/catalog", navigable(shared(() => ({
		title: "Catalog",
		main: `<h1>Catalog</h1><section class="cards">${Array.from({ length: 40 }, (_, i) =>
			`<a class="card" href="/p/${i + 1}"><span>${words(i + 1, 3)}</span> <span class="price">${(i + 1) * 9}.99</span>` +
			`<span class="muted">${words((i + 1) * 31, 14)}</span></a>`).join("")}</section>`,
	}))));
	Routes.get("/account", navigable(own(() => ({
		layout: "account",
		title: "Account",
		main: '<h1>Account</h1><p>Ticks: <span id="clock" data-clock>0</span></p>',
		scripts: ["account"],
	}))));
	Routes.get("/account/orders", navigable(own(() => ({
		layout: "account",
		title: "Orders",
		main: '<h1>Orders</h1><p>Ticks: <span id="clock" data-clock>0</span></p><p id="orders-note">Two orders</p><ol><li>Order 1</li><li>Order 2</li></ol>',
		// This page's own inline style: after a soft visit it applies only with the document's nonce.
		head: '<style nonce="{nonce}">#orders-note{color:rgb(0,0,200)}</style>',
		scripts: ["account"],
	}))));
	const font = FONT ? readFileSync(FONT) : undefined;
	Routes.get("/fonts/probe.ttf", () =>
		font
			? new Response(font, { headers: { "content-type": "font/ttf", "cache-control": "public, max-age=31536000, immutable" } })
			: new Response("", { status: 404 }));

	// --- the middleware -------------------------------------------------------------

	/** Outermost: what arrived, what went out, and how long it took. */
	const record: Middleware = async (ctx, next) => {
		const headers = ctx.request.headers;
		const entry: Seen = {
			path: ctx.path + ctx.url.search,
			nav: headers.get("natsu-nav"),
			prefetch: headers.get("natsu-prefetch"),
			mode: headers.get("sec-fetch-mode"),
			status: 0,
			answer: "",
			ms: 0,
		};
		const started = Bun.nanoseconds();
		await next();
		entry.ms = (Bun.nanoseconds() - started) / 1e6;
		const response = ctx.response;
		const out = response.headersInitialized ? response.headers : new Headers();
		entry.status = response.status;
		entry.answer = out.get("natsu-part")
			? "part"
			: out.get("natsu-reload")
				? `reload ${out.get("natsu-reload")}`
				: out.get("natsu-location")
					? `location ${out.get("natsu-location")}`
					: out.get("natsu-prefetch") === "skip"
						? "skip"
						: (out.get("content-type") ?? "").includes("html") ? "page" : "other";
		if (!ctx.path.startsWith("/_a/") && !ctx.path.startsWith("/fonts/")) seen.push(entry);
	};
	/** Holds stylesheets back while `state.cssDelay` says so. */
	const holdSheets: Middleware = async (ctx, next) => {
		if (state.cssDelay && ctx.path.endsWith(".css")) await Bun.sleep(state.cssDelay);
		await next();
	};

	const app = new Application({ sessions: false });
	app.use(record);
	app.use(compress());
	app.use(holdSheets);
	app.use(assets.middleware());

	return {
		app,
		assets,
		pages,
		state,
		seen,
		calls,
		async start(port) {
			const server = await app.start({ port, hostname: "127.0.0.1", quiet: true });
			return server.url.origin;
		},
		async stop() {
			await app.close(true);
			rmSync(outDir, { recursive: true, force: true });
		},
	};
}

if (import.meta.main) {
	const fixture = await navigateApp({ development: true });
	const origin = await fixture.start(Number(process.env.PORT ?? 5940));
	console.log(`natsu page-switching fixture on ${origin}/a`);
}
