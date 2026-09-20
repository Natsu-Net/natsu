/**
 * The per-request object. Every field here is paid for on every request, so
 * anything that can be derived on demand is a getter with a memo behind it:
 * a request that never looks at the query string never allocates a `URL`.
 *
 * Shape is v1's (`ctx.request`, `ctx.response.body/status/headers`,
 * `ctx.params`, `ctx.query`, `ctx.session`, `ctx.cache`) so controllers port
 * across unchanged.
 */

import type { Server } from "bun";
import { Cache, defaultCache } from "./cache.ts";
import type { Session, SessionManager } from "./session/session.ts";

/**
 * `Bun.serve`'s Server type is generic over the data attached to websockets.
 * natsu's core opens none yet, so it is parameterised as `undefined` in one
 * place rather than spelled out at every use.
 */
export type NatsuServer = Server<undefined>;

export type ResponseBody = Response | BodyInit | Record<string, unknown> | unknown[] | number | boolean | null | undefined;

const EMPTY_PARAMS: Readonly<Record<string, string>> = Object.freeze({});

export interface CookieOptions {
	path?: string;
	domain?: string;
	maxAge?: number;
	expires?: Date;
	httpOnly?: boolean;
	secure?: boolean;
	sameSite?: "strict" | "lax" | "none";
}

/** Serialise one `Set-Cookie` value. Exported because the session store needs it. */
export function serializeCookie(name: string, value: string, options: CookieOptions = {}): string {
	const parts = [`${name}=${encodeURIComponent(value)}`];
	if (options.maxAge !== undefined) parts.push(`Max-Age=${Math.floor(options.maxAge)}`);
	if (options.domain) parts.push(`Domain=${options.domain}`);
	parts.push(`Path=${options.path ?? "/"}`);
	if (options.expires) parts.push(`Expires=${options.expires.toUTCString()}`);
	if (options.httpOnly !== false) parts.push("HttpOnly");
	if (options.secure) parts.push("Secure");
	parts.push(`SameSite=${capitalise(options.sameSite ?? "lax")}`);
	return parts.join("; ");
}

function capitalise(value: string): string {
	return value.charAt(0).toUpperCase() + value.slice(1);
}

/** Parse a `Cookie:` header. Malformed pairs are skipped, never thrown on. */
export function parseCookies(header: string | null): Map<string, string> {
	const out = new Map<string, string>();
	if (!header) return out;
	for (const pair of header.split(";")) {
		const eq = pair.indexOf("=");
		if (eq < 1) continue;
		const key = pair.slice(0, eq).trim();
		if (!key) continue;
		const raw = pair.slice(eq + 1).trim();
		try {
			out.set(key, decodeURIComponent(raw));
		} catch {
			// A cookie with a stray '%' is the client's problem, not a 500.
			out.set(key, raw);
		}
	}
	return out;
}

export class NatsuResponse {
	public body: ResponseBody = undefined;

	private _status: number | undefined;
	private _headers: Headers | undefined;

	/** Lazily created: most responses set a body and no headers at all. */
	public get headers(): Headers {
		return (this._headers ??= new Headers());
	}

	public get headersInitialized(): boolean {
		return this._headers !== undefined;
	}

	public get status(): number {
		// Nothing set at all is a 404, matching Oak — a handler that falls
		// through without touching the response has not answered the request.
		if (this._status !== undefined) return this._status;
		return this.body === undefined || this.body === null ? 404 : 200;
	}

	public set status(value: number) {
		this._status = value;
	}

	public get statusSet(): boolean {
		return this._status !== undefined;
	}

	public redirect(url: string, status = 302): void {
		this._status = status;
		this.headers.set("Location", url);
		this.body = "";
	}

	/** Shorthand for `headers.set("Content-Type", …)`. */
	public set type(value: string) {
		this.headers.set("Content-Type", value);
	}
}

export class Context {
	public readonly request: Request;
	public readonly server: NatsuServer | undefined;
	public readonly response = new NatsuResponse();
	public params: Record<string, string>;
	/** Per-request scratch space for middleware. */
	public readonly locals: Record<string, unknown> = {};
	public cache: Cache<unknown> = defaultCache;

	/** Set by the session middleware; `session` creates one on demand. */
	public sessions: SessionManager | undefined;
	public trustProxy = false;

	private _session: Session | undefined;
	private _url: URL | undefined;
	private _path: string | undefined;
	private _search: string | undefined;
	private _query: Record<string, string> | undefined;
	private _cookies: Map<string, string> | undefined;

	constructor(request: Request, server?: NatsuServer, params?: Record<string, string>) {
		this.request = request;
		this.server = server;
		this.params = params ?? (EMPTY_PARAMS as Record<string, string>);
	}

	public get method(): string {
		return this.request.method;
	}

	public get headers(): Headers {
		return this.request.headers;
	}

	/** Full `URL`, parsed once and only if something asks for it. */
	public get url(): URL {
		return (this._url ??= new URL(this.request.url));
	}

	/**
	 * Pathname without building a `URL`. Request URLs from Bun are absolute and
	 * already normalised, so scanning past the authority is enough — and it is
	 * roughly an order of magnitude cheaper than `new URL()` on the hot path.
	 */
	public get path(): string {
		if (this._path === undefined) this.splitUrl();
		return this._path!;
	}

	/** Query string including the leading `?`, or `""`. */
	public get search(): string {
		if (this._search === undefined) this.splitUrl();
		return this._search!;
	}

	private splitUrl(): void {
		const raw = this.request.url;
		const schemeEnd = raw.indexOf("://");
		const start = schemeEnd === -1 ? 0 : raw.indexOf("/", schemeEnd + 3);
		if (start === -1) {
			this._path = "/";
			this._search = "";
			return;
		}
		const query = raw.indexOf("?", start);
		const hash = raw.indexOf("#", start);
		const end = query === -1 ? (hash === -1 ? raw.length : hash) : query;
		this._path = raw.slice(start, end);
		this._search = query === -1 ? "" : raw.slice(query, hash === -1 ? raw.length : hash);
	}

	public get searchParams(): URLSearchParams {
		return this.url.searchParams;
	}

	/** Flat view of the query string; last value wins for repeated keys. */
	public get query(): Record<string, string> {
		if (this._query) return this._query;
		const query: Record<string, string> = {};
		const search = this.search;
		if (search.length > 1) {
			for (const [key, value] of new URLSearchParams(search)) query[key] = value;
		}
		return (this._query = query);
	}

	public get cookies(): Map<string, string> {
		return (this._cookies ??= parseCookies(this.request.headers.get("cookie")));
	}

	public setCookie(name: string, value: string, options?: CookieOptions): void {
		this.response.headers.append("Set-Cookie", serializeCookie(name, value, options));
	}

	public deleteCookie(name: string, options: CookieOptions = {}): void {
		this.setCookie(name, "", { ...options, maxAge: 0, expires: new Date(0) });
		this._cookies?.delete(name);
	}

	/**
	 * Client address. Behind a proxy the socket address is the proxy's, so the
	 * forwarded header wins — but only when the operator opted in, because
	 * anyone can send that header.
	 */
	public get ip(): string {
		if (this.trustProxy) {
			const forwarded = this.request.headers.get("x-forwarded-for");
			if (forwarded) {
				const first = forwarded.split(",")[0];
				if (first) return first.trim();
			}
		}
		return this.server?.requestIP(this.request)?.address ?? "";
	}

	public get host(): string {
		return this.request.headers.get("host") ?? "";
	}

	/**
	 * The session for this request. Created on first touch, so a request for a
	 * PNG never mints a row — v1 created one for every request that arrived.
	 */
	public get session(): Session {
		if (this._session) return this._session;
		if (!this.sessions) {
			throw new Error("natsu: ctx.session is unavailable — Session support is disabled in config");
		}
		this._session = this.sessions.create();
		this.sessions.attachCookie(this, this._session);
		return this._session;
	}

	public set session(session: Session) {
		this._session = session;
	}

	/** Whether a session was loaded or created — used to skip cookie work. */
	public get sessionLoaded(): boolean {
		return this._session !== undefined;
	}

	/** Build the outgoing `Response`. Called once, by the server. */
	public toResponse(): Response {
		const { response } = this;
		const body = response.body;

		// A handler that builds its own Response owns it completely; we only
		// graft on cookies and friends that middleware may have queued.
		if (body instanceof Response) {
			if (response.headersInitialized) {
				for (const [key, value] of response.headers) {
					if (key === "set-cookie") body.headers.append(key, value);
					else if (!body.headers.has(key)) body.headers.set(key, value);
				}
			}
			return body;
		}

		const status = response.status;
		const headers = response.headersInitialized ? response.headers : undefined;

		if (body === undefined || body === null) {
			return new Response(null, { status, headers });
		}

		if (typeof body === "string") {
			if (!headers?.has("Content-Type")) {
				// v1 leaned on Oak's sniffing; controllers return bare HTML
				// strings and expect a browser to render them.
				const type = body.startsWith("<") ? "text/html; charset=utf-8" : "text/plain; charset=utf-8";
				(headers ?? response.headers).set("Content-Type", type);
			}
			return new Response(body, { status, headers: response.headers });
		}

		if (
			body instanceof Blob ||
			body instanceof ArrayBuffer ||
			ArrayBuffer.isView(body) ||
			body instanceof ReadableStream ||
			body instanceof FormData ||
			body instanceof URLSearchParams
		) {
			// Bun.file() lands here and is handed straight to the kernel.
			return new Response(body as BodyInit, { status, headers });
		}

		const json = JSON.stringify(body);
		const out = headers ?? response.headers;
		if (!out.has("Content-Type")) out.set("Content-Type", "application/json; charset=utf-8");
		return new Response(json, { status, headers: out });
	}
}

export type Middleware = (ctx: Context, next: () => Promise<void>) => void | Promise<void>;
export type Handler = (ctx: Context) => unknown | Promise<unknown>;
