/**
 * The asset pipeline: chunking, minification and deduplication.
 *
 * Three things, and each one is a different kind of waste:
 *
 * 1. **Chunking.** A site's stylesheet is written for the whole site, and
 *    every page pays for all of it. Given the markup a page actually
 *    rendered, `uwu-template`'s analyser drops the rules that cannot match,
 *    and what is left is that page's own chunk.
 * 2. **Minification.** JavaScript goes through `Bun.build`, CSS through a
 *    deliberately dull minifier that removes only what is provably not
 *    needed.
 * 3. **Deduplication.** Two kinds. Shared code between script entry points
 *    becomes one chunk both of them import, which is `Bun.build`'s code
 *    splitting. And two pages whose markup needs the same rules produce
 *    byte-identical CSS, so they get one file and one cache entry — chunks
 *    are addressed by the hash of their contents, so that falls out rather
 *    than being arranged.
 *
 * Every chunk's name carries its hash, which is what makes a year-long
 * `immutable` cache safe: a changed file is a different URL.
 *
 *   const assets = new Assets({
 *     outDir: "public/_a",
 *     styles: { site: ["public/assets/css/site.css"] },
 *     scripts: { site: "public/assets/js/site.js" },
 *     rewrite: { "/assets/css/site.css": "site", "/assets/js/site.js": "site" },
 *   });
 *   await assets.build();
 *   app.use(assets.middleware());
 *
 * Templates keep the paths they already have; `rewrite` says which of them
 * the pipeline owns, and pages go out pointing at the chunks.
 */

import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { type DocumentProfile, profileDocument, shakeCSS, splitCSS } from "uwu-template/assets";
import { cssClasses, planClassNames, renameAndProfile, renameCSSClasses } from "uwu-template/assets/mangle";
import { minifyCSS } from "uwu-template/assets/minify";
import type { Context, Middleware } from "./context.ts";
import { log } from "./logger.ts";

export interface AssetsOptions {
	/** Where built chunks are written. Created if it is not there. */
	outDir: string;
	/** URL prefix the chunks are served from. */
	publicPath?: string;
	/**
	 * Minify. Off in development by default, where a readable stack trace is
	 * worth more than the bytes.
	 */
	minify?: boolean;
	/**
	 * Module entry points, by name: the name is what `url()` takes.
	 *
	 * These are bundled together with code splitting, so a module two of them
	 * import ships once as a chunk both of them pull in.
	 */
	scripts?: Record<string, string>;
	/**
	 * Entry points for plain `<script src>` tags, by name.
	 *
	 * A classic script is not a module, so it cannot be handed an `import`,
	 * which is exactly what code splitting would give it. These are built one
	 * at a time as self-contained bundles: minified and hashed, never split.
	 */
	classicScripts?: Record<string, string>;
	/**
	 * Files served exactly as they are, by name, under a URL that carries
	 * their hash: vendor code that is already minified, where rebuilding it
	 * would risk the code and save nothing, but a year-long cache still pays.
	 */
	files?: Record<string, string>;
	/** Stylesheets, by name: the files are concatenated in order. */
	styles?: Record<string, string[]>;
	/**
	 * Selectors to keep in every chunk however the markup looks.
	 *
	 * A page's markup only shows what the server rendered, so anything a
	 * script adds later — `is-open`, `is-playing` — has to be named here or
	 * the rule that styles it is dropped as unreachable.
	 */
	safelist?: Array<string | RegExp>;
	/**
	 * Rename classes to short names in the stylesheets and in every page that
	 * goes out. `scripts` and `markup` are files or directories: every class
	 * a script names, builds from a fragment, or reads from an attribute
	 * keeps its name, because scripts are not rewritten. An entry starting
	 * with `!` leaves that path out. See
	 * `uwu-template/assets/mangle` for the rules.
	 */
	mangle?: {
		scripts: string[];
		markup: string[];
		keep?: Array<string | RegExp>;
	};
	/**
	 * Load only what the page's markup can match up front. The rules that
	 * only the safelist keeps — an open menu, a dialog, a toast — go in a
	 * second chunk that a few hundred bytes of inline script links the first
	 * time the visitor interacts or one of those classes appears.
	 */
	lazyStyles?: boolean | {
		/**
		 * Safelisted names whose rules stay in the page's own chunk: state a
		 * script toggles on an element already there (`/^is-/`), which it may
		 * act on — focus, measure — before a lazy stylesheet could arrive.
		 */
		eager?: Array<string | RegExp>;
		/**
		 * Safelisted names kept in the page's own chunk only on pages whose
		 * markup carries the class named by the key: for what a script draws
		 * as soon as the page loads, like a player's controls on the one page
		 * that has a player. Deferring those would draw them unstyled for a
		 * moment, and keeping them everywhere would load them everywhere.
		 */
		whenPresent?: Record<string, Array<string | RegExp>>;
	};
	/** Skip the per-page narrowing and serve the whole stylesheet. */
	wholeStylesheets?: boolean;
	/**
	 * The paths as templates already write them, mapped to the entry that
	 * replaces them.
	 *
	 *   rewrite: { "/assets/css/site.css": "site", "/assets/js/site.js": "site" }
	 *
	 * A page goes out with the hashed URL in place of the plain one, and for a
	 * stylesheet with that page's own narrowed chunk. Stated here rather than
	 * inferred, so nothing is rewritten by surprise.
	 */
	rewrite?: Record<string, string>;
}

export interface AssetReport {
	/** Entry name -> the URL of its chunk. */
	urls: Record<string, string>;
	/** Bytes in, bytes out, per entry. */
	sizes: Record<string, { from: number; to: number }>;
	/** Shared script chunks `Bun.build` split out. */
	shared: string[];
	/** Classes renamed, and classes that had to keep their names. */
	mangled?: { renamed: number; pinned: number };
}

export class Assets {
	private readonly options: Required<Pick<AssetsOptions, "outDir" | "publicPath">> & AssetsOptions;
	/** Entry name -> public URL. */
	private readonly entries = new Map<string, string>();
	/** Chunk file name -> contents, so the middleware can serve from memory. */
	private readonly files = new Map<string, { body: string; type: string }>();
	/** Stylesheet name -> its full source, for per-page narrowing. */
	private readonly sources = new Map<string, string>();
	/** Page profile hash -> the URL of the chunk that covers it. */
	private readonly pages = new Map<string, string>();
	/** Eager chunk URL -> its lazy half and what should load it. */
	private readonly lazy = new Map<string, { url: string; triggers: string[] }>();
	private report: AssetReport = { urls: {}, sizes: {}, shared: [] };
	/** Original class -> short name, when mangling. */
	private classes = new Map<string, string>();
	/** The safelist, with every renamed class it names added by its new name. */
	private safelist: Array<string | RegExp> = [];

	constructor(options: AssetsOptions) {
		this.options = { publicPath: "/_a", ...options };
	}

	/** Build every entry. Call once at boot. */
	public async build(): Promise<AssetReport> {
		await mkdir(this.options.outDir, { recursive: true });
		this.report = { urls: {}, sizes: {}, shared: [] };
		this.safelist = [...(this.options.safelist ?? [])];
		await this.planClasses();
		await this.buildStyles();
		await this.buildScripts();
		await this.buildClassicScripts();
		await this.buildFiles();
		this.report.urls = Object.fromEntries(this.entries);
		return this.report;
	}

	/** The URL of a named entry, hash and all. */
	public url(name: string): string {
		return this.entries.get(name) ?? "";
	}

	public manifest(): Record<string, string> {
		return Object.fromEntries(this.entries);
	}

	/**
	 * Point a rendered page at its chunks.
	 *
	 * A script becomes its hashed URL; a stylesheet becomes the slice of
	 * itself that this page can use. It happens here, on the way out, because
	 * narrowing needs the markup and the markup does not exist when the head
	 * is written.
	 */
	public rewrite(html: string): string {
		const { html: page, profile } = renameAndProfile(html, this.classes);
		const pattern = this.rewritePattern();
		if (!pattern) return page;
		const resolved = new Map<string, string>();
		const resolve = (from: string): string => {
			let url = resolved.get(from);
			if (url === undefined) {
				const name = this.options.rewrite?.[from] ?? "";
				url = this.sources.has(name) && !this.options.wholeStylesheets ? this.pageStyle(name, page, profile) : this.url(name);
				resolved.set(from, url);
			}
			return url;
		};
		let out = page.replace(pattern, (match, quote: string, from: string) => {
			const url = resolve(from);
			return url && url !== from ? `${quote}${url}${quote}` : match;
		});
		for (const url of resolved.values()) {
			const lazy = url ? this.lazy.get(url) : undefined;
			if (!lazy) continue;
			let close = -1;
			for (let at = out.indexOf(url); at !== -1 && close === -1; at = out.indexOf(url, at + 1)) {
				const end = out.indexOf(">", at);
				const tag = out.slice(out.lastIndexOf("<", at), end + 1);
				if (end !== -1 && /^<link\b/i.test(tag) && /\brel\s*=\s*["']?stylesheet\b/i.test(tag)) close = end;
			}
			if (close !== -1) out = `${out.slice(0, close + 1)}${lazyLoader(lazy.url, lazy.triggers)}${out.slice(close + 1)}`;
		}
		return out;
	}

	private pattern: RegExp | null | undefined;

	private rewritePattern(): RegExp | null {
		if (this.pattern !== undefined) return this.pattern;
		const froms = Object.keys(this.options.rewrite ?? {}).sort((a, b) => b.length - a.length);
		this.pattern = froms.length === 0
			? null
			: new RegExp(`(["'])(${froms.map((from) => from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\1`, "g");
		return this.pattern;
	}

	/**
	 * The chunk of `name` that covers this page, built the first time a page
	 * of this shape is seen.
	 */
	public pageStyle(name: string, html: string, profiled?: DocumentProfile): string {
		const source = this.sources.get(name);
		if (source === undefined) return this.url(name);

		const profile = profiled ?? profileDocument(html);
		// The key is the page's shape, not its content: two pages listing
		// different anime have the same classes and share a chunk.
		const shape = hash(
			`${name}\n${[...profile.tags].sort().join(",")}\n${[...profile.classes].sort().join(",")}\n${[...profile.ids].sort().join(",")}`,
		);
		const known = this.pages.get(shape);
		if (known) return known;

		const minify = (css: string) => (this.options.minify ? minifyCSS(css).css : css);
		if (!this.options.lazyStyles) {
			const body = minify(shakeCSS(source, profile, { safelist: this.safelist }).css);
			const url = this.hold(`${name}.${hash(body)}.css`, body, "text/css; charset=utf-8");
			this.pages.set(shape, url);
			return url;
		}

		const lazyStyles = typeof this.options.lazyStyles === "object" ? this.options.lazyStyles : {};
		const eager = [...(lazyStyles.eager ?? [])];
		for (const [marker, names] of Object.entries(lazyStyles.whenPresent ?? {})) {
			if (profile.classes.has(this.classes.get(marker) ?? marker)) eager.push(...names);
		}
		const split = splitCSS(source, profile, { safelist: this.safelist, eager: this.translate(eager) });
		const body = minify(split.eager);
		const url = this.hold(`${name}.${hash(body)}.css`, body, "text/css; charset=utf-8");
		if (split.lazy) {
			const later = minify(split.lazy);
			this.lazy.set(url, { url: this.hold(`${name}-later.${hash(later)}.css`, later, "text/css; charset=utf-8"), triggers: split.triggers });
		}
		this.pages.set(shape, url);
		return url;
	}

	/**
	 * Serve the chunks, and point every page that goes out at them.
	 *
	 * One middleware rather than two, because they are one feature: a link
	 * rewritten to a chunk that is not being served is a page with no styling.
	 */
	public middleware(): Middleware {
		const prefix = `${this.options.publicPath}/`;
		return async (ctx: Context, next: () => Promise<void>): Promise<void> => {
			if (ctx.path.startsWith(prefix)) {
				// basename, so nothing in the URL can climb out of the map.
				const held = this.files.get(basename(ctx.path));
				if (!held) return await next();
				ctx.response.headers.set("content-type", held.type);
				// The name carries the hash, so a change is a new URL and this
				// can be as long as the spec allows.
				ctx.response.headers.set("cache-control", "public, max-age=31536000, immutable");
				ctx.response.body = held.body;
				return;
			}

			await next();

			const body = ctx.response.body;
			if (typeof body !== "string") return;
			// Documents only. An API answer is a string too, and one that
			// happens to carry an asset path is not a page to rewrite.
			const type = ctx.response.headersInitialized ? ctx.response.headers.get("content-type") : null;
			if (type ? !type.includes("html") : !body.startsWith("<")) return;
			ctx.response.body = this.rewrite(body);
		};
	}

	// --- building ------------------------------------------------------------

	private async buildStyles(): Promise<void> {
		for (const [name, files] of Object.entries(this.options.styles ?? {})) {
			const parts: string[] = [];
			for (const file of files) {
				try {
					parts.push(await readFile(file, "utf8"));
				} catch {
					log.warn(`[<yellow>assets</yellow>] missing stylesheet <cyan>${file}</cyan>`);
				}
			}
			const joined = parts.join("\n");
			const source = this.classes.size > 0 ? renameCSSClasses(joined, this.classes) : joined;
			this.sources.set(name, source);

			const body = this.options.minify ? minifyCSS(source).css : source;
			const url = this.hold(`${name}.${hash(body)}.css`, body, "text/css; charset=utf-8");
			this.entries.set(name, url);
			this.report.sizes[name] = { from: joined.length, to: body.length };
		}
	}

	/** Decide which classes can be renamed, and to what. */
	private async planClasses(): Promise<void> {
		this.classes = new Map();
		const mangle = this.options.mangle;
		if (!mangle) return;

		const css: string[] = [];
		for (const files of Object.values(this.options.styles ?? {})) {
			for (const file of files) css.push(await readFile(file, "utf8").catch(() => ""));
		}
		const scripts = await readAll(mangle.scripts);
		const markup = await readAll(mangle.markup);
		// A page's own <script> is a script, whatever file it sits in.
		for (const page of markup) {
			for (const m of page.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
				if (!/type\s*=\s*["']?(text\/(template|x-template|html)|application\/(ld\+)?json)/i.test(m[1] ?? "")) {
					scripts.push(m[2] ?? "");
				}
			}
		}

		// A page's own <style> is not rewritten either, so what it styles
		// keeps its name.
		const keep = [...(mangle.keep ?? [])];
		for (const page of markup) {
			for (const m of page.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) keep.push(...cssClasses(m[1] ?? "").keys());
		}

		const plan = planClassNames({ css, scripts, markup, keep });
		this.classes = plan.map;
		this.report.mangled = { renamed: plan.map.size, pinned: plan.pinned.size };
		this.safelist = this.translate(this.options.safelist ?? []);
	}

	/**
	 * A safelist names classes by their source names. The ones that were
	 * renamed are added by their new names, exactly.
	 */
	private translate(list: Array<string | RegExp>): Array<string | RegExp> {
		const out = [...list];
		for (const [from, to] of this.classes) {
			const kept = list.some((entry) => typeof entry === "string" ? from === entry || from.includes(entry) : entry.test(from));
			if (kept) out.push(new RegExp(`^${to}$`));
		}
		return out;
	}

	private async buildScripts(): Promise<void> {
		const scripts = Object.entries(this.options.scripts ?? {});
		if (scripts.length === 0) return;

		const built = await Bun.build({
			entrypoints: scripts.map(([, file]) => file),
			target: "browser",
			format: "esm",
			// What makes two entry points that import the same module ship it
			// once: the shared part becomes a chunk they both import.
			splitting: true,
			minify: this.options.minify ?? false,
			naming: { entry: "[name].[hash].[ext]", chunk: "[name].[hash].[ext]", asset: "[name].[hash].[ext]" },
		});

		if (!built.success) {
			for (const message of built.logs) log.error(`[<red>assets</red>] ${String(message)}`);
			return;
		}

		// `[name]` in the naming pattern is the entry file's basename without
		// its extension, which is what ties an output back to the name the
		// caller asked for.
		const byStem = new Map(scripts.map(([name, file]) => [stemOf(file), name]));
		for (const output of built.outputs) {
			const file = basename(output.path);
			const body = await output.text();
			const url = this.hold(file, body, "text/javascript; charset=utf-8");
			if (output.kind !== "entry-point") {
				this.report.shared.push(url);
				continue;
			}
			const name = byStem.get(stemOf(file)) ?? stemOf(file);
			this.entries.set(name, url);
			this.report.sizes[name] = { from: await sourceSize(this.options.scripts?.[name]), to: body.length };
		}
	}

	private async buildClassicScripts(): Promise<void> {
		for (const [name, file] of Object.entries(this.options.classicScripts ?? {})) {
			const built = await Bun.build({
				entrypoints: [file],
				target: "browser",
				format: "iife",
				splitting: false,
				minify: this.options.minify ?? false,
			});
			if (!built.success || !built.outputs[0]) {
				for (const message of built.logs) log.error(`[<red>assets</red>] ${String(message)}`);
				continue;
			}
			const body = await built.outputs[0].text();
			const url = this.hold(`${name}.${hash(body)}.js`, body, "text/javascript; charset=utf-8");
			this.entries.set(name, url);
			this.report.sizes[name] = { from: await sourceSize(file), to: body.length };
		}
	}

	private async buildFiles(): Promise<void> {
		for (const [name, file] of Object.entries(this.options.files ?? {})) {
			let body: string;
			try {
				body = await readFile(file, "utf8");
			} catch {
				log.warn(`[<yellow>assets</yellow>] missing file <cyan>${file}</cyan>`);
				continue;
			}
			const ext = file.slice(file.lastIndexOf("."));
			const type = ext === ".css" ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8";
			const url = this.hold(`${name}.${hash(body)}${ext}`, body, type);
			this.entries.set(name, url);
			this.report.sizes[name] = { from: body.length, to: body.length };
		}
	}

	/** Keep a chunk in memory and write it out, and return its URL. */
	private hold(file: string, body: string, type: string): string {
		this.files.set(file, { body, type });
		void writeFile(join(this.options.outDir, file), body).catch(() => {
			// On disk is a convenience for a CDN or another process; the
			// middleware serves from memory either way.
		});
		return `${this.options.publicPath}/${file}`;
	}
}

/**
 * The inline script that links a page's lazy stylesheet: on the first
 * pointer, key, focus or scroll event — ahead of the click that opens a
 * menu, so the menu never draws unstyled — or as soon as an element
 * carrying one of `triggers` appears, whichever is first. It sits right
 * after the eager <link> and puts the lazy one after that, so the cascade
 * keeps the order the stylesheets were written in.
 */
function lazyLoader(url: string, triggers: string[]): string {
	const selector = JSON.stringify(triggers.join(","));
	return `<script>(()=>{let d=0,a=document.currentScript.previousElementSibling,E=["pointerover","pointerdown","touchstart","keydown","focusin","scroll"],S=${selector},c=n=>n.nodeType==1&&(n.matches(S)||!!n.querySelector(S)),o=new MutationObserver(m=>{for(const r of m)if(r.type=="attributes"?c(r.target):[...r.addedNodes].some(c))return g()}),g=()=>{if(d)return;d=1;o.disconnect();for(const e of E)removeEventListener(e,g,!0);const l=document.createElement("link");l.rel="stylesheet";l.href=${JSON.stringify(url)};a.after(l)};S&&o.observe(document.documentElement,{subtree:!0,childList:!0,attributes:!0,attributeFilter:["class","id"]});for(const e of E)addEventListener(e,g,{capture:!0,passive:!0})})()</script>`;
}

/**
 * Every file under the given files and directories, as text. An entry that
 * starts with `!` leaves that path out.
 */
async function readAll(paths: string[]): Promise<string[]> {
	const out: string[] = [];
	const skip = paths.filter((p) => p.startsWith("!")).map((p) => p.slice(1).replace(/\/$/, ""));
	const visit = async (path: string): Promise<void> => {
		if (skip.some((s) => path === s || path.startsWith(`${s}/`))) return;
		const info = await stat(path).catch(() => undefined);
		if (!info) return;
		if (info.isDirectory()) {
			for (const entry of await readdir(path)) await visit(join(path, entry));
			return;
		}
		if (/\.(m?js|ts|uwu|html?)$/.test(path)) out.push(await readFile(path, "utf8"));
	};
	for (const path of paths) if (!path.startsWith("!")) await visit(path);
	return out;
}

/** `site.js` and `site.a1b2c3d4.js` both -> `site` */
function stemOf(file: string): string {
	return basename(file).split(".")[0] ?? file;
}

async function sourceSize(file: string | undefined): Promise<number> {
	if (!file) return 0;
	try {
		return (await readFile(file, "utf8")).length;
	} catch {
		return 0;
	}
}

/** Short content hash. Long enough that a collision is not a real worry. */
function hash(body: string): string {
	return new Bun.CryptoHasher("sha256").update(body).digest("hex").slice(0, 10);
}
