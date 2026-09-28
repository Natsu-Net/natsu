/**
 * The TTL map behind `ctx.cache`, ported from v1.
 *
 * Two changes from the Deno version: it is generic instead of a union of every
 * type anyone ever stored, and the sweep timer is unref'd so holding a cache
 * never keeps the process alive (v1's `setInterval` pinned the event loop,
 * which is why its tests could not exit).
 */

interface CacheItem<T> {
	data: T;
	/** Unix seconds. */
	expire: number;
}

export class Cache<T = unknown> {
	private readonly items = new Map<string, CacheItem<T>>();
	private readonly ttl: number;
	private timer: ReturnType<typeof setInterval> | undefined;

	constructor(ttl = 900, autoclear = true, sweepMs = 1000) {
		this.ttl = ttl;
		if (autoclear) {
			this.timer = setInterval(() => this.RemoveExpired(), sweepMs);
			this.timer.unref?.();
		}
	}

	public get(key: string): T | false {
		const item = this.items.get(key);
		if (!item) return false;
		if (item.expire > Date.now() / 1000) return item.data;
		this.items.delete(key);
		return false;
	}

	public set(key: string, data: T, expire: number = this.ttl): void {
		this.items.set(key, { data, expire: Date.now() / 1000 + expire });
	}

	/** True only for a live entry — an expired key answers false, as v1 did not. */
	public has(key: string): boolean {
		return this.get(key) !== false;
	}

	public Remove(key: string): boolean {
		return this.items.delete(key);
	}

	public clear(): void {
		this.items.clear();
	}

	/** Number of entries held, expired ones included. */
	public getSize(): number {
		return this.items.size;
	}

	public getOrSet(key: string, produce: () => T, expire: number = this.ttl): T {
		const hit = this.get(key);
		if (hit !== false) return hit;
		const fresh = produce();
		this.set(key, fresh, expire);
		return fresh;
	}

	public RemoveExpired(): number {
		const now = Date.now() / 1000;
		let removed = 0;
		for (const [key, item] of this.items) {
			if (item.expire <= now) {
				this.items.delete(key);
				removed++;
			}
		}
		return removed;
	}

	/** Drop the sweep timer. Only matters for caches created per test. */
	public close(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}
}

export const defaultCache = new Cache();
