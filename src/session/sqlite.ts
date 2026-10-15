/**
 * The default session store: `bun:sqlite`.
 *
 * Chosen because it needs no service to be running — `bun run dev` on a clean
 * machine has working sessions. Every statement is prepared once; the driver is
 * synchronous, so a session read is a function call rather than a round trip.
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { SessionAdapter, SessionRecord } from "./adapter.ts";

interface Row {
	id: string;
	data: string;
	expires: number;
}

export interface SqliteAdapterOptions {
	/** File path, or `:memory:`. */
	path?: string;
	table?: string;
	/** WAL trades a second file for readers that never block on the writer. */
	wal?: boolean;
}

export class SqliteAdapter implements SessionAdapter {
	public readonly name = "sqlite";
	public readonly db: Database;

	private readonly selectStmt;
	private readonly upsertStmt;
	private readonly deleteStmt;
	private readonly sweepStmt;
	private readonly countStmt;
	private readonly clearStmt;

	constructor(options: SqliteAdapterOptions = {}) {
		const path = options.path ?? ":memory:";
		const table = options.table ?? "sessions";
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) {
			// The table name cannot be a bound parameter, so it is validated
			// rather than interpolated blind.
			throw new Error(`natsu/session: invalid table name ${JSON.stringify(table)}`);
		}

		if (path !== ":memory:") mkdirSync(dirname(resolve(path)), { recursive: true });

		this.db = new Database(path, { create: true });
		if (options.wal !== false && path !== ":memory:") this.db.exec("PRAGMA journal_mode = WAL");
		this.db.exec("PRAGMA synchronous = NORMAL");
		this.db.exec(
			`CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, data TEXT NOT NULL, expires INTEGER NOT NULL)`,
		);
		this.db.exec(`CREATE INDEX IF NOT EXISTS ${table}_expires ON ${table} (expires)`);

		this.selectStmt = this.db.query<Row, [string]>(`SELECT id, data, expires FROM ${table} WHERE id = ?`);
		this.upsertStmt = this.db.query<undefined, [string, string, number]>(
			`INSERT INTO ${table} (id, data, expires) VALUES (?, ?, ?)
			 ON CONFLICT(id) DO UPDATE SET data = excluded.data, expires = excluded.expires`,
		);
		this.deleteStmt = this.db.query<undefined, [string]>(`DELETE FROM ${table} WHERE id = ?`);
		this.sweepStmt = this.db.query<undefined, [number]>(`DELETE FROM ${table} WHERE expires <= ?`);
		this.countStmt = this.db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`);
		this.clearStmt = this.db.query<undefined, []>(`DELETE FROM ${table}`);
	}

	public load(id: string): SessionRecord | undefined {
		const row = this.selectStmt.get(id);
		if (!row) return undefined;
		if (row.expires <= Date.now() / 1000) {
			this.deleteStmt.run(id);
			return undefined;
		}
		let data: Record<string, unknown>;
		try {
			data = JSON.parse(row.data) as Record<string, unknown>;
		} catch {
			// A corrupt row is worse than a missing one: drop it and let the
			// caller mint a fresh session instead of throwing mid-request.
			this.deleteStmt.run(id);
			return undefined;
		}
		return { id: row.id, data, expires: row.expires };
	}

	public save(record: SessionRecord): void {
		this.upsertStmt.run(record.id, JSON.stringify(record.data), Math.floor(record.expires));
	}

	public destroy(id: string): void {
		this.deleteStmt.run(id);
	}

	public sweep(now: number = Date.now() / 1000): number {
		this.sweepStmt.run(Math.floor(now));
		return this.db.query<{ n: number }, []>("SELECT changes() AS n").get()?.n ?? 0;
	}

	public size(): number {
		return this.countStmt.get()?.n ?? 0;
	}

	public clear(): void {
		this.clearStmt.run();
	}

	public close(): void {
		this.db.close(false);
	}
}
