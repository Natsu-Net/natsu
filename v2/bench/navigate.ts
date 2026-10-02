/**
 * What a page navigation costs the server.
 *
 * A navigation is rendered and rewritten like any page; what it adds is the
 * cut: find the head, the regions and the script list, hash the shell, and
 * build the part. Every full page with a region pays most of that too, for
 * its key. This measures both at three page sizes (19, 72 and 282 KB, the
 * sizes the design was judged on), next to what the page already costs:
 * the asset rewrite that profiles it, and the brotli pass `compress()` makes.
 * Then the same through the whole pipeline, in process, with no socket.
 *
 *   bun run bench/navigate.ts [--runs 400]
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliCompressSync, constants } from "node:zlib";
import { Assets } from "../src/assets.ts";
import { setConfig } from "../src/config.ts";
import { setColorEnabled } from "../src/logger.ts";
import { navigable, partOf, scanPage, shellOf } from "../src/navigate.ts";
import { Router } from "../src/router.ts";
import { Application } from "../src/server.ts";

setColorEnabled(false);
setConfig({ General: { logFormat: "", logLevel: "silent" }, Session: { enabled: false, driver: "none" }, Static: { enabled: false } });

const runsFlag = Bun.argv.indexOf("--runs");
const RUNS = runsFlag === -1 ? 400 : Math.max(10, Number(Bun.argv[runsFlag + 1]) || 400);

const NONCE = "f6be73b6f072bc2f9b7e15193cd1e178";
const CSS = `body{margin:0}.hdr{position:sticky;top:0}.hidden{display:none}@media(min-width:768px){.md\\:flex{display:flex}}
.grid{display:grid}.gap-4{gap:1rem}.card{border:1px solid}.flex{display:flex}.items-center{align-items:center}
.rounded{border-radius:.5rem}.text-sm{font-size:.875rem}.foot{opacity:.8}.badge{padding:2px}`;

const WORDS = ["Anti-cheat", "Economy", "Shop", "Maps", "Permissions", "Chat", "Backups", "Quests", "Claims", "Discord bridge", "Holograms", "Voting", "Skins", "Minigames", "Kits", "Warps"];

/** A storefront-shaped page of about `kb` kilobytes: head, header with a form, main, footer, scripts. */
function page(kb: number): string {
	const head = `<!doctype html><html lang="en" data-csrf-cookie="__Host-csrf"><head><meta charset="utf-8">` +
		`<meta name="viewport" content="width=device-width, initial-scale=1"><title>Browse · Shop</title>` +
		`<meta name="description" content="Plugins, addons and downloads from independent creators.">` +
		`<link rel="canonical" href="https://shop.example/products"><meta property="og:title" content="Browse · Shop">` +
		`<link rel="preload" href="/fonts/inter.woff2" as="font" type="font/woff2" crossorigin>` +
		`<link rel="stylesheet" href="/assets/site.css"></head>`;
	const header = `<body class="min-h-screen"><a href="#main" class="sr-only">Skip to content</a><header class="hdr">` +
		`<nav class="hidden md:flex">${'<a href="/products" class="text-sm">Browse</a>'.repeat(12)}</nav>` +
		`<form method="post" action="/auth/logout"><input type="hidden" name="csrf" value="0123456789abcdef0123456789abcdef"></form></header>`;
	const footer = `<footer id="site-footer" data-natsu-region class="foot">${'<a href="/legal/terms" class="text-sm">Terms</a>'.repeat(30)}</footer>` +
		`<div role="dialog" data-consent-banner hidden></div>` +
		`<script src="/assets/site.js" nonce="${NONCE}" defer></script><script src="/assets/catalog.js" nonce="${NONCE}" defer></script></body></html>`;
	// Cards differ as real listings do, so brotli cannot fold them into one.
	const card = (i: number) => `<a href="/p/vendor-${i % 97}/item-${i}" class="flex items-center gap-4 rounded card">` +
		`<img src="/i/${(i * 2654435761 >>> 0).toString(36)}.webp" alt="" width="64" height="64">` +
		`<p class="text-sm">${WORDS[i % WORDS.length]} ${WORDS[(i * 7) % WORDS.length]} for ${WORDS[(i * 13) % WORDS.length]} servers, v${i % 9}.${i % 17}</p>` +
		`<span class="badge">${i % 3 === 0 ? "Free" : `$${(i % 40) + 1}.99`}</span></a>`;
	let main = `<main id="main" data-natsu-region><script type="application/ld+json" nonce="${NONCE}">{"name":"tricky </main> text"}</script><section class="grid gap-4">`;
	const fixed = head.length + header.length + footer.length + main.length + "</section></main>".length;
	for (let i = 0; fixed + main.length < kb * 1024; i++) main += card(i);
	return `${head}${header}${main}</section></main>${footer}`;
}

function time(fn: () => unknown, runs = RUNS): number {
	for (let i = 0; i < Math.min(50, runs); i++) fn();
	const started = Bun.nanoseconds();
	for (let i = 0; i < runs; i++) fn();
	return (Bun.nanoseconds() - started) / 1e6 / runs;
}

async function timeAsync(fn: () => Promise<unknown>, runs = RUNS): Promise<number> {
	for (let i = 0; i < Math.min(50, runs); i++) await fn();
	const started = Bun.nanoseconds();
	for (let i = 0; i < runs; i++) await fn();
	return (Bun.nanoseconds() - started) / 1e6 / runs;
}

const ms = (value: number) => value.toFixed(3).padStart(8);
const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)} KB`.padStart(9);

const dir = mkdtempSync(join(tmpdir(), "natsu-bench-nav-"));
writeFileSync(join(dir, "site.css"), CSS);
const assets = new Assets({
	outDir: join(dir, "out"),
	styles: { site: [join(dir, "site.css")] },
	rewrite: { "/assets/site.css": "site" },
	minify: true,
	navigate: true,
});
await assets.build();

const brotli = (text: string) =>
	brotliCompressSync(new TextEncoder().encode(text), {
		params: { [constants.BROTLI_PARAM_QUALITY]: 5, [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT },
	});

console.log(`natsu navigate — Bun ${Bun.version}, ${RUNS} runs per figure, ms per page\n`);
console.log("page         scan      part   full key   rewrite  brotli5 full  brotli5 part   full br    part br");
console.log("-".repeat(106));

const pages = new Map<number, string>();
for (const size of [19, 72, 282]) {
	const raw = page(size);
	const html = assets.rewrite(raw);
	pages.set(size, html);
	const scan = scanPage(html);
	if (!scan || "reason" in scan) throw new Error(`the ${size} KB page has no regions`);

	const scanMs = time(() => scanPage(html));
	const partMs = time(() => {
		const s = scanPage(html) as Exclude<ReturnType<typeof scanPage>, null | { reason: string }>;
		const shell = Bun.hash(shellOf(html, s)).toString(36);
		return partOf(html, s, `a.${shell}`, [NONCE]);
	});
	const fullMs = time(() => {
		const s = scanPage(html) as Exclude<ReturnType<typeof scanPage>, null | { reason: string }>;
		const shell = Bun.hash(shellOf(html, s)).toString(36);
		const at = s.head[2];
		return `${html.slice(0, at)}<meta name="natsu" content="a.${shell}">${html.slice(at)}`;
	});
	const rewriteMs = time(() => assets.rewrite(raw), Math.max(10, RUNS >> 2));
	const part = partOf(html, scan, "a.b", [NONCE]);
	const fullBr = brotli(html);
	const partBr = brotli(part);
	const brFullMs = time(() => brotli(html), Math.max(10, RUNS >> 2));
	const brPartMs = time(() => brotli(part), Math.max(10, RUNS >> 2));
	console.log(
		`${kb(html.length)} ${ms(scanMs)}  ${ms(partMs)}  ${ms(fullMs)}  ${ms(rewriteMs)}  ${ms(brFullMs)}      ${ms(brPartMs)}  ${kb(fullBr.length)}  ${kb(partBr.length)}`,
	);
}

// The whole pipeline, in process: a route that answers the page already
// rewritten (as PageCache does), so what differs is the navigation step.
Router.clear();
let current = "";
new Router().get("/page", navigable((ctx) => {
	ctx.response.headers.set("content-security-policy", `script-src 'nonce-${NONCE}' 'strict-dynamic'`);
	assets.markRewritten(ctx);
	return current;
}));
const app = new Application({ sessions: false });
app.use(assets.middleware());

console.log("\nthrough app.handle (page already rewritten), ms per request");
console.log("page        full page   navigation   navigation, stale key");
console.log("-".repeat(60));
for (const [size, html] of pages) {
	current = html;
	const full = await app.handle(new Request("http://bench.test/page"));
	const key = /<meta name="natsu" content="([^"]+)">/.exec(await full.text())?.[1] ?? "";
	const [doc] = key.split(".");
	const fullMs = await timeAsync(async () => (await app.handle(new Request("http://bench.test/page"))).text());
	const navMs = await timeAsync(async () => (await app.handle(new Request("http://bench.test/page", { headers: { "natsu-nav": key } }))).text());
	const staleMs = await timeAsync(async () =>
		(await app.handle(new Request("http://bench.test/page", { headers: { "natsu-nav": `${doc}.zzz` } }))).text()
	);
	console.log(`${kb(html.length)}   ${ms(fullMs)}     ${ms(navMs)}     ${ms(staleMs)}`);
	void size;
}

await assets.settled();
rmSync(dir, { recursive: true, force: true });
