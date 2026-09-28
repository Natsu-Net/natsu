/**
 * The storage contract behind sessions.
 *
 * v1 hard-coded denodb + MySQL and fell back to a `Map` when that was not
 * configured, so "where do sessions live" was answered in four places at once.
 * Here it is one interface with two shipped implementations; MySQL/Postgres via
 * `Bun.SQL` is another file, not another branch in this one.
 *
 * Methods may answer synchronously — sqlite does, and a synchronous answer
 * costs no promise — so every return type is `MaybePromise`.
 */

export type MaybePromise<T> = T | Promise<T>;

export interface SessionRecord {
	id: string;
	data: Record<string, unknown>;
	/** Unix seconds. */
	expires: number;
}

export interface SessionAdapter {
	readonly name: string;
	load(id: string): MaybePromise<SessionRecord | undefined>;
	save(record: SessionRecord): MaybePromise<void>;
	destroy(id: string): MaybePromise<void>;
	/** Delete everything already expired at `now`; returns how many went. */
	sweep(now?: number): MaybePromise<number>;
	size(): MaybePromise<number>;
	clear(): MaybePromise<void>;
	close(): MaybePromise<void>;
}

/** Snapshot on the way in and out, so a store round trip behaves like a real one. */
function snapshot(data: Record<string, unknown>): Record<string, unknown> {
	return structuredClone(data);
}

export class MemoryAdapter implements SessionAdapter {
	public readonly name = "memory";

	private readonly rows = new Map<string, SessionRecord>();

	public load(id: string): SessionRecord | undefined {
		const row = this.rows.get(id);
		if (!row) return undefined;
		// An expired row is gone as far as callers are concerned, whether or
		// not the sweep has reached it yet.
		if (row.expires <= Date.now() / 1000) {
			this.rows.delete(id);
			return undefined;
		}
		return { id: row.id, data: snapshot(row.data), expires: row.expires };
	}

	public save(record: SessionRecord): void {
		this.rows.set(record.id, { id: record.id, data: snapshot(record.data), expires: record.expires });
	}

	public destroy(id: string): void {
		this.rows.delete(id);
	}

	public sweep(now: number = Date.now() / 1000): number {
		let removed = 0;
		for (const [id, row] of this.rows) {
			if (row.expires <= now) {
				this.rows.delete(id);
				removed++;
			}
		}
		return removed;
	}

	public size(): number {
		return this.rows.size;
	}

	public clear(): void {
		this.rows.clear();
	}

	public close(): void {
		this.rows.clear();
	}
}
