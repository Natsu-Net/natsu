/**
 * Routing.
 *
 * v1 extended Oak's router; v2 owns the table and hands the matching itself to
 * `Bun.serve`'s native `routes`, which resolves `/users/:id` in the C++ layer
 * before any JavaScript runs. What is left in TypeScript is the part Bun has no
 * opinion about: `"Controller@method"` strings, per-domain routers, `Prefix`
 * groups with a guard, and which candidate wins when several match.
 *
 * The v1 surface is unchanged:
 *
 *   const Routes = new Router("127.0.0.1:8083");
 *   Routes.get("/", "Home@Home");
 *   Routes.Prefix("/test", (sub) => sub.get("/user", "Test@user"), guard);
 *
 * and the decorator form sits beside it:
 *
 *   @Controller("/users")
 *   class Users { @Get("/:id") show(ctx) { … } }
 */

import type { Context, Handler } from "./context.ts";
import { GetController } from "./controller.ts";
import { CLog } from "./logger.ts";
import {
	bindController,
	routeMetaOf,
	setRouteBinder,
	type ControllerBinding,
	type DecoratorMetadata,
	type HttpMethod,
	type RouteMethod,
} from "./metadata.ts";

/**
 * v1's guard contract, kept verbatim: the route runs only if the guard returns
 * something truthy. Returning nothing blocks — deny by default. It reads like a
 * trap, but flipping it would quietly open every v1 app whose guard denies with
 * a bare `return;`.
 */
export type PrefixMiddleware = (ctx: Context) => boolean | void | Promise<boolean | void>;

export type RouteHandlerRef = string | Handler;

export interface RouteRecord {
	method: RouteMethod;
	path: string;
	domain: string | undefined;
	guards: readonly PrefixMiddleware[];
	handler: Handler;
	/** `Home@Index` or `fn` — logging and introspection only. */
	label: string;
	order: number;
}

const records: RouteRecord[] = [];
let sequence = 0;
let dirty = true;
let compiled: CompiledRoutes | undefined;

function normalisePath(path: string): string {
	if (!path || path === "/") return "/";
	let out = path.startsWith("/") ? path : `/${path}`;
	// Collapse the accidental `//` that prefix joining produces.
	out = out.replace(/\/{2,}/g, "/");
	if (out.length > 1 && out.endsWith("/")) out = out.slice(0, -1);
	return out;
}

function joinPath(prefix: string, path: string): string {
	if (!prefix || prefix === "/") return normalisePath(path);
	if (!path || path === "/") return normalisePath(prefix);
	return normalisePath(`${prefix}/${path}`);
}

export class Router {
	public readonly domain: string | undefined;
	public readonly prefix: string;

	private readonly guards: readonly PrefixMiddleware[];

	/** Every router ever constructed, in construction order. */
	static instances: Router[] = [];

	/**
	 * @param domain Host to answer for — `undefined` answers every host.
	 */
	constructor(domain?: string, prefix = "/", guards: readonly PrefixMiddleware[] = []) {
		this.domain = domain;
		this.prefix = normalisePath(prefix);
		this.guards = guards;
		Router.instances.push(this);
	}

	private add(method: RouteMethod, path: string, handler: RouteHandlerRef): this {
		const full = joinPath(this.prefix, path);
		const label = typeof handler === "string" ? handler : (handler.name || "fn");
		records.push({
			method,
			path: full,
			domain: this.domain,
			guards: this.guards,
			// String refs resolve per request so controller files may be
			// imported after the routes that point at them.
			handler: typeof handler === "string" ? GetController(handler) : handler,
			label,
			order: sequence++,
		});
		dirty = true;
		CLog(
			`[<green>Routes</green>] Register : <cyan>${method === "ALL" ? "*" : method} ${full}</cyan> > ${label}${
				this.domain ? ` @<yellow>${this.domain}</yellow>` : ""
			}`,
		);
		return this;
	}

	public get(path: string, handler: RouteHandlerRef): this {
		return this.add("GET", path, handler);
	}

	public post(path: string, handler: RouteHandlerRef): this {
		return this.add("POST", path, handler);
	}

	public put(path: string, handler: RouteHandlerRef): this {
		return this.add("PUT", path, handler);
	}

	public delete(path: string, handler: RouteHandlerRef): this {
		return this.add("DELETE", path, handler);
	}

	public patch(path: string, handler: RouteHandlerRef): this {
		return this.add("PATCH", path, handler);
	}

	public options(path: string, handler: RouteHandlerRef): this {
		return this.add("OPTIONS", path, handler);
	}

	public head(path: string, handler: RouteHandlerRef): this {
		return this.add("HEAD", path, handler);
	}

	public all(path: string, handler: RouteHandlerRef): this {
		return this.add("ALL", path, handler);
	}

	/**
	 * Group routes under a path, optionally behind a guard.
	 *
	 * Nesting composes: an inner group inherits the outer group's guards and
	 * runs them outermost-first.
	 */
	public Prefix(path: string, build: (sub: Router) => void, middleware?: PrefixMiddleware): this {
		const guards = middleware ? [...this.guards, middleware] : this.guards;
		build(new Router(this.domain, joinPath(this.prefix, path), guards));
		return this;
	}

	/** Compile every registered route into a dispatch table. Cached until a route is added. */
	static routes(): CompiledRoutes {
		if (!dirty && compiled) return compiled;
		compiled = compileRoutes(records);
		dirty = false;
		return compiled;
	}

	static records(): readonly RouteRecord[] {
		return records;
	}

	/** Forget every route and router. Tests call this between cases. */
	static clear(): void {
		records.length = 0;
		Router.instances.length = 0;
		sequence = 0;
		dirty = true;
		compiled = undefined;
	}
}

export interface RouteEntry {
	path: string;
	/** Methods this path answers, for the `Allow` header on a 405. */
	allow: string[];
	/** True when some candidate is registered for every method. */
	catchAll: boolean;
	select(method: string, host: string): Handler | undefined;
}

export interface CompiledRoutes {
	entries: Map<string, RouteEntry>;
}

function hostMatches(domain: string, host: string): boolean {
	const wanted = domain.toLowerCase();
	const got = host.toLowerCase();
	if (wanted === got) return true;
	// A domain written without a port matches any port, so one config value
	// works behind a proxy on :80 and locally on :8083.
	if (!wanted.includes(":")) {
		const colon = got.lastIndexOf(":");
		if (colon !== -1 && got.slice(0, colon) === wanted) return true;
	}
	return false;
}

/**
 * Wrap a record's handler in its guards once, at compile time, so a request
 * pays for the guards it actually has and nothing else.
 */
function guarded(record: RouteRecord): Handler {
	const guards = record.guards;
	if (guards.length === 0) return record.handler;
	const handler = record.handler;
	return async (ctx: Context) => {
		for (const guard of guards) {
			if (!(await guard(ctx))) return undefined;
		}
		return handler(ctx);
	};
}

function compileRoutes(source: readonly RouteRecord[]): CompiledRoutes {
	const byPath = new Map<string, RouteRecord[]>();
	for (const record of source) {
		const list = byPath.get(record.path);
		if (list) list.push(record);
		else byPath.set(record.path, [record]);
	}

	const entries = new Map<string, RouteEntry>();
	for (const [path, list] of byPath) {
		entries.set(path, buildEntry(path, list));
	}

	// `/x/` should reach `/x`: Bun matches route paths literally, and a
	// trailing slash from a browser address bar is not a different route.
	// Explicit registrations always win over the alias.
	for (const [path, entry] of [...entries]) {
		if (path === "/") continue;
		const alias = `${path}/`;
		if (!entries.has(alias)) entries.set(alias, entry);
	}

	return { entries };
}

function buildEntry(path: string, list: RouteRecord[]): RouteEntry {
	const byMethod = new Map<string, { handler: Handler; domain: string | undefined; order: number }[]>();

	for (const record of list) {
		const candidates = byMethod.get(record.method) ?? [];
		candidates.push({ handler: guarded(record), domain: record.domain, order: record.order });
		byMethod.set(record.method, candidates);
	}

	for (const candidates of byMethod.values()) {
		// A router bound to a host is more specific than a catch-all one, so it
		// is tried first regardless of which file happened to load first.
		// Registration order breaks ties, which makes the table deterministic.
		candidates.sort((a, b) => {
			const specificity = Number(b.domain !== undefined) - Number(a.domain !== undefined);
			return specificity !== 0 ? specificity : a.order - b.order;
		});
	}

	const allow = [...byMethod.keys()].filter((method) => method !== "ALL");
	if (byMethod.has("GET") && !allow.includes("HEAD")) allow.push("HEAD");
	const catchAll = byMethod.has("ALL");
	if (catchAll) allow.push("*");

	return {
		path,
		allow,
		catchAll,
		select(method: string, host: string): Handler | undefined {
			let candidates = byMethod.get(method);
			// HEAD is GET without a body; Bun drops the body for us.
			if (!candidates && method === "HEAD") candidates = byMethod.get("GET");
			if (!candidates) candidates = byMethod.get("ALL");
			else if (byMethod.has("ALL")) {
				const fromMethod = pick(candidates, host);
				return fromMethod ?? pick(byMethod.get("ALL") ?? [], host);
			}
			return candidates ? pick(candidates, host) : undefined;
		},
	};
}

function pick(candidates: { handler: Handler; domain: string | undefined }[], host: string): Handler | undefined {
	for (const candidate of candidates) {
		if (candidate.domain === undefined || hostMatches(candidate.domain, host)) return candidate.handler;
	}
	return undefined;
}

// --- decorator routing -----------------------------------------------------

function methodDecorator(method: RouteMethod) {
	return function route(path = "/") {
		return function decorate<T extends (ctx: Context) => unknown>(
			target: T,
			context: ClassMethodDecoratorContext,
		): T {
			if (context.static) {
				throw new TypeError(`natsu: @${method} cannot decorate a static method (${String(context.name)})`);
			}
			routeMetaOf(context.metadata as DecoratorMetadata).routes.push({
				method,
				path,
				property: String(context.name),
			});
			return target;
		};
	};
}

export const Get = methodDecorator("GET");
export const Post = methodDecorator("POST");
export const Put = methodDecorator("PUT");
export const Delete = methodDecorator("DELETE");
export const Patch = methodDecorator("PATCH");
export const Options = methodDecorator("OPTIONS");
export const Head = methodDecorator("HEAD");
export const All = methodDecorator("ALL");

/** Router used by decorated controllers that name no domain. */
const decoratorRouters = new Map<string, Router>();

function routerFor(domain: string | undefined, prefix: string): Router {
	const key = `${domain ?? ""}|${prefix}`;
	let router = decoratorRouters.get(key);
	if (!router) {
		router = new Router(domain, prefix);
		decoratorRouters.set(key, router);
	}
	return router;
}

// Installed at import time: a class decorated before this module loaded was
// queued by metadata.ts and is flushed here.
setRouteBinder((binding: ControllerBinding) => {
	const router = routerFor(binding.domain, binding.prefix);
	for (const route of binding.routes) {
		const handler = binding.resolve(route.property);
		Object.defineProperty(handler, "name", { value: `${binding.name}@${route.property}` });
		switch (route.method) {
			case "ALL":
				router.all(route.path, handler);
				break;
			default:
				router[route.method.toLowerCase() as Lowercase<HttpMethod>](route.path, handler);
		}
	}
});

/** Register a decorated class by hand, for code that builds classes at runtime. */
export function registerController(binding: ControllerBinding): void {
	bindController(binding);
}

export function clearDecoratorRouters(): void {
	decoratorRouters.clear();
}

export type { RouteMethod };
