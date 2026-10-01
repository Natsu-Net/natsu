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

import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { brotliCompress, constants, gzip } from "node:zlib";
import { type DocumentProfile, profileDocument, selectorNames, shakeCSS, splitCSS } from "uwu-template/assets";
import { cssClasses, planClassNames, renameAndProfile, renameCSSClasses } from "uwu-template/assets/mangle";
import { minifyCSS } from "uwu-template/assets/minify";
import { addVary, negotiate } from "./compress.ts";
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
	 * How many page shapes keep their chunk in memory (default 1000). Past
	 * that the oldest shape is forgotten and its chunk is served from
	 * `outDir`; a page of that shape builds it again.
	 */
	maxPageShapes?: number;
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
	/** Chunk file name -> its brotli and gzip bytes, once compressed off the request path. */
	private readonly encoded = new Map<string, Encoded>();
	/** Chunk file name -> its compression while still running. */
	private readonly encoding = new Map<string, Promise<Encoded | undefined>>();
	/** Writes to `outDir` still running. */
	private readonly writes = new Set<Promise<void>>();
	/** Chunk file name -> how many remembered shapes link it. */
	private readonly refs = new Map<string, number>();
	/** Files read back from disk whose names carry no hash of ours to check them against. */
	private readonly unverified = new Set<string>();
	/** Files that are entries (the whole stylesheet, scripts): never forgotten. */
	private readonly pinned = new Set<string>();
	/** Stylesheet name -> its full source, for per-page narrowing. */
	private readonly sources = new Map<string, string>();
	/**
	 * Page profile hash -> the URL of the chunk that covers it and every
	 * file that shape holds in memory, oldest first. A chunk read back from
	 * disk is in here too, under `disk:<file>`, so it is forgotten the same way.
	 */
	private readonly pages = new Map<string, { url: string; files: string[] }>();
	/** Eager chunk URL -> its lazy half and what should load it. */
	private readonly lazy = new Map<string, { url: string; triggers: string[] }>();
	private report: AssetReport = { urls: {}, sizes: {}, shared: [] };
	/** Original class -> short name, when mangling. */
	private classes = new Map<string, string>();
	/** Whether `sources` hold minified CSS, so a page's slice needs no second pass. */
	private sourcesMinified = false;
	/** Stylesheet -> the classes and ids its rules test a page for: all a chunk depends on. */
	private readonly names = new Map<string, { classes: Set<string>; ids: Set<string> }>();
	/** The safelist, with every renamed class it names added by its new name. */
	private safelist: Array<string | RegExp> = [];
	/** Answers whose page went through `rewrite` already (see markRewritten). */
	private readonly rewritten = new WeakSet<Context>();

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
		// Renaming walks the whole page and profiles it on the way. Without a
		// rename the page is profiled only when a stylesheet is narrowed for
		// it: a page linking scripts alone, or `wholeStylesheets`, skips the
		// walk, which costs several times the render.
		let page = html;
		let profile: DocumentProfile | undefined;
		if (this.classes.size > 0) ({ html: page, profile } = renameAndProfile(html, this.classes));
		const pattern = this.rewritePattern();
		if (!pattern) return page;
		const resolved = new Map<string, string>();
		const resolve = (from: string): string => {
			let url = resolved.get(from);
			if (url === undefined) {
				const name = this.options.rewrite?.[from] ?? "";
				if (this.sources.has(name) && !this.options.wholeStylesheets) {
					profile ??= profileDocument(page);
					url = this.pageStyle(name, page, profile);
				} else {
					url = this.url(name);
				}
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

	/**
	 * This answer's page went through `rewrite` already (a page kept rewritten,
	 * see PageCache's `prepare`), so the middleware sends it as it is: a second
	 * pass costs as much as the first, and renames what it already renamed.
	 */
	public markRewritten(ctx: Context): void {
		this.rewritten.add(ctx);
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
		// different anime have the same classes and share a chunk. Only the
		// classes and ids the sheet's rules name count (tags never do), so a
		// page's own `id="review-81"` does not make it a shape of its own.
		// Bun.hash, not sha256: the key never leaves this process.
		const names = this.names.get(name);
		const named = (found: Set<string>, known: Set<string> | undefined): string => {
			const list: string[] = [];
			for (const item of found) if (!known || known.has(item)) list.push(item);
			return list.sort().join(",");
		};
		const shape = Bun.hash(
			`${name}\n${named(profile.classes, names?.classes)}\n${named(profile.ids, names?.ids)}`,
		).toString(36);
		const known = this.pages.get(shape);
		if (known) {
			// Most recently used last, so the oldest shape is the one forgotten.
			this.pages.delete(shape);
			this.pages.set(shape, known);
			return known.url;
		}

		// A slice of an already minified sheet is minified; shaking it is a
		// third of the work of shaking the source and minifying the result.
		const minify = (css: string) => (this.options.minify && !this.sourcesMinified ? minifyCSS(css).css : css);
		if (!this.options.lazyStyles) {
			const body = minify(shakeCSS(source, profile, { safelist: this.safelist }).css);
			const url = this.hold(`${name}.${hash(body)}.css`, body, "text/css; charset=utf-8");
			this.remember(shape, url, [basename(url)]);
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
		const files = [basename(url)];
		if (split.lazy) {
			const later = minify(split.lazy);
			const laterUrl = this.hold(`${name}-later.${hash(later)}.css`, later, "text/css; charset=utf-8");
			this.lazy.set(url, { url: laterUrl, triggers: split.triggers });
			files.push(basename(laterUrl));
		}
		this.remember(shape, url, files);
		return url;
	}

	/**
	 * Keep a page shape's chunk, forgetting the oldest shapes past
	 * `maxPageShapes`. A file leaves memory once no remembered shape links
	 * it; it stays on disk, where a page that still links it finds it. The
	 * limit is never below the number of stylesheets, so the shapes of the
	 * page being rewritten are never the ones forgotten.
	 */
	private remember(shape: string, url: string, files: string[]): void {
		this.pages.set(shape, { url, files });
		for (const file of files) this.refs.set(file, (this.refs.get(file) ?? 0) + 1);
		const limit = Math.max(this.options.maxPageShapes ?? 1000, this.sources.size, 1);
		while (this.pages.size > limit) {
			const oldest = this.pages.entries().next().value;
			if (!oldest) break;
			const [key, page] = oldest;
			this.pages.delete(key);
			for (const file of page.files) {
				const left = (this.refs.get(file) ?? 1) - 1;
				if (left > 0) {
					this.refs.set(file, left);
					continue;
				}
				this.refs.delete(file);
				if (this.pinned.has(file)) continue;
				this.files.delete(file);
				this.encoded.delete(file);
				this.encoding.delete(file);
				this.unverified.delete(file);
			}
			if (!this.refs.has(basename(page.url))) this.lazy.delete(page.url);
		}
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
				const file = basename(ctx.path);
				const held = this.files.get(file) ?? (await this.fromDisk(file));
				if (!held) {
					const stand = this.standIn(file);
					if (!stand) return await next();
					// Not this chunk, so not immutable: a few minutes, then ask again.
					ctx.response.headers.set("content-type", stand.type);
					ctx.response.headers.set("cache-control", "public, max-age=300");
					ctx.response.body = stand.body;
					return;
				}
				// A chunk read back from disk keeps its place while pages ask for it.
				const fromDisk = this.pages.get(`disk:${file}`);
				if (fromDisk) {
					this.pages.delete(`disk:${file}`);
					this.pages.set(`disk:${file}`, fromDisk);
				}
				ctx.response.headers.set("content-type", held.type);
				// The name carries the hash, so a change is a new URL and this
				// can be as long as the spec allows. A file from disk that could
				// not be checked against its name gets a few minutes instead.
				ctx.response.headers.set(
					"cache-control",
					this.unverified.has(file) ? "public, max-age=300" : "public, max-age=31536000, immutable",
				);
				// Both answers vary, so a cache never hands brotli to a client that asked for none.
				addVary(ctx.response.headers, "Accept-Encoding");
				const encoding = negotiate(ctx.request.headers.get("accept-encoding"));
				// A chunk asked for while its copies are still being made waits
				// for them: off this thread, rather than compressed again on it.
				const copies = encoding ? (this.encoded.get(file) ?? (await this.encoding.get(file))) : undefined;
				const bytes = encoding ? copies?.[encoding] : undefined;
				if (encoding && bytes) {
					ctx.response.headers.set("content-encoding", encoding);
					ctx.response.body = bytes as Uint8Array<ArrayBuffer>;
					return;
				}
				ctx.response.body = held.body;
				return;
			}

			await next();

			const body = ctx.response.body;
			if (typeof body !== "string" || this.rewritten.has(ctx)) return;
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

			const body = this.options.minify ? minifyCSS(source).css : source;
			// Pages are cut from the minified sheet, so no slice is minified again.
			this.sources.set(name, body);
			this.names.set(name, this.namesOf(body));
			this.sourcesMinified = Boolean(this.options.minify);
			const url = this.hold(`${name}.${hash(body)}.css`, body, "text/css; charset=utf-8");
			this.pin(url);
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
	/**
	 * What of a page the chunks of this sheet depend on: the classes and ids
	 * its rules name, and the classes that pull a lazy rule in early.
	 */
	private namesOf(css: string): { classes: Set<string>; ids: Set<string> } {
		const names = selectorNames(css);
		const lazyStyles = typeof this.options.lazyStyles === "object" ? this.options.lazyStyles : {};
		for (const marker of Object.keys(lazyStyles.whenPresent ?? {})) {
			names.classes.add(this.classes.get(marker) ?? marker);
		}
		return names;
	}

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
			this.pin(url);
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
			this.pin(url);
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
			this.pin(url);
			this.entries.set(name, url);
			this.report.sizes[name] = { from: body.length, to: body.length };
		}
	}

	/**
	 * Keep a chunk in memory and write it out, and return its URL. The
	 * brotli and gzip copies are made on libuv's thread pool, so the request
	 * that built a chunk never waits for its compression.
	 */
	private hold(file: string, body: string, type: string): string {
		if (!this.files.has(file)) {
			this.keep(file, body, type);
			this.write(file, body);
		}
		return `${this.options.publicPath}/${file}`;
	}

	/** Keep a chunk in memory and start its compressed copies. */
	private keep(file: string, body: string, type: string): void {
		this.files.set(file, { body, type });
		const copies = precompress(body).then(
			(made) => {
				if (this.encoding.get(file) !== copies) return undefined;
				this.encoding.delete(file);
				this.encoded.set(file, made);
				return made;
			},
			() => {
				if (this.encoding.get(file) === copies) this.encoding.delete(file);
				return undefined;
			},
		);
		this.encoding.set(file, copies);
	}

	/**
	 * Write a chunk to `outDir` under a temporary name, then rename it into
	 * place: another process, or this one after a crash, sees the whole file
	 * or none of it. On disk is how a restarted process or another one serves
	 * a chunk it did not build; this process serves from memory either way.
	 */
	private write(file: string, body: string): void {
		const target = join(this.options.outDir, file);
		const temporary = `${target}.${process.pid}.${(++writeCount).toString(36)}.tmp`;
		const done = writeFile(temporary, body)
			.then(() => rename(temporary, target))
			.catch(() => unlink(temporary).catch(() => {}));
		this.writes.add(done);
		void done.finally(() => this.writes.delete(done));
	}

	/**
	 * Resolves once every chunk built so far is on disk and compressed. For
	 * tests, and for a server that wants to shut down cleanly.
	 */
	public async settled(): Promise<void> {
		await Promise.all([...this.writes, ...this.encoding.values()]);
	}

	/** An entry's file stays in memory for good: pages link it by name. */
	private pin(url: string): void {
		this.pinned.add(basename(url));
	}

	/**
	 * A chunk this process does not hold but wrote earlier, or another
	 * process sharing `outDir` wrote: a page rendered before a restart still
	 * links it.
	 */
	private async fromDisk(file: string): Promise<{ body: string; type: string } | undefined> {
		const type = typeOf(file);
		if (!type || !/^[\w.-]+$/.test(file)) return undefined;
		let body: string;
		try {
			body = await readFile(join(this.options.outDir, file), "utf8");
		} catch {
			return undefined;
		}
		// A name this pipeline gave carries the hash of its contents: a file
		// that does not match it (cut short by a crash before writes were
		// atomic) is not that chunk, and must never go out as immutable.
		const named = /\.([0-9a-f]{10})\.(?:css|m?js)$/.exec(file)?.[1];
		if (named !== undefined && hash(body) !== named) return undefined;
		if (!this.files.has(file)) {
			this.keep(file, body, type);
			if (named === undefined) this.unverified.add(file);
			this.remember(`disk:${file}`, `${this.options.publicPath}/${file}`, [file]);
		}
		return this.files.get(file);
	}

	/**
	 * What to send for a stylesheet chunk nobody has: the whole stylesheet
	 * it was cut from, which styles any page it could have, or nothing for a
	 * lazy half, whose rules the whole sheet already carries. A page that
	 * outlived the process that rendered it stays styled.
	 */
	private standIn(file: string): { body: string; type: string } | undefined {
		// Renamed classes differ from one build to the next, so a page from
		// another build would get another build's names: no stand-in then.
		if (!file.endsWith(".css") || this.classes.size > 0) return undefined;
		const stem = stemOf(file);
		const later = stem.endsWith("-later");
		const name = later ? stem.slice(0, -"-later".length) : stem;
		const url = this.entries.get(name);
		if (!url || !this.sources.has(name)) return undefined;
		if (later) return { body: "", type: "text/css; charset=utf-8" };
		return this.files.get(basename(url));
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

const brotli = promisify(brotliCompress);
const gzipAsync = promisify(gzip);

type Encoded = { br?: Uint8Array; gzip?: Uint8Array };

/** Tells apart this process's temporary files. */
let writeCount = 0;

/** A chunk's brotli (top quality) and gzip copies, made on the thread pool. */
async function precompress(body: string): Promise<{ br: Uint8Array; gzip: Uint8Array }> {
	const bytes = new TextEncoder().encode(body);
	const [br, gz] = await Promise.all([
		brotli(bytes, {
			params: {
				[constants.BROTLI_PARAM_QUALITY]: 11,
				[constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
				[constants.BROTLI_PARAM_SIZE_HINT]: bytes.length,
			},
		}),
		gzipAsync(bytes, { level: 9 }),
	]);
	return { br: new Uint8Array(br), gzip: new Uint8Array(gz) };
}

/** The type a chunk is served as, by its extension; undefined for anything else. */
function typeOf(file: string): string | undefined {
	if (file.endsWith(".css")) return "text/css; charset=utf-8";
	if (file.endsWith(".js") || file.endsWith(".mjs")) return "text/javascript; charset=utf-8";
	return undefined;
}

/** Short content hash. Long enough that a collision is not a real worry. */
function hash(body: string): string {
	return new Bun.CryptoHasher("sha256").update(body).digest("hex").slice(0, 10);
}
