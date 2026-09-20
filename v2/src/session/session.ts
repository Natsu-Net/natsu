/**
 * Sessions.
 *
 * The instance API is v1's (`Set`/`Get`/`delete`/`Save`/`Renew`/`IsExpired`),
 * because controllers call it directly. What changed is underneath:
 *
 *   - one live instance per id, so two in-flight requests carrying the same
 *     cookie mutate the same object instead of racing two copies (v1 loaded a
 *     second copy from the database and the later write won outright);
 *   - a save that arrives while one is in flight is queued, not dropped — v1's
 *     `if (this.saving) return` silently lost writes;
 *   - persistence happens once, after the response is built, instead of on
 *     every `Set`.
 */

import type { Context, Middleware } from "../context.ts";
import type { NatsuConfig, SessionCookieConfig } from "../config.ts";
import { log } from "../logger.ts";
import { MemoryAdapter, type SessionAdapter, type SessionRecord } from "./adapter.ts";
import { SqliteAdapter } from "./sqlite.ts";

export class Session {
	public readonly id: string;
	/** Unix seconds the session was created. */
	public readonly date: number;
	public expire: number;
	public data: Record<string, unknown>;

	/** Set by any mutation; cleared once the store has the current value. */
	public dirty = false;

	private manager: SessionManager | undefined;
	private saving: Promise<void> | undefined;
	private queued = false;

	constructor(id: string, expire: number, data: Record<string, unknown> = {}, manager?: SessionManager) {
		this.id = id;
		this.date = Math.floor(Date.now() / 1000);
		this.expire = expire;
		this.data = data;
		this.manager = manager;
	}

	/** Write without scheduling a save — for values that live and die with the request. */
	public iSet(key: string, value: unknown): void {
		this.data[key] = value;
	}

	public Set(key: string, value: unknown): void {
		this.data[key] = value;
		this.dirty = true;
	}

	/** v1 returns `false`, not `undefined`, for an absent key. Kept as-is. */
	public Get<T = unknown>(key: string): T | false {
		const value = this.data[key];
		return value === undefined ? false : (value as T);
	}

	public Has(key: string): boolean {
		return this.data[key] !== undefined;
	}

	public delete(key: string): void {
		delete this.data[key];
		this.dirty = true;
	}

	public clear(): void {
		this.data = {};
		this.dirty = true;
	}

	public SetExpires(seconds: number): number {
		this.expire = Math.floor(Date.now() / 1000) + seconds;
		this.dirty = true;
		return this.expire;
	}

	public Renew(ttl?: number): void {
		this.SetExpires(ttl ?? this.manager?.ttl ?? 60 * 60 * 24 * 7);
	}

	public IsExpired(now: number = Date.now() / 1000): boolean {
		return this.expire <= now;
	}

	public toRecord(): SessionRecord {
		return { id: this.id, data: this.data, expires: this.expire };
	}

	/**
	 * Persist now. Concurrent callers coalesce: at most one write is in flight
	 * and at most one more is queued, and the queued one sees the newest data
	 * because it re-reads `this.data` when it runs.
	 */
	public async Save(): Promise<void> {
		const manager = this.manager;
		if (!manager) return;
		if (this.saving) {
			if (this.queued) return this.saving;
			this.queued = true;
			const previous = this.saving;
			this.saving = (async () => {
				await previous.catch(() => undefined);
				this.queued = false;
				await manager.adapter.save(this.toRecord());
				this.dirty = false;
			})();
			return this.saving;
		}

		this.saving = (async () => {
			await manager.adapter.save(this.toRecord());
			this.dirty = false;
		})();
		try {
			await this.saving;
		} finally {
			if (!this.queued) this.saving = undefined;
		}
	}

	/** @internal */
	public bind(manager: SessionManager): void {
		this.manager = manager;
	}
}

export interface SessionManagerOptions {
	adapter?: SessionAdapter;
	/** Lifetime in seconds. */
	ttl?: number;
	cookieName?: string;
	cookie?: Partial<SessionCookieConfig>;
	/** Push expiry forward on every request that loads the session. */
	rolling?: boolean;
	/** Seconds between expiry sweeps; 0 disables. */
	sweepInterval?: number;
}

/** Hooks that run right after a session is attached to a request (v1's session middleware registry). */
export type SessionHook = (ctx: Context) => void | Promise<void>;

export class SessionManager {
	public readonly adapter: SessionAdapter;
	public readonly ttl: number;
	public readonly cookieName: string;
	public readonly cookie: SessionCookieConfig;
	public readonly rolling: boolean;

	/** id -> live instance. The identity map is what makes concurrent requests safe. */
	private readonly live = new Map<string, Session>();
	private readonly hooks = new Map<string, SessionHook>();
	private timer: ReturnType<typeof setInterval> | undefined;

	constructor(options: SessionManagerOptions = {}) {
		this.adapter = options.adapter ?? new MemoryAdapter();
		this.ttl = options.ttl ?? 60 * 60 * 24 * 7;
		this.cookieName = options.cookieName ?? "NATSU_SESSION";
		this.cookie = {
			path: options.cookie?.path ?? "/",
			sameSite: options.cookie?.sameSite ?? "lax",
			secure: options.cookie?.secure ?? false,
			httpOnly: options.cookie?.httpOnly ?? true,
			...(options.cookie?.domain ? { domain: options.cookie.domain } : {}),
		};
		this.rolling = options.rolling ?? true;

		const interval = options.sweepInterval ?? 300;
		if (interval > 0) {
			this.timer = setInterval(() => {
				void this.sweep();
			}, interval * 1000);
			// A background sweep must never be the reason a process stays up.
			this.timer.unref?.();
		}
	}

	static fromConfig(config: NatsuConfig): SessionManager {
		const adapter: SessionAdapter =
			config.Session.driver === "sqlite" ? new SqliteAdapter({ path: config.Session.path }) : new MemoryAdapter();
		return new SessionManager({
			adapter,
			ttl: config.Session.ttl,
			cookieName: config.Session.CookieName,
			cookie: config.Session.cookie,
			sweepInterval: config.Session.sweepInterval,
		});
	}

	public create(): Session {
		const session = new Session(crypto.randomUUID(), Math.floor(Date.now() / 1000) + this.ttl, {}, this);
		session.dirty = true;
		this.live.set(session.id, session);
		return session;
	}

	/**
	 * Fetch a session by id, from memory first. Returns undefined for an id
	 * that is unknown or expired — never a half-initialised session.
	 */
	public async get(id: string): Promise<Session | undefined> {
		const live = this.live.get(id);
		if (live) {
			if (!live.IsExpired()) return live;
			await this.destroy(id);
			return undefined;
		}

		const record = await this.adapter.load(id);
		if (!record) return undefined;

		// Another request may have loaded the same id while this await was
		// pending; the first instance to land wins so both requests share one.
		const raced = this.live.get(id);
		if (raced) return raced;

		const session = new Session(record.id, record.expires, record.data, this);
		if (session.IsExpired()) {
			await this.destroy(id);
			return undefined;
		}
		this.live.set(id, session);
		return session;
	}

	public async destroy(id: string): Promise<void> {
		this.live.delete(id);
		await this.adapter.destroy(id);
	}

	/** Write the session out if anything changed. */
	public async persist(session: Session): Promise<void> {
		if (!session.dirty) return;
		await session.Save();
	}

	public async sweep(now: number = Date.now() / 1000): Promise<number> {
		for (const [id, session] of this.live) {
			if (session.IsExpired(now)) this.live.delete(id);
		}
		const removed = await this.adapter.sweep(now);
		if (removed > 0) log.debug(`[<yellow>SESSION</yellow>] swept <cyan>${removed}</cyan> expired`);
		return removed;
	}

	/** Attach the session cookie to the response. */
	public attachCookie(ctx: Context, session: Session): void {
		ctx.setCookie(this.cookieName, session.id, {
			...this.cookie,
			maxAge: Math.max(0, Math.floor(session.expire - Date.now() / 1000)),
		});
	}

	/** v1's `SessionRegisterMiddleware`: runs after the session is attached. */
	public registerMiddleware(name: string, hook: SessionHook): void {
		this.hooks.set(name, hook);
	}

	public getAllMiddleware(): ReadonlyMap<string, SessionHook> {
		return this.hooks;
	}

	public liveCount(): number {
		return this.live.size;
	}

	/** Forget in-memory instances without touching the store. */
	public evict(id?: string): void {
		if (id) this.live.delete(id);
		else this.live.clear();
	}

	public async close(): Promise<void> {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		this.live.clear();
		await this.adapter.close();
	}
}

/**
 * Load the session named by the cookie, and hand the request the means to mint
 * one if it asks. A request that never touches `ctx.session` costs one cookie
 * lookup and nothing else — v1 created and stored a session for every request
 * that arrived, including every image.
 */
export function sessionMiddleware(manager: SessionManager): Middleware {
	const { cookieName } = manager;
	return async (ctx, next) => {
		ctx.sessions = manager;
		const id = ctx.cookies.get(cookieName);
		if (id) {
			const session = await manager.get(id);
			if (session) {
				ctx.session = session;
				if (manager.rolling) {
					session.Renew();
					manager.attachCookie(ctx, session);
				}
				for (const hook of manager.getAllMiddleware().values()) await hook(ctx);
			}
		}

		await next();

		// Persist after the handler, so N writes in one request are one write
		// to the store.
		if (ctx.sessionLoaded) await manager.persist(ctx.session);
	};
}
