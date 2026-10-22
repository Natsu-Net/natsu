import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Session } from "../src/session/session.ts";
import { SqliteAdapter } from "../src/session/sqlite.ts";
import { tempDir } from "./helpers.ts";

const dirs: { cleanup: () => void }[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) dir.cleanup();
});

const mode = (path: string) => statSync(path).mode & 0o777;
const record = { id: "x", data: { a: 1 }, expires: Date.now() / 1000 + 100 };

describe("the sqlite session file", () => {
	test("is private to the owner, with the directory made for it and the WAL files beside it", () => {
		const dir = tempDir("natsu-sqlite-");
		dirs.push(dir);
		const path = join(dir.path, "made", "sessions.sqlite");
		const adapter = new SqliteAdapter({ path });
		adapter.save(record);
		expect(mode(join(dir.path, "made"))).toBe(0o700);
		expect(mode(path)).toBe(0o600);
		expect(mode(`${path}-wal`) & 0o077).toBe(0);
		expect(mode(`${path}-shm`) & 0o077).toBe(0);
		adapter.close();
	});

	test("a file that was readable by others is closed to them", () => {
		const dir = tempDir("natsu-sqlite-");
		dirs.push(dir);
		const path = join(dir.path, "sessions.sqlite");
		mkdirSync(dir.path, { recursive: true });
		writeFileSync(path, "");
		chmodSync(path, 0o644);
		const adapter = new SqliteAdapter({ path });
		adapter.save(record);
		expect(mode(path)).toBe(0o600);
		expect(adapter.load("x")?.data).toEqual({ a: 1 });
		adapter.close();
	});
});

describe("session data keys", () => {
	test("only a key the session holds is found; inherited names are not", () => {
		const session = new Session("i", Date.now() / 1000 + 100, JSON.parse('{"a":1,"__proto__":{"admin":true}}'));
		expect(session.Get("a")).toBe(1);
		for (const name of ["constructor", "toString", "hasOwnProperty", "valueOf"]) {
			expect(session.Get(name)).toBe(false);
			expect(session.Has(name)).toBe(false);
		}
		expect(({} as Record<string, unknown>).admin).toBeUndefined();
	});
});
