/**
 * Page files as routes: `mountPages` compiles (or loads) every file under
 * `pages/`, works out each route's data plan once, and registers one
 * navigable GET route per page.
 *
 *   source("categories", () => db.categories());
 *   const site = await mountPages({ dir: "app", dev: true, app });
 *
 * A request then: loads every name the page and its layouts read (see
 * data.ts), in parallel; draws the page; fills in `page` (title, head tags,
 * styles) for the layouts; draws the layouts around it, innermost first.
 * A page a signed-out visitor sees goes through PageCache unless it says
 * `<page cache="off">`; a source that throws NotFound or Forbidden answers
 * that status, through the nearest `_error.uwu`.
 */

import { watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import type { Assets } from "../assets.ts";
import { config } from "../config.ts";
import type { Context, Handler } from "../context.ts";
import { log } from "../logger.ts";
import { navigable } from "../navigate.ts";
import { PageCache, type PageCacheOptions } from "../page-cache.ts";
import { Router } from "../router.ts";
import type { Application } from "../server.ts";
import type { DataDecl } from "./block.ts";
import { type CompiledFile, type Render, compileAll, evaluateServer, loadBuilt, uwuRuntime } from "./compile.ts";
import { REQUEST_NAMES, type Plan, type ServiceConfig, type UsedData, buildPlan, resolvePlan } from "./data.ts";
import { HttpError, PageCompileError } from "./errors.ts";
import { type PageMeta, fillText, firstHeading, headTags } from "./meta.ts";

export interface PagesOptions {
	/** The app directory: its `pages/` is compiled in memory. */
	dir?: string;
	/** Or a directory `compilePages` wrote. */
	built?: string;
	/** Watch `dir/pages` and recompile on change (default false). */
	dev?: boolean;
	/** Register on this router (default: a new one for every host). */
	router?: Router;
	/** Reloaded when a new page file adds a route in development. */
	app?: Application;
	/** Base URLs for `<data x="name:GET /path">`, by service name. */
	services?: Record<string, ServiceConfig>;
	/** Who is asking, as templates read `viewer` (default: the session's `viewer` or `user`, else null). */
	viewer?: (ctx: Context) => unknown;
	/**
	 * Per-visitor secrets a page may carry (a CSP nonce, a CSRF token), read
	 * as `secrets.<name>`. A page kept by PageCache is drawn with marks in
	 * their place and filled per answer.
	 */
	secrets?: (ctx: Context) => Record<string, string>;
	/** Public origin for canonical URLs (default `config.General.url`). */
	baseUrl?: string;
	/** PageCache for signed-out visitors; `false` turns it off for every page. */
	cache?: false | Omit<PageCacheOptions, "prepare">;
	/** Keep cached pages rewritten by these assets (`assets.rewrite`). */
	assets?: Assets;
	/** Passed to every render: helpers, components and partials. */
	render?: { helpers?: Record<string, unknown>; components?: Record<string, unknown>; partials?: Record<string, unknown> };
}

interface Loaded extends CompiledFile {
	render: Render;
}

interface Drawn {
	page: Loaded;
	/** Innermost first. */
	layouts: Loaded[];
	plan: Plan;
	styles: string;
}

interface RouteState extends Drawn {
	path: string;
	cache: "off" | number;
	/** The route (page or layouts) reads `session`: never kept. */
	readsSession: boolean;
	/** It reads `viewer`: kept only while that is null. */
	readsViewer: boolean;
	/** The page file itself reads `viewer` or `session`. */
	noindex: boolean;
	error?: Drawn;
}

export interface PageRoute {
	path: string;
	file: string;
	layouts: string[];
	/** Each name the route loads and where from, for live updates later. */
	data: { name: string; kind: string; from: string }[];
	cache: "off" | number;
}

export interface PageSite {
	readonly routes: PageRoute[];
	/** The scoped CSS of every page file, for an asset build. */
	readonly css: string;
	/** Compile again (what the development watcher calls); throws what it finds. */
	reload(): Promise<void>;
	/** Stop watching. */
	close(): void;
}

/** What `ctx.locals.page` holds after a page route ran its loads. */
export interface PageLocals {
	route: string;
	file: string;
	used: UsedData[];
}

const SECRET = /^[\w.~+/=-]*$/;

export async function mountPages(options: PagesOptions): Promise<PageSite> {
	if (!options.dir && !options.built) throw new TypeError("natsu/pages: mountPages needs { dir } or { built }");
	const router = options.router ?? new Router();
	const rt = await uwuRuntime();
	const renderToString = rt.renderToString as (render: Render, props: unknown, opts: unknown) => Promise<string>;
	const renderOptions = options.render ?? {};
	const caches = new Map<number, PageCache>();
	const registered = new Set<string>();
	let routes = new Map<string, RouteState>();
	let summary: PageRoute[] = [];
	let css = "";

	const viewerOf = options.viewer ?? ((ctx: Context): unknown => {
		if (!ctx.sessionLoaded) return null;
		const data = ctx.session.data;
		return data.viewer ?? data.user ?? null;
	});

	const cacheFor = (seconds: number): PageCache => {
		let cache = caches.get(seconds);
		if (!cache) {
			const settings = options.cache === false ? {} : options.cache ?? {};
			cache = new PageCache({ ...settings, fresh: seconds, ...(options.assets ? { prepare: (html: string) => options.assets!.rewrite(html) } : {}) });
			caches.set(seconds, cache);
		}
		return cache;
	};
	const defaultSeconds = options.cache === false ? undefined : options.cache?.fresh ?? 10;

	// --- building the table -----------------------------------------------------

	const build = async (files: CompiledFile[]): Promise<void> => {
		const loaded = new Map<string, Loaded>();
		for (const file of files) loaded.set(file.file, { ...file, render: await evaluateServer(file.server, `pages/${file.file}`) });

		const dirOf = (file: string): string => (file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "");
		const chain = (dir: string): Loaded[] => {
			const out: Loaded[] = [];
			for (let d: string | undefined = dir; d !== undefined; d = d === "" ? undefined : dirOf(d)) {
				const layout = loaded.get(d ? `${d}/_layout.uwu` : "_layout.uwu");
				if (layout) out.push(layout);
			}
			return out;
		};
		const nearestError = (dir: string): Loaded | undefined => {
			for (let d: string | undefined = dir; d !== undefined; d = d === "" ? undefined : dirOf(d)) {
				const page = loaded.get(d ? `${d}/_error.uwu` : "_error.uwu");
				if (page) return page;
			}
			return undefined;
		};

		const drawn = (page: Loaded, layouts: Loaded[], path: string, params: string[], extra: string[]): Drawn => {
			const reads = new Map<string, { fields: string[]; at: string }>();
			const decls = new Map<string, DataDecl & { file: string }>();
			for (const file of [page, ...layouts]) {
				for (const [name, read] of Object.entries(file.reads)) {
					const known = reads.get(name);
					if (!known) reads.set(name, { fields: read.fields, at: `pages/${file.file}:${read.line}` });
					else if (!known.fields.includes("*")) {
						known.fields = read.fields.includes("*") ? ["*"] : [...new Set([...known.fields, ...read.fields])].sort();
					}
				}
				// The page's own <data> wins over a layout's of the same name.
				for (const decl of file.block?.data ?? []) if (!decls.has(decl.name)) decls.set(decl.name, { ...decl, file: `pages/${file.file}` });
			}
			const requestNames = new Set([...REQUEST_NAMES].filter((name) => name !== "error" && name !== "secrets"));
			if (options.secrets) requestNames.add("secrets");
			for (const name of extra) requestNames.add(name);
			const plan = buildPlan({ path, params, reads, decls, services: options.services ?? {}, requestNames });
			const styles = [...layouts].reverse().concat(page).map((file) => file.css).filter(Boolean).join("\n");
			return { page, layouts, plan, styles };
		};

		const next = new Map<string, RouteState>();
		for (const page of loaded.values()) {
			if (page.kind !== "page") continue;
			const block = page.block;
			let layouts: Loaded[];
			if (block?.layout === "none") layouts = [];
			else if (block?.layout) {
				const named = loaded.get(`${block.layout.replace(/^\/+/, "")}.uwu`);
				if (!named || named.kind !== "layout") {
					throw new PageCompileError(`pages/${page.file}`, block.line, `<page layout="${block.layout}">: there is no layout pages/${block.layout}.uwu (a layout's name starts with _)`);
				}
				layouts = [named];
			} else layouts = chain(dirOf(page.file));

			const base = drawn(page, layouts, page.route!, page.params, []);
			const errorPage = nearestError(dirOf(page.file));
			const error = errorPage ? drawn(errorPage, chain(dirOf(errorPage.file)), page.route!, page.params, ["error"]) : undefined;
			const routeReads = new Set(base.plan.names);
			const cache = block?.cache ?? (defaultSeconds === undefined ? "off" : defaultSeconds);
			next.set(page.route!, {
				...base,
				path: page.route!,
				cache: options.cache === false ? "off" : cache === 0 ? "off" : cache,
				readsSession: routeReads.has("session") || [...base.plan.loaders.values()].some((l) => "when" in l && l.when === "session"),
				readsViewer: routeReads.has("viewer"),
				noindex: "viewer" in page.reads || "session" in page.reads,
				error,
			});
		}

		routes = next;
		css = files.map((file) => file.css).filter(Boolean).join("\n");
		summary = [...next.values()].map((state) => ({
			path: state.path,
			file: state.page.file,
			layouts: state.layouts.map((layout) => layout.file),
			data: state.plan.names.map((name) => {
				const loader = state.plan.loaders.get(name)!;
				const from = loader.t === "source" ? loader.source : loader.t === "api" ? loader.service : loader.name;
				return { name, kind: loader.t, from };
			}),
			cache: state.cache,
		}));

		let added = false;
		for (const path of next.keys()) {
			if (registered.has(path)) continue;
			registered.add(path);
			added = true;
			router.get(path, navigable(handlerFor(path)));
		}
		if (added && options.app?.running) options.app.reload();
	};

	// --- a request -------------------------------------------------------------

	const scopeFor = (ctx: Context, state: RouteState, secrets: Record<string, string>, extra: Record<string, unknown> = {}) => {
		let viewer: Promise<unknown> | undefined;
		const request = new Map<string, () => unknown>([
			["viewer", () => (viewer ??= Promise.resolve(viewerOf(ctx)))],
			["secrets", () => secrets],
		]);
		for (const [name, value] of Object.entries(extra)) request.set(name, () => value);
		return { ctx, request, services: options.services ?? {}, path: state.path, params: state.page.params };
	};

	const pageValue = (meta: PageMeta, styles: string) => ({ ...meta, meta, head: headTags(meta) + (styles ? `<style>${styles}</style>` : ""), styles });

	const drawPage = async (drawn: Drawn, values: Record<string, unknown>, meta: PageMeta, fallbackTitle: string): Promise<string> => {
		values.page = pageValue(meta, drawn.styles);
		const html = await renderToString(drawn.page.render, values, renderOptions);
		if (!meta.title) {
			meta = { ...meta, title: firstHeading(html) || fallbackTitle };
			values.page = pageValue(meta, drawn.styles);
		}
		let out = html;
		for (const layout of drawn.layouts) out = await renderToString(layout.render, values, { ...renderOptions, child: out });
		return out;
	};

	const canonical = (ctx: Context): string => (options.baseUrl ?? config.General.url).replace(/\/+$/, "") + ctx.path;

	const draw = async (ctx: Context, state: RouteState, secrets: Record<string, string>): Promise<{ body: string; status: number; html: boolean }> => {
		try {
			const scope = scopeFor(ctx, state, secrets);
			const { values, used } = await resolvePlan(state.plan, scope);
			ctx.locals.page = { route: state.path, file: state.page.file, used } satisfies PageLocals;
			const block = state.page.block;
			const meta: PageMeta = {
				title: fillText(block?.title, values),
				description: fillText(block?.description, values),
				canonical: canonical(ctx),
				robots: state.noindex ? "noindex" : "",
			};
			return { body: await drawPage(state, values, meta, ""), status: 200, html: true };
		} catch (error) {
			return drawError(ctx, state, secrets, error);
		}
	};

	const drawError = async (ctx: Context, state: RouteState, secrets: Record<string, string>, error: unknown): Promise<{ body: string; status: number; html: boolean }> => {
		const status = error instanceof HttpError ? error.status : 500;
		const message = error instanceof HttpError ? error.message : config.General.development ? String((error as Error)?.stack ?? error) : "Internal Server Error";
		if (status >= 500) log.error(`[<red>pages</red>] ${ctx.method} ${ctx.path} (pages/${state.page.file}): ${(error as Error)?.stack ?? error}`);
		if (state.error) {
			try {
				const scope = scopeFor(ctx, state, secrets, { error: { status, message } });
				const { values } = await resolvePlan(state.error.plan, scope);
				const meta: PageMeta = { title: "", description: "", canonical: "", robots: "noindex" };
				return { body: await drawPage(state.error, values, meta, String(status)), status, html: true };
			} catch (inner) {
				log.error(`[<red>pages</red>] pages/${state.error.page.file} failed drawing a ${status}: ${(inner as Error)?.stack ?? inner}`);
			}
		}
		return { body: status === 404 ? "Not Found" : status === 403 ? "Forbidden" : message, status, html: false };
	};

	function handlerFor(path: string): Handler {
		const handler: Handler = async (ctx) => {
			const state = routes.get(path);
			if (!state) return undefined; // removed in development: a 404

			const secrets = options.secrets?.(ctx) ?? {};
			const names = Object.keys(secrets).sort();
			const answer = (out: { body: string; status: number; html?: boolean; headers?: Record<string, string> }): string => {
				ctx.response.status = out.status;
				if (out.html ?? out.headers?.["content-type"]?.startsWith("text/html")) ctx.response.type = "text/html; charset=utf-8";
				else ctx.response.type = "text/plain; charset=utf-8";
				return out.body;
			};

			const cacheable =
				state.cache !== "off" &&
				!state.plan.personal &&
				!state.readsSession &&
				!ctx.sessionLoaded &&
				names.every((name) => SECRET.test(secrets[name]!)) &&
				(!state.readsViewer || (await viewerOf(ctx)) == null);
			if (cacheable) {
				const cache = cacheFor(state.cache as number);
				const kept = await cache.serve(
					ctx.path + ctx.search,
					names.map((name) => secrets[name]!),
					async (marks) => {
						const out = await draw(ctx, state, Object.fromEntries(names.map((name, i) => [name, marks[i]!])));
						return {
							body: out.body,
							status: out.status,
							headers: { "content-type": out.html ? "text/html; charset=utf-8" : "text/plain; charset=utf-8" },
							keep: out.status === 200,
						};
					},
				);
				if (kept) {
					if (kept.prepared) options.assets?.markRewritten(ctx, kept);
					return answer(kept);
				}
			}
			return answer(await draw(ctx, state, secrets));
		};
		Object.defineProperty(handler, "name", { value: `page ${path}` });
		return handler;
	}

	// --- loading ----------------------------------------------------------------

	const compileNow = (): CompiledFile[] => (options.built ? loadBuilt(options.built) : compileAll(options.dir!));
	await build(compileNow());

	let watcher: FSWatcher | undefined;
	if (options.dev && options.dir) {
		let timer: ReturnType<typeof setTimeout> | undefined;
		watcher = watch(join(options.dir, "pages"), { recursive: true }, () => {
			clearTimeout(timer);
			timer = setTimeout(() => {
				Promise.resolve()
					.then(() => build(compileAll(options.dir!)))
					.then(
					() => log.info(`[<green>pages</green>] recompiled`),
					(error: Error) => log.error(`[<red>pages</red>] ${error.message} (still serving the last good build)`),
				);
			}, 25);
		});
	}

	return {
		get routes() {
			return summary;
		},
		get css() {
			return css;
		},
		reload: () => build(compileNow()),
		close: () => watcher?.close(),
	};
}
