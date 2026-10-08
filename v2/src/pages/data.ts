/**
 * Automatic data: every name a page reads is found, per request, without a
 * controller.
 *
 * For each top-level name a page (and its layouts) reads, in this order:
 *
 *  1. the request: `params`, `query`, `viewer`, `session` (and `secrets`,
 *     `page`, `error` where they apply);
 *  2. a `<data>` line in the page's `<page>` block, which names a source
 *     with arguments, or a service GET;
 *  3. a source registered under that name: `source("product", fn)`;
 *  4. the model resolver: a singular name on a route with a matching
 *     parameter loads one row (none is a 404), a plural name loads a list;
 *  5. nothing: mounting the pages fails, naming the file, the line and the
 *     name.
 *
 * Every load starts at once and runs in parallel; one that `needs` another
 * name (declared on the source, or implied by a `<data>` argument such as
 * `id=product.id`) waits for that one only. Each source is handed the field
 * paths the templates read of its name (`fields`), so it can select those
 * and nothing else.
 */

import type { Context } from "../context.ts";
import type { Session } from "../session/session.ts";
import type { Arg, DataDecl, TextTemplate } from "./block.ts";
import { Forbidden, HttpError, NotFound, PageCompileError } from "./errors.ts";

// --- sources -----------------------------------------------------------------

export interface SourceInput {
	/** The name being loaded (a `<data>` line can load one source under several names). */
	name: string;
	params: Record<string, string>;
	query: Record<string, string>;
	/** The visitor's session, or null: never created by reading it. */
	session: Session | null;
	ctx: Context;
	/** Arguments from a `<data>` line, evaluated. */
	args: Record<string, unknown>;
	/** Field paths the templates read of this name; `["*"]` when used whole. */
	fields: string[];
	/** Another name's value, waiting for it if it is still loading. */
	need: (name: string) => Promise<unknown>;
}

export type SourceFn = (input: SourceInput) => unknown;

export interface SourceOptions {
	/** Names to load first; their values are ready through `need`. */
	needs?: string[];
	/** Null or undefined is a 404. */
	required?: boolean;
	/**
	 * The value depends on who is asking in a way natsu cannot see (a
	 * cookie, a header): pages that read it are never kept by PageCache.
	 */
	personal?: boolean;
}

interface RegisteredSource {
	fn: SourceFn;
	options: SourceOptions;
}

const sources = new Map<string, RegisteredSource>();

/**
 * Provide a name to every page that reads it, or a source `<data>` lines
 * can call by name:
 *
 *   source("categories", () => db.categories());
 *   source("products.bySlug", ({ args, fields }) => db.product(args.slug, fields));
 *   source("related", ({ need }) => need("product").then(related), { needs: ["product"] });
 *
 * Throw (or return) `NotFound` or `Forbidden` to answer the page with that
 * status. Register sources before `mountPages`, which checks every name.
 */
export function source(name: string, fn: SourceFn, options: SourceOptions = {}): void {
	if (!/^[A-Za-z_$][\w$-]*(?:\.[A-Za-z_$][\w$-]*)*$/.test(name)) throw new TypeError(`natsu/pages: '${name}' is not a source name`);
	sources.set(name, { fn, options });
}

export function removeSource(name: string): void {
	sources.delete(name);
}

/** Forget every source and the model resolver. Tests call this. */
export function clearSources(): void {
	sources.clear();
	resolver = undefined;
}

// --- models ------------------------------------------------------------------

export type ModelKind = { kind: "one"; param: string } | { kind: "many" };

export interface ModelOneInput {
	params: Record<string, string>;
	/** The route parameter that names the row, and its value. */
	param: string;
	value: string;
	fields: string[];
	ctx: Context;
}

export interface ModelManyInput {
	query: Record<string, string>;
	/** `?sort=` and `?page=`, as sent: the resolver decides which fields may sort. */
	sort: string | undefined;
	page: number;
	fields: string[];
	ctx: Context;
}

/**
 * Where a name no source provides comes from: a database, through the ORM
 * plugin. `kind` says whether (and how) it loads a name; without it, natsu
 * guesses (see `defaultKind`).
 */
export interface ModelResolver {
	kind?(name: string, route: { path: string; params: readonly string[] }): ModelKind | null | undefined;
	/** One row; null or undefined is a 404. */
	one(name: string, input: ModelOneInput): unknown;
	many(name: string, input: ModelManyInput): unknown;
}

let resolver: ModelResolver | undefined;

/** Install (or with null, remove) the model resolver. One at a time. */
export function registerModelResolver(next: ModelResolver | null): void {
	resolver = next ?? undefined;
}

/**
 * natsu's guess when the resolver has no `kind`: `product` on a route with a
 * `product`, `productId` or `product_id` parameter, or with a single `id` or
 * `slug`, is one row; `products` is a list.
 */
export function defaultKind(name: string, params: readonly string[]): ModelKind | null {
	for (const param of [name, `${name}Id`, `${name}_id`]) if (params.includes(param)) return { kind: "one", param };
	if (/[^s]s$/.test(name)) return { kind: "many" };
	if (params.length === 1 && (params[0] === "id" || params[0] === "slug")) return { kind: "one", param: params[0] };
	return null;
}

function modelKind(name: string, path: string, params: readonly string[]): ModelKind | null {
	if (!resolver) return null;
	if (resolver.kind) return resolver.kind(name, { path, params }) ?? null;
	return defaultKind(name, params);
}

// --- services ----------------------------------------------------------------

export interface ServiceConfig {
	/** Base URL the `<data>` path is appended to: `http://inventory.internal:9000`. */
	base: string;
	/** Forward the visitor's Cookie header (default true). Pages using it are never kept. */
	cookie?: boolean;
	headers?: Record<string, string>;
	/** Milliseconds before the fetch is given up (default 5000). */
	timeout?: number;
}

// --- plans ---------------------------------------------------------------------

/** Names the request itself answers. */
export const REQUEST_NAMES = new Set(["params", "query", "viewer", "session", "secrets", "page", "error"]);

export type Loader =
	| { t: "request"; name: string }
	| {
			t: "source";
			name: string;
			source: string;
			args: Record<string, Arg>;
			needs: string[];
			required: boolean;
			fallback?: { v: unknown };
			when?: "session";
			fields: string[];
	  }
	| { t: "one"; name: string; param: string; fields: string[] }
	| { t: "many"; name: string; fields: string[] }
	| {
			t: "api";
			name: string;
			service: string;
			path: TextTemplate;
			needs: string[];
			required: boolean;
			fallback?: { v: unknown };
			when?: "session";
	  };

/** How one route gets its data: worked out once, at mount. */
export interface Plan {
	/** Every name to load, in the order they were first read. */
	names: string[];
	loaders: Map<string, Loader>;
	/** A load depends on the visitor beyond what natsu can see. */
	personal: boolean;
	/** Where each name is first read, for errors. */
	readAt: Map<string, string>;
}

export interface PlanInput {
	/** The route pattern and its parameters. */
	path: string;
	params: readonly string[];
	/** Every name read, with fields and where: page first, then layouts outwards. */
	reads: Map<string, { fields: string[]; at: string }>;
	decls: Map<string, DataDecl & { file: string }>;
	services: Record<string, ServiceConfig>;
	/** Request names this route may read (`error` only on an error page; `secrets` only when configured). */
	requestNames: ReadonlySet<string>;
}

/** Work out a route's loads, or fail naming the first name nothing provides. */
export function buildPlan(input: PlanInput): Plan {
	const loaders = new Map<string, Loader>();
	const readAt = new Map<string, string>();
	const order: string[] = [];
	let personal = false;

	const fieldsOf = (name: string): string[] => input.reads.get(name)?.fields ?? [];

	const add = (name: string, at: string): void => {
		if (loaders.has(name)) return;
		readAt.set(name, at);
		const loader = loaderFor(name, at);
		loaders.set(name, loader);
		order.push(name);
		if (loader.t === "source" || loader.t === "api") for (const need of loader.needs) add(need, at);
	};

	const loaderFor = (name: string, at: string): Loader => {
		if (input.requestNames.has(name)) return { t: "request", name };
		const decl = input.decls.get(name);
		if (decl) {
			const where = `${decl.file}:${decl.line}`;
			const needs = new Set<string>();
			if (decl.from.t === "source") {
				const registered = sources.get(decl.from.source);
				if (!registered) {
					throw new PageCompileError(decl.file, decl.line, `<data ${name}> calls '${decl.from.source}', and no source("${decl.from.source}", …) is registered`);
				}
				for (const arg of Object.values(decl.from.args)) if (arg.t === "path") needs.add(arg.segments[0]!);
				for (const need of registered.options.needs ?? []) needs.add(need);
				if (registered.options.personal) personal = true;
				needs.delete(name);
				for (const need of needs) readAt.set(need, readAt.get(need) ?? where);
				return {
					t: "source",
					name,
					source: decl.from.source,
					args: decl.from.args,
					needs: [...needs],
					required: decl.required || registered.options.required === true,
					fallback: decl.fallback,
					when: decl.when,
					fields: fieldsOf(name),
				};
			}
			const service = input.services[decl.from.service];
			if (!service) {
				throw new PageCompileError(decl.file, decl.line, `<data ${name}> fetches from '${decl.from.service}', which is not a configured service (mountPages({ services }))`);
			}
			if (service.cookie !== false) personal = true;
			for (const part of decl.from.path) if (Array.isArray(part)) needs.add(part[0]!);
			needs.delete(name);
			return { t: "api", name, service: decl.from.service, path: decl.from.path, needs: [...needs], required: decl.required, fallback: decl.fallback, when: decl.when };
		}
		const registered = sources.get(name);
		if (registered) {
			if (registered.options.personal) personal = true;
			return {
				t: "source",
				name,
				source: name,
				args: {},
				needs: (registered.options.needs ?? []).filter((need) => need !== name),
				required: registered.options.required === true,
				fields: fieldsOf(name),
			};
		}
		const model = modelKind(name, input.path, input.params);
		if (model?.kind === "one") return { t: "one", name, param: model.param, fields: fieldsOf(name) };
		if (model?.kind === "many") return { t: "many", name, fields: fieldsOf(name) };
		const [file, line] = splitAt(at);
		throw new PageCompileError(
			file,
			line,
			`'${name}' is read, and nothing provides it: register source("${name}", …), add <data ${name}="…"> to <page>, or a model resolver that knows it`,
		);
	};

	for (const [name, read] of input.reads) add(name, read.at);
	checkCycles(loaders, readAt);
	return { names: order, loaders, personal, readAt };
}

function splitAt(at: string): [string, number] {
	const colon = at.lastIndexOf(":");
	return [at.slice(0, colon), Number(at.slice(colon + 1)) || 1];
}

function checkCycles(loaders: Map<string, Loader>, readAt: Map<string, string>): void {
	const state = new Map<string, 1 | 2>();
	const visit = (name: string, path: string[]): void => {
		const seen = state.get(name);
		if (seen === 2) return;
		if (seen === 1) {
			const [file, line] = splitAt(readAt.get(name) ?? "pages:1");
			throw new PageCompileError(file, line, `'${name}' needs itself: ${[...path, name].join(" -> ")}`);
		}
		state.set(name, 1);
		const loader = loaders.get(name);
		if (loader && (loader.t === "source" || loader.t === "api")) for (const need of loader.needs) visit(need, [...path, name]);
		state.set(name, 2);
	};
	for (const name of loaders.keys()) visit(name, []);
}

// --- resolving ---------------------------------------------------------------

/** What a request answered, kept for the live updates that come next. */
export interface UsedData {
	name: string;
	kind: Loader["t"];
	/** The source, service or model name it came from. */
	from: string;
}

export interface ResolveScope {
	ctx: Context;
	/** Values the request already knows: `viewer`, `secrets`, `page`, `error`. */
	request: Map<string, () => unknown>;
	services: Record<string, ServiceConfig>;
	path: string;
	params: readonly string[];
}

export interface Resolved {
	values: Record<string, unknown>;
	used: UsedData[];
}

function walk(value: unknown, segments: readonly string[]): unknown {
	let current = value;
	for (const segment of segments) {
		if (current === null || current === undefined) return undefined;
		current = (current as Record<string, unknown>)[segment];
	}
	return current;
}

/** Load every name of a plan, in parallel; the first NotFound/Forbidden/error rejects. */
export async function resolvePlan(plan: Plan, scope: ResolveScope): Promise<Resolved> {
	const { ctx } = scope;
	const memo = new Map<string, Promise<unknown>>();
	const used: UsedData[] = [];

	const get = (name: string): Promise<unknown> => {
		let pending = memo.get(name);
		if (pending) return pending;
		const loader = plan.loaders.get(name) ?? lateLoader(name, scope);
		pending = run(loader);
		// Every load is awaited by someone or by Promise.all below; this keeps a
		// load that fails after another already did from being "unhandled".
		pending.catch(() => {});
		memo.set(name, pending);
		return pending;
	};

	const value = async (arg: Arg): Promise<unknown> => (arg.t === "literal" ? arg.v : walk(await get(arg.segments[0]!), arg.segments.slice(1)));

	const settle = (loader: Loader & { required: boolean; fallback?: { v: unknown } }, result: unknown): unknown => {
		if (result instanceof HttpError) throw result;
		if (result === null || result === undefined) {
			if (loader.fallback) return loader.fallback.v;
			if (loader.required) throw new NotFound(`${loader.name} not found`);
			return result ?? null;
		}
		return result;
	};

	const guarded = async (loader: Loader & { required: boolean; fallback?: { v: unknown }; when?: "session" }, load: () => Promise<unknown>): Promise<unknown> => {
		if (loader.when === "session" && !ctx.sessionLoaded) return loader.fallback ? loader.fallback.v : null;
		try {
			return settle(loader, await load());
		} catch (error) {
			// A fallback stands in for a load that failed or found nothing; a refusal stays a refusal.
			if (loader.fallback && !(error instanceof Forbidden)) return loader.fallback.v;
			throw error;
		}
	};

	const run = async (loader: Loader): Promise<unknown> => {
		switch (loader.t) {
			case "request":
				return requestValue(loader.name, scope);
			case "source": {
				const registered = sources.get(loader.source);
				if (!registered) throw new Error(`natsu/pages: source '${loader.source}' was removed`);
				used.push({ name: loader.name, kind: "source", from: loader.source });
				return guarded(loader, async () => {
					await Promise.all(loader.needs.map(get));
					const args: Record<string, unknown> = {};
					for (const [key, arg] of Object.entries(loader.args)) args[key] = await value(arg);
					return registered.fn({
						name: loader.name,
						params: ctx.params,
						query: ctx.query,
						session: ctx.sessionLoaded ? ctx.session : null,
						ctx,
						args,
						fields: loader.fields,
						need: get,
					});
				});
			}
			case "one": {
				if (!resolver) throw new Error("natsu/pages: the model resolver was removed");
				used.push({ name: loader.name, kind: "one", from: loader.name });
				const result = await resolver.one(loader.name, {
					params: ctx.params,
					param: loader.param,
					value: ctx.params[loader.param] ?? "",
					fields: loader.fields,
					ctx,
				});
				if (result instanceof HttpError) throw result;
				if (result === null || result === undefined) throw new NotFound(`${loader.name} not found`);
				return result;
			}
			case "many": {
				if (!resolver) throw new Error("natsu/pages: the model resolver was removed");
				used.push({ name: loader.name, kind: "many", from: loader.name });
				const query = ctx.query;
				const page = Number.parseInt(query.page ?? "1", 10);
				const result = await resolver.many(loader.name, {
					query,
					sort: query.sort,
					page: Number.isFinite(page) && page > 0 ? page : 1,
					fields: loader.fields,
					ctx,
				});
				if (result instanceof HttpError) throw result;
				return result ?? [];
			}
			case "api": {
				used.push({ name: loader.name, kind: "api", from: loader.service });
				return guarded(loader, async () => {
					let path = "";
					for (const part of loader.path) {
						if (typeof part === "string") path += part;
						else {
							const v = walk(await get(part[0]!), part.slice(1));
							path += encodeURIComponent(v === null || v === undefined ? "" : String(v));
						}
					}
					return fetchService(scope.services[loader.service]!, loader.service, path, ctx);
				});
			}
		}
	};

	await Promise.all(plan.names.map(get));
	const values: Record<string, unknown> = {};
	for (const name of plan.names) values[name] = await memo.get(name);
	return { values, used };
}

/** A name a source `need`s that no template reads: found by the same rules, minus `<data>`. */
function lateLoader(name: string, scope: ResolveScope): Loader {
	if (REQUEST_NAMES.has(name)) return { t: "request", name };
	if (sources.has(name)) {
		const registered = sources.get(name)!;
		return { t: "source", name, source: name, args: {}, needs: registered.options.needs ?? [], required: registered.options.required === true, fields: ["*"] };
	}
	const model = modelKind(name, scope.path, scope.params);
	if (model?.kind === "one") return { t: "one", name, param: model.param, fields: ["*"] };
	if (model?.kind === "many") return { t: "many", name, fields: ["*"] };
	throw new Error(`natsu/pages: a source needs '${name}', and nothing provides it`);
}

function requestValue(name: string, scope: ResolveScope): unknown {
	const { ctx } = scope;
	const own = scope.request.get(name);
	if (own) return own();
	switch (name) {
		case "params":
			return ctx.params;
		case "query":
			return ctx.query;
		case "session":
			// The data, for templates; never creates a session by being read.
			return ctx.sessionLoaded ? ctx.session.data : null;
		default:
			return null;
	}
}

async function fetchService(service: ServiceConfig, name: string, path: string, ctx: Context): Promise<unknown> {
	const headers: Record<string, string> = { accept: "application/json", ...service.headers };
	const cookie = ctx.headers.get("cookie");
	// The visitor's cookie goes to configured services only, and only those that did not opt out.
	if (service.cookie !== false && cookie) headers.cookie = cookie;
	const url = service.base.replace(/\/+$/, "") + path;
	const response = await fetch(url, { headers, signal: AbortSignal.timeout(service.timeout ?? 5000), redirect: "manual" });
	if (response.status === 404) return undefined;
	if (response.status === 401 || response.status === 403) throw new Forbidden(`${name} refused ${path}`);
	if (!response.ok) throw new HttpError(502, `service ${name} answered ${response.status} for ${path}`);
	const type = response.headers.get("content-type") ?? "";
	return type.includes("json") ? response.json() : response.text();
}
