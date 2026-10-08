/**
 * Page files as routes: `mountPages` compiles (or loads) every file under
 * `pages/`, works out each route's data plan once, and registers one
 * navigable GET route per page, and a POST for its actions.
 *
 *   source("categories", () => db.categories());
 *   action("todos.add", addTodo, { touches: ["todos"] });
 *   const site = await mountPages({ dir: "app", dev: true, app });
 *
 * A GET then: loads every name the page and its layouts read (see data.ts),
 * in parallel; draws the page; fills in `page` (title, head tags, styles)
 * for the layouts; draws the layouts around it, innermost first. A page a
 * signed-out visitor sees goes through PageCache unless it says
 * `<page cache="off">`; a source that throws NotFound or Forbidden answers
 * that status, through the nearest `_error.uwu`. A URL no route answers is
 * drawn by `pages/_error.uwu` with a 404 (through `app.notFound`).
 *
 * **Who a page is kept for.** PageCache keeps a page for signed-out
 * visitors only: never one that reads `session` (or loads `when="session"`)
 * or a source marked `personal`, never for a visitor with a session or a
 * flash to show. A page that reads `viewer`, in the page or in a layout (a
 * "Hi Ann" in the header), is kept while the visitor has no viewer and drawn
 * afresh for each one who does: reading `viewer` in a layout costs signed-in
 * visitors the cache on every page, and costs signed-out ones nothing.
 *
 * **Actions** (see actions.ts). A POST to a page's URL with `_action` runs
 * the action the page names under that name, after the CSRF check (a
 * double-submit cookie, `natsu_csrf`, whose token natsu adds to every
 * action form it draws) and the `auth` rules of the `<action>` line and of
 * the action. Then a 303 back to the page (or where the action said), with
 * its `flash` in a one-time cookie the page reads as `flash`; or, for a
 * refused form, the page drawn again (422) with `form.errors`,
 * `form.values` and `form.message`; or, for an answer shown once (a new
 * key), the page drawn now with `form.shown`, never stored. With the runtime the same POST goes by
 * fetch with the page's key, and the answer is a part: the regions are
 * swapped, no reload.
 *
 * **Live data** (see invalidate.ts). A page that drew a live source carries
 * its tags in `page.head`, and the runtime refreshes the regions when one is
 * invalidated; kept copies are let go at once.
 */

import { watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import type { Assets } from "../assets.ts";
import { config } from "../config.ts";
import type { Context, Handler } from "../context.ts";
import { invalidate, onInvalidate, signTags } from "../invalidate.ts";
import { log } from "../logger.ts";
import { navigable } from "../navigate.ts";
import { PageCache, type PageCacheOptions } from "../page-cache.ts";
import { Router } from "../router.ts";
import type { Application } from "../server.ts";
import {
	ACTION_FIELD,
	CSRF_COOKIE,
	CSRF_FIELD,
	EMPTY_FORM,
	type FormState,
	FLASH_COOKIE,
	type ActionInput,
	type ActionResult,
	Invalid,
	allowed,
	anyPublicAction,
	csrfOk,
	decodeFlash,
	encodeFlash,
	hasGuard,
	inputOf,
	newToken,
	registeredAction,
	sameSitePath,
	setPublicOrigin,
	tokenOf,
	valuesOf,
} from "./actions.ts";
import type { DataDecl } from "./block.ts";
import { type CompileOptions, type CompiledFile, type Render, compileAll, evaluateServer, loadBuilt, uwuRuntime } from "./compile.ts";
import { REQUEST_NAMES, type Plan, type ServiceConfig, type UsedData, buildPlan, resolvePlan } from "./data.ts";
import { Forbidden, HttpError, NotFound, PageCompileError, Redirect } from "./errors.ts";
import { type PageMeta, escapeHtml, fillText, firstHeading, headTags } from "./meta.ts";

export interface PagesOptions {
	/** The app directory: its `pages/` is compiled in memory. */
	dir?: string;
	/** Or a directory `compilePages` wrote. */
	built?: string;
	/** Rewrites each file's source before it compiles (see `CompileOptions.transform`); `dir` only. */
	transform?: CompileOptions["transform"];
	/** The partials directory, relative to `dir` (default `pages/_partials`). */
	partials?: string;
	/** Watch `dir/pages` and recompile on change (default false). */
	dev?: boolean;
	/** Register on this router (default: a new one for every host). */
	router?: Router;
	/** Reloaded when a new page file adds a route in development; its `notFound` draws `_error.uwu`. */
	app?: Application;
	/** Base URLs for `<data x="name:GET /path">`, by service name. */
	services?: Record<string, ServiceConfig>;
	/** Who is asking, as templates read `viewer` (default: the session's `viewer` or `user`, else null). */
	viewer?: (ctx: Context) => unknown;
	/**
	 * Names the app answers for each request, beside natsu's own (`params`,
	 * `viewer`, …): the frame an existing app's layouts read (its header, its
	 * CSP nonce, its own `session`). Each getter is called once per page, when
	 * the page or a layout reads the name, and may return a promise. One of
	 * natsu's own names (`session`, `flash`) here replaces natsu's value. A page
	 * that reads any of them is drawn for each visitor, never kept. The second
	 * argument holds the `form` a refused action draws the page again with
	 * (empty otherwise), for an app whose layouts show a refusal their own way.
	 */
	request?: Record<string, (ctx: Context, drawn: { form: FormState }) => unknown>;
	/**
	 * Runs around every page, action and not-found answer, which it starts with
	 * `next()` and whose result it returns: what an existing app does around
	 * its own routes (a gate that may answer first, a request scope its
	 * sources read, response headers). It may answer without calling `next()`.
	 * An error a source throws is drawn by `_error.uwu` before `next()`
	 * returns; `around` sees only its own.
	 */
	around?: (ctx: Context, next: () => Promise<unknown>) => Promise<unknown>;
	/**
	 * Per-visitor secrets a page may carry (a CSP nonce), read as
	 * `secrets.<name>`. A page kept by PageCache is drawn with marks in their
	 * place and filled per answer. `csrf` is natsu's own on a page with actions.
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
	/** The most bytes an action's POST may carry (default 1 MB). */
	maxBody?: number;
	/**
	 * An existing app's own errors, as natsu's: a source or an action that
	 * calls the app's code may throw what that code throws (its "not found",
	 * its redirect), and this says which `NotFound`, `Redirect` or
	 * `HttpError` it means. Anything it returns undefined for is what it was.
	 */
	errors?: (error: unknown) => HttpError | undefined;
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

/** An action a route runs: under the name its markup uses. */
interface RouteAction {
	name: string;
	auth?: string;
}

interface RouteState extends Drawn {
	path: string;
	cache: "off" | number;
	/** The route (page or layouts) reads `session`: never kept. */
	readsSession: boolean;
	/** It reads `viewer`: kept only while that is null. */
	readsViewer: boolean;
	/** It reads `flash`: not kept while there is one to show. */
	readsFlash: boolean;
	/** The page file itself reads `viewer` or `session`. */
	noindex: boolean;
	/** Short name to action. */
	actions: Map<string, RouteAction>;
	error?: Drawn;
}

export interface PageRoute {
	path: string;
	file: string;
	layouts: string[];
	/** Each name the route loads and where from. */
	data: { name: string; kind: string; from: string }[];
	/** Each action the route runs, by the name its markup uses. */
	actions: { short: string; name: string; auth?: string }[];
	cache: "off" | number;
}

export interface PageSite {
	readonly routes: PageRoute[];
	/** The scoped CSS of every page file, for an asset build. */
	readonly css: string;
	/** Draws `pages/_error.uwu` with a 404 (what `app.notFound` is given). */
	readonly notFound: Handler;
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
	/** Live-data tags of what it loaded. */
	tags: string[];
}

interface Out {
	body: string;
	status: number;
	html: boolean;
	tags?: Set<string>;
	location?: string;
}

const SECRET = /^[\w.~+/=-]*$/;
const NO_SECRETS: Record<string, string> = Object.freeze({}) as Record<string, string>;
/** What uwu draws as the first child of a `<form @submit="action:…">`. */
const ACTION_INPUT = /<input type="hidden" name="_action" value="[^"]*">/g;
const MAX_BODY = 1024 * 1024;

export async function mountPages(options: PagesOptions): Promise<PageSite> {
	if (!options.dir && !options.built) throw new TypeError("natsu/pages: mountPages needs { dir } or { built }");
	const router = options.router ?? new Router();
	const rt = await uwuRuntime();
	const renderToString = rt.renderToString as (render: Render, props: unknown, opts: unknown) => Promise<string>;
	let renderOptions: Record<string, unknown> = options.render ?? {};
	const caches = new Map<number, PageCache>();
	const registered = new Set<string>();
	let routes = new Map<string, RouteState>();
	let notFoundPage: Drawn | undefined;
	let summary: PageRoute[] = [];
	let css = "";
	const maxBody = options.maxBody ?? MAX_BODY;
	const publicUrl = (): string => options.baseUrl ?? config.General.url;
	setPublicOrigin(publicUrl);
	const secure = (): boolean => publicUrl().startsWith("https:");

	const appNames = new Set(Object.keys(options.request ?? {}));
	const around = options.around;
	/** The handler, inside the app's `around` when there is one. */
	const wrapped = (inner: Handler): Handler => {
		if (!around) return inner;
		const outer: Handler = (ctx) => around(ctx, async () => inner(ctx)) as ReturnType<Handler>;
		Object.defineProperty(outer, "name", { value: inner.name });
		return outer;
	};

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

	// Kept pages by live-data tag, so an invalidation lets them go at once.
	const kept = new Map<string, Set<string>>();
	const keep = (seconds: number, key: string, tags: Iterable<string>): void => {
		for (const tag of tags) {
			let keys = kept.get(tag);
			if (!keys) kept.set(tag, (keys = new Set()));
			keys.add(`${seconds}\0${key}`);
			// PageCache forgets pages on its own; this forgets the oldest names past a bound.
			if (keys.size > 4096) keys.delete(keys.values().next().value as string);
		}
	};
	const stopListening = onInvalidate((tags) => {
		for (const tag of tags) {
			for (const entry of kept.get(tag) ?? []) {
				const cut = entry.indexOf("\0");
				caches.get(Number(entry.slice(0, cut)))?.delete(entry.slice(cut + 1));
			}
			kept.delete(tag);
		}
	});

	// --- building the table -----------------------------------------------------

	const build = async (files: CompiledFile[]): Promise<void> => {
		const loaded = new Map<string, Loaded>();
		for (const file of files) loaded.set(file.file, { ...file, render: await evaluateServer(file.server, `pages/${file.file}`) });
		const partials = new Map<string, Loaded>();
		for (const file of loaded.values()) if (file.kind === "partial" && file.partial !== undefined) partials.set(file.partial, file);

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
			for (const name of appNames) requestNames.add(name);
			const plan = buildPlan({ path, params, reads, decls, services: options.services ?? {}, requestNames });
			// What the app answers is about this visitor: never kept.
			if (plan.names.some((name) => appNames.has(name))) plan.personal = true;
			// The partials' styles go with the files that include them.
			const included = [...new Set([...layouts, page].flatMap((file) => file.partials))].map((name) => partials.get(name)?.css ?? "");
			const styles = [...layouts].reverse().concat(page).map((file) => file.css).concat(included).filter(Boolean).join("\n");
			return { page, layouts, plan, styles };
		};

		/** The actions a route runs, by the name its markup uses; fails naming what is missing. */
		const actionsOf = (page: Loaded, layouts: Loaded[]): Map<string, RouteAction> => {
			const out = new Map<string, RouteAction>();
			for (const file of [page, ...layouts]) {
				for (const decl of file.block?.actions ?? []) {
					if (out.has(decl.short)) continue; // the page's own wins over a layout's
					if (!registeredAction(decl.name)) {
						throw new PageCompileError(`pages/${file.file}`, decl.line, `<action ${decl.short}> runs '${decl.name}', and no action("${decl.name}", …) is registered`);
					}
					if (decl.auth !== undefined && !hasGuard(decl.auth)) {
						throw new PageCompileError(`pages/${file.file}`, decl.line, `<action ${decl.short} auth="${decl.auth}">: no guard("${decl.auth}", …) is registered (or say auth="viewer")`);
					}
					out.set(decl.short, { name: decl.name, ...(decl.auth !== undefined ? { auth: decl.auth } : {}) });
				}
			}
			// What the markup uses: a short name declared above, else a registered action's own name.
			for (const file of [page, ...layouts]) {
				for (const used of file.actions) {
					if (out.has(used.name)) continue;
					if (!registeredAction(used.name)) {
						throw new PageCompileError(
							`pages/${file.file}`,
							used.line,
							`action:${used.name} is used, and nothing runs it: register action("${used.name}", …) or add <action ${used.name}="area.name"> to <page>`,
						);
					}
					out.set(used.name, { name: used.name });
				}
			}
			return out;
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
				readsFlash: routeReads.has("flash"),
				noindex: "viewer" in page.reads || "session" in page.reads,
				actions: actionsOf(page, layouts),
				error,
			});
		}
		const rootError = loaded.get("_error.uwu");
		const nextNotFound = rootError ? drawn(rootError, chain(""), "/", [], ["error"]) : undefined;

		routes = next;
		notFoundPage = nextNotFound;
		renderOptions = {
			...options.render,
			partials: { ...Object.fromEntries([...partials].map(([name, file]) => [name, file.render])), ...options.render?.partials },
		};
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
			actions: [...state.actions].map(([short, a]) => ({ short, name: a.name, ...(a.auth !== undefined ? { auth: a.auth } : {}) })),
			cache: state.cache,
		}));

		let added = false;
		for (const path of next.keys()) {
			if (registered.has(path)) continue;
			registered.add(path);
			added = true;
			router.get(path, navigable(wrapped(handlerFor(path))));
			// Every page takes its actions' posts. A post is never prefetched,
			// and with the runtime its answer is a part like a visit's.
			router.post(path, navigable(wrapped(actionHandlerFor(path)), { prefetch: false }));
		}
		if (added && options.app?.running) options.app.reload();
	};

	// --- a request -------------------------------------------------------------

	const scopeFor = (ctx: Context, state: { path: string; page: Loaded }, secrets: Record<string, string>, extra: Record<string, unknown> = {}) => {
		let viewer: { v: unknown } | undefined;
		const request = new Map<string, () => unknown>([
			["viewer", () => (viewer ??= { v: viewerOf(ctx) }).v],
			["secrets", () => secrets],
			["form", () => EMPTY_FORM],
			["flash", () => decodeFlash(ctx.cookies.get(FLASH_COOKIE))],
		]);
		// The app's names see the form a refusal draws again with (its own flash may show it).
		const form = "form" in extra ? extra.form : EMPTY_FORM;
		for (const [name, get] of Object.entries(options.request ?? {})) request.set(name, () => get(ctx, { form: form as FormState }));
		for (const [name, value] of Object.entries(extra)) request.set(name, () => value);
		return { ctx, request, services: options.services ?? {}, path: state.path, params: state.page.params };
	};

	const pageValue = (meta: PageMeta, styles: string, live = "") => ({
		...meta,
		meta,
		head: headTags(meta) + (live ? `<meta name="natsu-live" content="${escapeHtml(live)}">` : "") + (styles ? `<style>${styles}</style>` : ""),
		styles,
	});

	const drawPage = async (drawn: Drawn, values: Record<string, unknown>, meta: PageMeta, fallbackTitle: string, live = ""): Promise<string> => {
		// The page itself sees `page` without the <h1> title (that comes from what it draws).
		if ("page" in drawn.page.reads) values.page = pageValue(meta, drawn.styles, live);
		const html = await renderToString(drawn.page.render, values, renderOptions);
		if (!meta.title) meta.title = firstHeading(html) || fallbackTitle;
		values.page = pageValue(meta, drawn.styles, live);
		let out = html;
		for (const layout of drawn.layouts) out = await renderToString(layout.render, values, { ...renderOptions, child: out });
		return out;
	};

	const canonical = (ctx: Context): string => publicUrl().replace(/\/+$/, "") + ctx.path;

	/** Every action form gets the visitor's token (or PageCache's mark for it) beside its `_action`. */
	const withToken = (html: string, token: string | undefined): string =>
		token === undefined ? html : html.replace(ACTION_INPUT, (input) => `${input}<input type="hidden" name="${CSRF_FIELD}" value="${token}">`);

	const draw = async (ctx: Context, state: RouteState, secrets: Record<string, string>, extra: Record<string, unknown> = {}): Promise<Out> => {
		try {
			const scope = scopeFor(ctx, state, secrets, extra);
			const { values, used, tags } = await resolvePlan(state.plan, scope);
			ctx.locals.page = { route: state.path, file: state.page.file, used, tags: [...tags] } satisfies PageLocals;
			const block = state.page.block;
			const meta: PageMeta = {
				title: fillText(block?.title, values),
				description: fillText(block?.description, values),
				canonical: canonical(ctx),
				robots: state.noindex ? "noindex" : "",
			};
			const html = await drawPage(state, values, meta, "", signTags(tags));
			return { body: withToken(html, state.actions.size > 0 ? secrets.csrf : undefined), status: 200, html: true, tags };
		} catch (thrown) {
			const error = known(thrown);
			if (error instanceof Redirect) return { body: "", status: error.status, html: false, location: sameSitePath(error.location) ?? "/" };
			return drawError(ctx, state, state.error, secrets, error);
		}
	};

	/** The app's own error as natsu's, when `options.errors` knows it. */
	const known = (error: unknown): unknown => options.errors?.(error) ?? error;

	const drawError = async (ctx: Context, state: { path: string; page: Loaded }, page: Drawn | undefined, secrets: Record<string, string>, error: unknown): Promise<Out> => {
		const status = error instanceof HttpError ? error.status : 500;
		const message = error instanceof HttpError ? error.message : config.General.development ? String((error as Error)?.stack ?? error) : "Internal Server Error";
		if (status >= 500) log.error(`[<red>pages</red>] ${ctx.method} ${ctx.path} (pages/${state.page.file}): ${(error as Error)?.stack ?? error}`);
		if (page) {
			try {
				const scope = scopeFor(ctx, state, secrets, { error: { status, message } });
				const { values } = await resolvePlan(page.plan, scope);
				const meta: PageMeta = { title: "", description: "", canonical: "", robots: "noindex" };
				return { body: await drawPage(page, values, meta, String(status)), status, html: true };
			} catch (inner) {
				log.error(`[<red>pages</red>] pages/${page.page.file} failed drawing a ${status}: ${(inner as Error)?.stack ?? inner}`);
			}
		}
		return { body: status === 404 ? "Not Found" : status === 403 ? "Forbidden" : message, status, html: false };
	};

	const answer = (ctx: Context, out: { body: string; status: number; html?: boolean; headers?: Record<string, string>; location?: string }): string => {
		const location = out.location ?? out.headers?.location;
		if (location !== undefined) {
			ctx.response.redirect(location, out.status);
			return "";
		}
		ctx.response.status = out.status;
		if (out.html ?? out.headers?.["content-type"]?.startsWith("text/html")) ctx.response.type = "text/html; charset=utf-8";
		else ctx.response.type = "text/plain; charset=utf-8";
		return out.body;
	};

	/** The visitor's secrets, with the CSRF token on a route with actions (minted, and its cookie set, if there is none). */
	const secretsFor = (ctx: Context, state: RouteState): Record<string, string> => {
		const own = options.secrets ? options.secrets(ctx) : NO_SECRETS;
		if (state.actions.size === 0) return own;
		let token = tokenOf(ctx);
		if (token === undefined) {
			token = newToken();
			// Readable by the runtime, which sends it back with a click; a
			// cross-site page can neither read it nor set it.
			ctx.setCookie(CSRF_COOKIE, token, { httpOnly: false, sameSite: "lax", secure: secure(), path: "/" });
		}
		return { ...own, csrf: token };
	};

	function handlerFor(path: string): Handler {
		const handler: Handler = async (ctx) => {
			const state = routes.get(path);
			if (!state) return undefined; // removed in development: a 404

			// A flash is shown once: a page that draws it is this visitor's, and
			// a prefetch must not use it up unseen.
			const flashed = state.readsFlash && ctx.cookies.has(FLASH_COOKIE);
			// Read before it is cleared: clearing it takes it out of ctx.cookies too.
			const extra = flashed ? { flash: decodeFlash(ctx.cookies.get(FLASH_COOKIE)) } : undefined;
			if (flashed) {
				if (ctx.nav.skip()) return undefined;
				ctx.nav.shown(() => ctx.deleteCookie(FLASH_COOKIE, { path: "/" }));
			}

			const secrets = secretsFor(ctx, state);
			const names = state.actions.size > 0 || options.secrets ? Object.keys(secrets).sort() : [];

			const cacheable =
				state.cache !== "off" &&
				!flashed &&
				!state.plan.personal &&
				!state.readsSession &&
				!ctx.sessionLoaded &&
				names.every((name) => SECRET.test(secrets[name]!)) &&
				(!state.readsViewer || (await viewerOf(ctx)) == null);
			if (cacheable) {
				const seconds = state.cache as number;
				const key = ctx.path + ctx.search;
				const kept = await cacheFor(seconds).serve(
					key,
					names.map((name) => secrets[name]!),
					async (marks) => {
						const out = await draw(ctx, state, Object.fromEntries(names.map((name, i) => [name, marks[i]!])));
						if (out.status === 200 && out.tags) keep(seconds, key, out.tags);
						return {
							body: out.body,
							status: out.status,
							headers: { "content-type": out.html ? "text/html; charset=utf-8" : "text/plain; charset=utf-8", ...(out.location !== undefined && { location: out.location }) },
							keep: out.status === 200,
						};
					},
				);
				if (kept) {
					if (kept.prepared) options.assets?.markRewritten(ctx, kept);
					return answer(ctx, kept);
				}
			}
			return answer(ctx, await draw(ctx, state, secrets, extra));
		};
		Object.defineProperty(handler, "name", { value: `page ${path}` });
		return handler;
	}

	function actionHandlerFor(path: string): Handler {
		const handler: Handler = async (ctx) => {
			const state = routes.get(path);
			if (!state) return undefined;
			const plain = (status: number, body: string): string => answer(ctx, { status, body, html: false });
			if (state.actions.size === 0 && !anyPublicAction()) {
				ctx.response.headers.set("allow", "GET, HEAD");
				return plain(405, "Method Not Allowed");
			}

			// Browsers always send a length for a form; without one the body is unbounded.
			const length = Number(ctx.headers.get("content-length") ?? Number.NaN);
			if (!Number.isFinite(length)) return plain(411, "Length Required");
			if (length > maxBody) return plain(413, "Payload Too Large");
			let form: FormData;
			try {
				form = await ctx.request.formData();
			} catch {
				return plain(400, "Bad Request");
			}

			// Only what this page names, or a public action: never a name off the wire alone.
			const short = form.get(ACTION_FIELD);
			const target: RouteAction | undefined =
				typeof short !== "string" ? undefined : state.actions.get(short) ?? (registeredAction(short)?.options.public ? { name: short } : undefined);
			const entry = target && registeredAction(target.name);
			if (!target || !entry || typeof short !== "string") return plain(404, "Unknown action");

			const secrets = secretsFor(ctx, state);
			const refuse = async (thrown: unknown): Promise<string> => {
				const error = known(thrown);
				// Sent elsewhere (a sign-in first, a step the app asks for): a 303, as a success is.
				if (error instanceof Redirect) return answer(ctx, { body: "", status: 303, location: sameSitePath(error.location) ?? "/" });
				return answer(ctx, await drawError(ctx, state, state.error, secrets, error));
			};
			if (entry.options.csrf !== false && !csrfOk(ctx, form)) {
				return refuse(new HttpError(403, "This form has expired: reload the page and try again."));
			}
			const viewer = await viewerOf(ctx);
			const who = { viewer, ctx, params: ctx.params };
			for (const rule of [target.auth, entry.options.auth]) {
				let ok: boolean;
				try {
					ok = await allowed(rule, who);
				} catch (error) {
					return refuse(error);
				}
				if (!ok) return refuse(viewer == null ? new HttpError(401, "Sign in to do that.") : new Forbidden("You may not do that."));
			}

			const input = inputOf(form);
			const run: ActionInput = {
				name: entry.name,
				short,
				input,
				form,
				params: ctx.params,
				query: ctx.query,
				session: ctx.sessionLoaded ? ctx.session : null,
				viewer,
				ctx,
			};
			let result: ActionResult;
			try {
				result = (await entry.fn(run)) ?? {};
			} catch (error) {
				if (!(error instanceof Invalid)) return refuse(error);
				result = { errors: error.errors, message: error.formMessage };
			}

			if (result.errors && (Object.keys(result.errors).length > 0 || result.message)) {
				// Refused: the page again, with what was typed and why, for the visitor to fix.
				const out = await draw(ctx, state, secrets, {
					form: { action: short, errors: result.errors, values: valuesOf(input), message: result.message ?? "" },
				});
				return answer(ctx, { ...out, status: out.status === 200 ? 422 : out.status });
			}

			const tags: string[] = [];
			for (const touch of entry.options.touches ?? []) {
				const more = typeof touch === "string" ? touch : touch(run);
				if (typeof more === "string") tags.push(more);
				else if (more) tags.push(...more);
			}
			invalidate(tags);

			if (result.show) {
				// Shown once: drawn into this answer only, never kept by a cache or the history's URL.
				const out = await draw(ctx, state, secrets, {
					form: { action: short, errors: {}, values: {}, message: result.flash ?? "", shown: result.show },
				});
				ctx.response.headers.set("cache-control", "no-store");
				return answer(ctx, out);
			}

			if (result.flash) {
				ctx.setCookie(FLASH_COOKIE, encodeFlash({ message: result.flash, ok: true }), { httpOnly: true, sameSite: "lax", secure: secure(), path: "/", maxAge: 60 });
			}
			const back = ctx.path + ctx.search;
			ctx.response.redirect((result.redirect && sameSitePath(result.redirect)) || back, 303);
			return undefined;
		};
		Object.defineProperty(handler, "name", { value: `actions ${path}` });
		return handler;
	}

	const notFound: Handler = wrapped(async (ctx) => {
		const page = notFoundPage;
		if (!page) return undefined;
		const secrets = options.secrets ? options.secrets(ctx) : NO_SECRETS;
		return answer(ctx, await drawError(ctx, { path: "/", page: page.page }, page, secrets, new NotFound()));
	});

	// --- loading ----------------------------------------------------------------

	const compileOptions: CompileOptions = { partials: options.partials, transform: options.transform };
	const compileNow = (): CompiledFile[] => (options.built ? loadBuilt(options.built) : compileAll(options.dir!, compileOptions));
	await build(compileNow());
	options.app?.notFound(notFound);

	let watcher: FSWatcher | undefined;
	if (options.dev && options.dir) {
		let timer: ReturnType<typeof setTimeout> | undefined;
		watcher = watch(join(options.dir, "pages"), { recursive: true }, () => {
			clearTimeout(timer);
			timer = setTimeout(() => {
				Promise.resolve()
					.then(() => build(compileAll(options.dir!, compileOptions)))
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
		notFound,
		reload: () => build(compileNow()),
		close: () => {
			watcher?.close();
			stopListening();
		},
	};
}
