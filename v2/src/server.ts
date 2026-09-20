/**
 * The application: `Bun.serve` plus a middleware chain.
 *
 * Route *matching* is Bun's — the compiled router hands `Bun.serve` a `routes`
 * object, so `/users/:id` is resolved natively before any JavaScript runs. What
 * this file owns is everything around the handler: the middleware chain, the
 * context, error handling, and start/stop/restart.
 */

import type { BunRequest, ServeOptions } from "bun";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { Context, type Handler, type Middleware, type NatsuServer, type ResponseBody } from "./context.ts";
import { config as globalConfig, type NatsuConfig } from "./config.ts";
import { CLog, formatLine, log, setLogLevel } from "./logger.ts";
import { Router, type RouteEntry } from "./router.ts";
import { SessionManager, sessionMiddleware } from "./session/session.ts";
import { StaticFiles } from "./static.ts";

export type ErrorHandler = (error: Error, ctx: Context) => void | Promise<void>;

export interface ApplicationOptions {
	config?: NatsuConfig;
	/** Document root override; defaults to the config's. */
	cwd?: string;
	/** Pass a manager to share one store between apps, or false to disable. */
	sessions?: SessionManager | false;
}

export interface StartOptions {
	port?: number;
	hostname?: string;
	development?: boolean;
	/** Bind the same port from several processes. */
	reusePort?: boolean;
	/** Suppress the boot banner. */
	quiet?: boolean;
}

type Terminal = (ctx: Context) => Promise<void>;

export class Application {
	public readonly config: NatsuConfig;
	public sessions: SessionManager | undefined;
	public statics: StaticFiles | undefined;

	private readonly userMiddleware: Middleware[] = [];
	private chain: ((ctx: Context, terminal: Terminal) => Promise<void>) | undefined;
	private serverRef: NatsuServer | undefined;
	private errorHandler: ErrorHandler | undefined;
	private readonly cwd: string;

	constructor(options: ApplicationOptions = {}) {
		this.config = options.config ?? globalConfig;
		this.cwd = options.cwd ?? process.cwd();
		setLogLevel(this.config.General.logLevel);

		if (options.sessions instanceof SessionManager) this.sessions = options.sessions;
		else if (options.sessions !== false && this.config.Session.enabled && this.config.Session.driver !== "none") {
			this.sessions = SessionManager.fromConfig(this.config);
		}

		if (this.config.Static.enabled) this.statics = StaticFiles.fromConfig(this.config, this.cwd);
	}

	public get server(): NatsuServer | undefined {
		return this.serverRef;
	}

	public get running(): boolean {
		return this.serverRef !== undefined;
	}

	/** Append application middleware. Runs after the built-ins, in call order. */
	public use(middleware: Middleware): this {
		this.userMiddleware.push(middleware);
		this.chain = undefined;
		return this;
	}

	public onError(handler: ErrorHandler): this {
		this.errorHandler = handler;
		return this;
	}

	// --- request path ------------------------------------------------------

	/**
	 * Run the whole pipeline for one request, without binding a socket.
	 *
	 * Pattern matching belongs to `Bun.serve`, so this looks the path up
	 * literally: `/u/:id` is found, `/u/7` is not. Pass `params` for what the
	 * pattern would have captured.
	 */
	public async handle(request: Request, server?: NatsuServer, params?: Record<string, string>): Promise<Response> {
		return this.run(request, server, this.terminalFor(this.lookup(request)), params);
	}

	private lookup(request: Request): RouteEntry | undefined {
		const { entries } = Router.routes();
		const url = request.url;
		const schemeEnd = url.indexOf("://");
		const start = schemeEnd === -1 ? 0 : url.indexOf("/", schemeEnd + 3);
		if (start === -1) return entries.get("/");
		const query = url.indexOf("?", start);
		const hash = url.indexOf("#", start);
		const end = query === -1 ? (hash === -1 ? url.length : hash) : query;
		return entries.get(url.slice(start, end));
	}

	/**
	 * Build the terminal for a route, once per route rather than per request.
	 *
	 * The try/catch sits *inside* the chain on purpose: a handler that throws
	 * must still come back through the middleware as an ordinary response, so
	 * the access log records the 500 and the session is still written out.
	 * Middleware that throws is caught further out, in `run`.
	 */
	private terminalFor(entry: RouteEntry | undefined): Terminal {
		const inner: Terminal = entry ? (ctx) => this.routeTerminal(ctx, entry) : (ctx) => this.fallbackTerminal(ctx);
		return async (ctx: Context) => {
			try {
				await inner(ctx);
			} catch (error) {
				await this.handleError(error, ctx);
			}
		};
	}

	private async run(
		request: Request,
		server: NatsuServer | undefined,
		terminal: Terminal,
		params?: Record<string, string>,
	): Promise<Response> {
		const ctx = new Context(request, server, params);
		ctx.trustProxy = this.config.General.proxy;

		try {
			this.chain ??= compose([...this.builtins(), ...this.userMiddleware]);
			await this.chain(ctx, terminal);
		} catch (error) {
			await this.handleError(error, ctx);
		}

		return ctx.toResponse();
	}

	private async routeTerminal(ctx: Context, entry: RouteEntry): Promise<void> {
		// v1 served `public/` ahead of the router; apps that relied on a file
		// shadowing a route can turn that back on.
		if (this.config.Static.beforeRoutes && this.statics && (await this.statics.serve(ctx))) return;

		const handler = entry.select(ctx.method, ctx.host);
		if (!handler) {
			const known =
				entry.catchAll || entry.allow.includes(ctx.method) || (ctx.method === "HEAD" && entry.allow.includes("GET"));
			// The path exists but not for this method: that is a 405, and the
			// Allow header is required with it. A *host* mismatch is not —
			// as far as this host is concerned the path does not exist.
			if (!known) {
				ctx.response.status = 405;
				ctx.response.headers.set("Allow", entry.allow.filter((m) => m !== "*").join(", "));
				ctx.response.body = "Method Not Allowed";
				return;
			}
			return this.fallbackTerminal(ctx);
		}

		await this.invoke(handler, ctx);

		// A guard that refused, or a handler that wrote nothing, still owes the
		// client an answer.
		if (ctx.response.body === undefined && !ctx.response.statusSet) {
			ctx.response.status = 404;
			ctx.response.body = "Not Found";
		}
	}

	private async invoke(handler: Handler, ctx: Context): Promise<void> {
		const result = await handler(ctx);
		// Returning a value is an alternative to assigning `ctx.response.body`;
		// an explicit assignment always wins.
		if (result !== undefined && ctx.response.body === undefined) ctx.response.body = result as ResponseBody;
	}

	private async fallbackTerminal(ctx: Context): Promise<void> {
		if (this.statics && !this.config.Static.beforeRoutes && (await this.statics.serve(ctx))) return;
		if (ctx.response.body === undefined && !ctx.response.statusSet) {
			ctx.response.status = 404;
			ctx.response.body = "Not Found";
		}
	}

	private async handleError(error: unknown, ctx: Context): Promise<void> {
		const err = error instanceof Error ? error : new Error(String(error));
		if (this.errorHandler) {
			await this.errorHandler(err, ctx);
			if (ctx.response.body !== undefined || ctx.response.statusSet) return;
		}
		log.error(`${ctx.method} ${ctx.path} <red>${err.message}</red>\n${err.stack ?? ""}`);
		ctx.response.status = 500;
		ctx.response.body = this.config.General.development
			? `500 Internal Server Error\n\n${err.stack ?? err.message}`
			: "Internal Server Error";
	}

	// --- built-in middleware ----------------------------------------------

	private builtins(): Middleware[] {
		const middleware: Middleware[] = [];
		if (this.config.General.logFormat) middleware.push(this.requestLogger());
		if (this.sessions) middleware.push(sessionMiddleware(this.sessions));
		return middleware;
	}

	private requestLogger(): Middleware {
		const format = this.config.General.logFormat;
		const ignore = this.config.General.logIgnore;
		return async (ctx, next) => {
			const path = ctx.path;
			for (const prefix of ignore) {
				if (path === prefix || path.startsWith(prefix)) return next();
			}
			// nanoseconds() is monotonic; Date.now() can step backwards and
			// report a negative duration.
			const started = Bun.nanoseconds();
			await next();
			const ms = (Bun.nanoseconds() - started) / 1e6;
			const colour = ms > 1000 ? "red" : ms > 500 ? "yellow" : "green";
			CLog(
				formatLine(format, {
					method: ctx.method,
					path,
					status: ctx.response.status,
					ms: ms.toFixed(2),
					color: colour,
					ip: ctx.ip,
					host: ctx.host,
				}),
			);
		};
	}

	// --- lifecycle ---------------------------------------------------------

	/** Compile the route table into the shape `Bun.serve` wants. */
	public buildRoutes(): Record<string, (request: BunRequest, server: NatsuServer) => Promise<Response>> {
		const routes: Record<string, (request: BunRequest, server: NatsuServer) => Promise<Response>> = {};
		for (const [path, entry] of Router.routes().entries) {
			const terminal = this.terminalFor(entry);
			routes[path] = (request, server) => this.run(request, server, terminal, request.params as Record<string, string>);
		}
		return routes;
	}

	private serveOptions(options: StartOptions): ServeOptions {
		return {
			port: options.port ?? this.config.General.port,
			hostname: options.hostname ?? this.config.General.listenOn,
			development: options.development ?? this.config.General.development,
			reusePort: options.reusePort ?? false,
			routes: this.buildRoutes(),
			fetch: ((terminal: Terminal) => (request: Request, server: NatsuServer) => this.run(request, server, terminal))(
				this.terminalFor(undefined),
			),
			error: (error: Error) => {
				// Only reached if the pipeline itself failed to produce a
				// Response, which means something is wrong with natsu.
				log.error(`<red>unhandled</red> ${error.stack ?? error.message}`);
				return new Response("Internal Server Error", { status: 500 });
			},
		} as ServeOptions;
	}

	/** Bind and start serving. Starting an already-running app reloads it instead. */
	public async start(options: StartOptions = {}): Promise<NatsuServer> {
		if (this.serverRef) return this.reload(options);

		this.chain = compose([...this.builtins(), ...this.userMiddleware]);
		this.serverRef = Bun.serve(this.serveOptions(options));

		if (!options.quiet) {
			CLog(`[<green>natsu</green>] listening on <cyan>${this.serverRef.url.href}</cyan>`);
			CLog(`[<green>natsu</green>] public url <cyan>${this.config.General.url}</cyan>`);
			CLog(`[<green>natsu</green>] <yellow>${Router.records().length}</yellow> routes registered`);
		}
		return this.serverRef;
	}

	/**
	 * Swap in the current route table without dropping connections — this is
	 * what makes `restart()` graceful.
	 */
	public reload(options: StartOptions = {}): NatsuServer {
		if (!this.serverRef) throw new Error("natsu: reload() before start()");
		this.chain = compose([...this.builtins(), ...this.userMiddleware]);
		this.serverRef.reload(this.serveOptions(options));
		return this.serverRef;
	}

	/**
	 * Stop serving. By default in-flight requests are allowed to finish; pass
	 * true to cut active connections immediately.
	 */
	public async stop(force = false): Promise<void> {
		if (!this.serverRef) return;
		const server = this.serverRef;
		this.serverRef = undefined;
		await server.stop(force);
	}

	public async restart(options: StartOptions = {}): Promise<NatsuServer> {
		if (this.serverRef) return this.reload(options);
		return this.start(options);
	}

	/** Stop and release the session store. The app is not restartable after this. */
	public async close(force = false): Promise<void> {
		await this.stop(force);
		await this.sessions?.close();
		this.sessions = undefined;
	}
}

/**
 * koa-style composition. One closure per middleware per request is the price of
 * the `(ctx, next)` signature; the double-`next()` guard is worth the branch,
 * because that bug otherwise surfaces as a response that is silently wrong.
 */
export function compose(middleware: readonly Middleware[]): (ctx: Context, terminal: Terminal) => Promise<void> {
	return function run(ctx: Context, terminal: Terminal): Promise<void> {
		let last = -1;
		const dispatch = async (index: number): Promise<void> => {
			if (index <= last) throw new Error("natsu: next() called more than once in one middleware");
			last = index;
			if (index === middleware.length) return terminal(ctx);
			const fn = middleware[index];
			if (!fn) return;
			await fn(ctx, () => dispatch(index + 1));
		};
		return dispatch(0);
	};
}

/**
 * Import every `.ts`/`.js` file under a directory, deepest last, so route and
 * controller files register themselves by being loaded — v1's convention.
 */
export async function loadDirectory(dir: string): Promise<string[]> {
	const loaded: string[] = [];

	const walk = async (current: string): Promise<void> => {
		let entries;
		try {
			entries = readdirSync(current, { withFileTypes: true });
		} catch {
			return; // A missing routes/ or controller/ directory is not an error.
		}
		for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
			const full = join(current, entry.name);
			if (entry.isDirectory()) await walk(full);
			else if (/\.(ts|js|mjs)$/.test(entry.name)) {
				await import(full);
				loaded.push(full);
			}
		}
	};

	await walk(dir);
	return loaded;
}

/**
 * The process-wide application behind the v1-compatible `start`/`stop`/`restart`.
 *
 * Built on first use, not at import: constructing an Application opens the
 * session store, and importing a module should not create files.
 */
let defaultApp: Application | undefined;

export function getApp(options?: ApplicationOptions): Application {
	return (defaultApp ??= new Application(options));
}

/** Drop the default application (after closing it). Tests need this. */
export async function resetApp(): Promise<void> {
	await defaultApp?.close(true);
	defaultApp = undefined;
}

export const start = (options: StartOptions = {}): Promise<NatsuServer> => getApp().start(options);
export const stop = (force = false): Promise<void> => getApp().stop(force);
export const restart = (options: StartOptions = {}): Promise<NatsuServer> => getApp().restart(options);
