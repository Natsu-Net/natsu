import { describe, expect, test } from "bun:test";
import { SessionManager } from "../src/session/session.ts";

const manager = (max: number) => new SessionManager({ sweepInterval: 0, maxAnonymousPerIp: max, anonymousTtl: 60, ttl: 3600 });

describe("anonymous sessions per address", () => {
	test("past the cap the oldest session without data goes", async () => {
		const sessions = manager(3);
		const made = Array.from({ length: 6 }, () => sessions.create("203.0.113.9"));
		await Bun.sleep(5);
		expect(sessions.liveCount()).toBe(3);
		expect(made.slice(0, 3).every((session) => session.destroyed)).toBe(true);
		expect(made.slice(3).every((session) => !session.destroyed)).toBe(true);
		expect(await sessions.adapter.load(made[0]!.id)).toBeUndefined();
	});

	test("a session that gained data stops counting", async () => {
		const sessions = manager(2);
		const keeper = sessions.create("203.0.113.9");
		keeper.Set("user", "ann");
		for (let i = 0; i < 5; i++) sessions.create("203.0.113.9");
		await Bun.sleep(5);
		expect(keeper.destroyed).toBe(false);
		expect(sessions.liveCount()).toBe(3);
	});

	test("addresses are counted apart, and an IPv6 /64 is one address", async () => {
		const sessions = manager(2);
		for (let i = 0; i < 4; i++) sessions.create(`2001:db8:1:2:${i}::1`);
		for (let i = 0; i < 2; i++) sessions.create("198.51.100.1");
		await Bun.sleep(5);
		expect(sessions.liveCount()).toBe(4);
	});

	test("zero turns the cap off", () => {
		const sessions = manager(0);
		for (let i = 0; i < 50; i++) sessions.create("203.0.113.9");
		expect(sessions.liveCount()).toBe(50);
	});
});
