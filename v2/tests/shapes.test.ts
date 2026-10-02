/**
 * Golden test: the CSS chunk every captured hub page gets is the one it got
 * before page shapes were read from kept class attribute values.
 *
 * `fixtures/shapes` holds seven storefront pages hub rendered from its stub
 * data (signed out: home, catalog, product, terms; signed in: product,
 * library, orders), with each page's nonce and CSRF token replaced by a
 * fixed word, and the `site.css` hub built for them. For each page, in every
 * mode the pipeline has (whole rules or split in two, class names as written
 * or renamed, one sheet or two with ids), the page goes through `rewrite`
 * with shapes remembered as they are in a running server, and is compared
 * with what the pipeline cut for it before: the page profiled whole by
 * `profileDocument` (or `renameAndProfile`), its shape keyed by its sorted
 * names, and its chunk cut from that profile the first time the key was
 * seen. The chunk URLs, their contents, the lazy halves, their triggers and
 * every other byte of the page must be the same, and two pages must share a
 * shape exactly when the old key said they did.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { type DocumentProfile, profileDocument } from "uwu-template/assets";
import { renameAndProfile } from "uwu-template/assets/mangle";
import { Assets, type AssetsOptions } from "../src/assets.ts";
import type { PageShape, PageShapes } from "../src/page-shape.ts";

const FIXTURES = join(import.meta.dir, "fixtures", "shapes");
const PAGES = readdirSync(FIXTURES)
	.filter((file) => file.endsWith(".html"))
	.sort()
	.map((file) => ({ name: file.slice(0, -".html".length), html: readFileSync(join(FIXTURES, file), "utf8") }));

/**
 * A second sheet, so a page is cut for two sheets at once and some rules
 * name ids (hub's own names none).
 */
const EXTRA_CSS = String.raw`
#main{scroll-margin-top:4rem}
#buy .flex{gap:2px}
#results,#browse-sort{min-height:1px}
#step-up-error.hidden{display:none}
.lg\:block #demo{color:red}
#review-1{color:blue}
.text-danger{color:crimson}
.flex{display:flex}
.grid{display:grid}
.unknown-thing{color:green}
@media (min-width:640px){#header-q{width:20rem}}
`;

/** Hub's own safelist, and more for a lazy half to hold. */
const SAFELIST = [/^text-danger$/, /^group-open:/, /^peer-checked:/, /^hover:/, /^has-\[/];
const LAZY = { eager: [/^group-open:/], whenPresent: { "lg:block": [/^peer-/] } };

interface Mode {
	label: string;
	sheets: string[];
	options: Partial<AssetsOptions>;
}

const MANGLE = { scripts: [], markup: [FIXTURES] };
const MODES: Mode[] = [
	{ label: "shakeCSS", sheets: ["site"], options: {} },
	{ label: "splitCSS (lazyStyles)", sheets: ["site"], options: { safelist: SAFELIST, lazyStyles: LAZY } },
	{ label: "shakeCSS, classes renamed", sheets: ["site"], options: { mangle: MANGLE } },
	{ label: "splitCSS, classes renamed", sheets: ["site"], options: { safelist: SAFELIST, lazyStyles: LAZY, mangle: MANGLE } },
	{ label: "two sheets with ids, splitCSS, classes renamed", sheets: ["site", "extra"], options: { safelist: SAFELIST, lazyStyles: LAZY, mangle: MANGLE } },
];

/** What of a pipeline these tests look into. */
interface Internals {
	pages: Map<string, unknown>;
	files: Map<string, { body: string }>;
	lazy: Map<string, { url: string; triggers: string[] }>;
	classes: Map<string, string>;
	names: Map<string, { classes: Set<string>; ids: Set<string> }>;
	shapes: PageShapes;
}
const internals = (pipeline: Assets) => pipeline as unknown as Internals;

let dir: string;
beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "natsu-shapes-"));
	writeFileSync(join(dir, "extra.css"), EXTRA_CSS);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function pipeline(mode: Mode, out: string): Assets {
	return new Assets({
		outDir: join(dir, out),
		minify: true,
		safelist: [/^text-danger$/],
		...mode.options,
		styles: Object.fromEntries(mode.sheets.map((sheet) => [sheet, [sheet === "site" ? join(FIXTURES, "site.css") : join(dir, "extra.css")]])),
		rewrite: Object.fromEntries(mode.sheets.map((sheet) => [`/assets/${sheet}.css`, sheet])),
	});
}

/** The page as the test serves it: hub's link, and the second sheet's after it. */
function linked(mode: Mode, html: string): string {
	if (!mode.sheets.includes("extra")) return html;
	return html.replace('<link rel="stylesheet" href="/assets/site.css">', '$&<link rel="stylesheet" href="/assets/extra.css">');
}

/** The page profiled whole, the old way, and renamed when classes are. */
function profiled(reference: Assets, html: string): { html: string; profile: DocumentProfile } {
	const classes = internals(reference).classes;
	return classes.size > 0 ? renameAndProfile(html, classes) : { html, profile: profileDocument(html) };
}

/**
 * The chunk `sheet` gets for a page with this old profile, cut the first
 * time its old key is seen, as the pipeline did before: `reference` is
 * handed the old profile, and remembers nothing itself.
 */
function cutBefore(reference: Assets, cuts: Map<string, Cut>, sheet: string, html: string, profile: DocumentProfile): Cut {
	const key = oldKey(reference, sheet, profile);
	let cut = cuts.get(key);
	if (cut) return cut;
	const r = internals(reference);
	r.pages.clear();
	const url = reference.pageStyle(sheet, html, profile);
	const later = r.lazy.get(url);
	cut = {
		key,
		url,
		body: r.files.get(basename(url))?.body,
		later: later && { url: later.url, triggers: later.triggers, body: r.files.get(basename(later.url))?.body },
	};
	cuts.set(key, cut);
	return cut;
}

interface Cut {
	key: string;
	url: string;
	body: string | undefined;
	later: { url: string; triggers: string[]; body: string | undefined } | undefined;
}

/** The key a page had before: its sorted names that the sheet's rules name. */
function oldKey(reference: Assets, sheet: string, profile: DocumentProfile): string {
	const names = internals(reference).names.get(sheet);
	const named = (found: Set<string>, known: Set<string> | undefined): string => {
		const list: string[] = [];
		for (const item of found) if (!known || known.has(item)) list.push(item);
		return list.sort().join(" ");
	};
	return Bun.hash(`${sheet}\n${named(profile.classes, names?.classes)}\n${named(profile.ids, names?.ids)}`).toString(36);
}

/** Pages that share a shape with a captured one, or differ from it by a name a rule uses. */
function variants(html: string): Array<{ name: string; html: string }> {
	return [
		// Other words, other ids, a class no rule names: the same shape.
		{ name: "other content", html: html.replace(/>([^<>]*?)\d([^<>]*?)</g, ">$1#$2<").replace(/\sid="([^"]*)"/g, ' id="$1-2"') },
		{ name: "a class no rule names", html: html.replace(/<main\b/, '<main data-x="1" class="not-in-any-sheet"') },
		// A class some rule names, added: likely a shape of its own.
		{ name: "one more class", html: html.replace(/<body\b([^>]*)>/, '<body$1><p class="text-danger peer-checked:bg-accent/15"></p>') },
		{ name: "the id a rule names", html: html.replace(/<body\b([^>]*)>/, '<body$1><p id="review-1"></p>') },
	];
}

describe("every captured hub page gets the chunk it got before", () => {
	for (const mode of MODES) {
		test(mode.label, async () => {
			const kept = pipeline(mode, "kept");
			const reference = pipeline(mode, "reference");
			await kept.build();
			await reference.build();
			expect(internals(kept).classes).toEqual(internals(reference).classes);
			if (mode.options.mangle) expect(internals(kept).classes.size).toBeGreaterThan(100);

			const pages = PAGES.flatMap((page) => [page, ...variants(page.html).map((v) => ({ name: `${page.name}, ${v.name}`, html: v.html }))]);
			const cuts = new Map<string, Cut>();
			const before = new Map(pages.map((page) => {
				const html = linked(mode, page.html);
				const old = profiled(reference, html);
				return [page.name, { html, old, cuts: mode.sheets.map((sheet) => ({ sheet, cut: cutBefore(reference, cuts, sheet, old.html, old.profile) })) }];
			}));
			const keys = new Map<string, string>();
			const first = new Map<string, string>();
			let lazyPages = 0;
			// Twice, the second time backwards: every page then meets shapes
			// another page left, and the kept values from every page before.
			for (const round of [pages, [...pages].reverse()]) {
				for (const page of round) {
					const { html, old, cuts: wanted } = before.get(page.name)!;
					const out = kept.rewrite(html);
					let rest = out;
					for (const { sheet, cut } of wanted) {
						const url = new RegExp(`href="(/_a/${sheet}\\.[0-9a-f]{10}\\.css)"`).exec(out)?.[1];
						expect({ page: page.name, sheet, url }).toEqual({ page: page.name, sheet, url: cut.url });
						expect(internals(kept).files.get(basename(cut.url))?.body).toBe(cut.body!);
						const later = internals(kept).lazy.get(cut.url);
						expect(later?.url).toBe(cut.later?.url);
						expect(later?.triggers).toEqual(cut.later?.triggers);
						if (later) {
							lazyPages++;
							expect(internals(kept).files.get(basename(later.url))?.body).toBe(cut.later!.body!);
							expect(out).toContain(`l.href=${JSON.stringify(later.url)}`);
							expect(out).toContain(`S=${JSON.stringify(later.triggers.join(","))}`);
						}
						rest = rest.replace(`"${cut.url}"`, `"/assets/${sheet}.css"`);

						// The shape is the old profile's names, and the new key splits
						// pages exactly where the old one did.
						const shape: PageShape = mode.options.mangle
							? internals(kept).shapes.renameAndRead(html).shape
							: internals(kept).shapes.read(html);
						const whole = internals(kept).shapes.fromProfile(old.profile);
						expect([...shape.bits]).toEqual([...whole.bits]);
						if (shape.ids !== undefined) expect(shape.ids).toEqual(old.profile.ids);
						const now = internals(kept).shapes.key(sheet, shape);
						expect(keys.get(cut.key) ?? now).toBe(now);
						keys.set(cut.key, now);
						expect(first.get(now) ?? cut.key).toBe(cut.key);
						first.set(now, cut.key);
					}
					// Apart from the chunk links and their loaders, every byte is the old renamed page.
					expect(rest.replace(/<script>\(\(\)=>\{let d=0,a=document\.currentScript[\s\S]*?<\/script>/g, "")).toBe(old.html);
				}
			}
			// One remembered shape per old key, however many pages had it.
			expect(internals(kept).pages.size).toBe(keys.size);
			expect(keys.size).toBeLessThan(pages.length * mode.sheets.length);
			if (mode.options.lazyStyles) expect(lazyPages).toBeGreaterThan(0);
		});
	}
});
