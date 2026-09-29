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

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { profileDocument, shakeCSS } from "uwu-template/assets";
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
	private report: AssetReport = { urls: {}, sizes: {}, shared: [] };

	constructor(options: AssetsOptions) {
		this.options = { publicPath: "/_a", ...options };
	}

	/** Build every entry. Call once at boot. */
	public async build(): Promise<AssetReport> {
		await mkdir(this.options.outDir, { recursive: true });
		this.report = { urls: {}, sizes: {}, shared: [] };
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
		let out = html;
		for (const [from, name] of Object.entries(this.options.rewrite ?? {})) {
			const url = this.sources.has(name) && !this.options.wholeStylesheets
				? this.pageStyle(name, html)
				: this.url(name);
			if (!url || url === from) continue;
			// Both quote styles, because a template author picks either and a
			// path left un-rewritten is a 404 the page cannot recover from.
			out = out.split(`"${from}"`).join(`"${url}"`);
			out = out.split(`'${from}'`).join(`'${url}'`);
		}
		return out;
	}

	/**
	 * The chunk of `name` that covers this page, built the first time a page
	 * of this shape is seen.
	 */
	public pageStyle(name: string, html: string): string {
		const source = this.sources.get(name);
		if (source === undefined) return this.url(name);

		const profile = profileDocument(html);
		// The key is the page's shape, not its content: two pages listing
		// different anime have the same classes and share a chunk.
		const shape = hash(
			`${name}\n${[...profile.tags].sort().join(",")}\n${[...profile.classes].sort().join(",")}\n${[...profile.ids].sort().join(",")}`,
		);
		const known = this.pages.get(shape);
		if (known) return known;

		const shaken = shakeCSS(source, profile, { safelist: this.options.safelist });
		const body = this.options.minify ? minifyCSS(shaken.css).css : shaken.css;
		const url = this.hold(`${name}.${hash(body)}.css`, body, "text/css; charset=utf-8");
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
			const source = parts.join("\n");
			this.sources.set(name, source);

			const body = this.options.minify ? minifyCSS(source).css : source;
			const url = this.hold(`${name}.${hash(body)}.css`, body, "text/css; charset=utf-8");
			this.entries.set(name, url);
			this.report.sizes[name] = { from: source.length, to: body.length };
		}
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
