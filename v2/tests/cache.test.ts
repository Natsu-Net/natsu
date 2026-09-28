import { describe, expect, test } from "bun:test";
import { Cache } from "../src/cache.ts";

describe("Cache", () => {
	test("stores and returns a value", () => {
		const cache = new Cache<string>(10, false);
		cache.set("k", "v");
		expect(cache.get("k")).toBe("v");
	});

	test("a miss is false, not undefined — v1 callers compare against false", () => {
		expect(new Cache(10, false).get("nope")).toBe(false);
	});

	test("an expired entry is a miss and is dropped on read", () => {
		const cache = new Cache<string>(10, false);
		cache.set("k", "v", -1);
		expect(cache.get("k")).toBe(false);
		expect(cache.getSize()).toBe(0);
	});

	test("has() reports liveness, not mere presence", () => {
		const cache = new Cache<string>(10, false);
		cache.set("fresh", "v", 10);
		cache.set("stale", "v", -1);
		expect(cache.has("fresh")).toBe(true);
		expect(cache.has("stale")).toBe(false);
	});

	test("getOrSet produces once and then reads", () => {
		const cache = new Cache<number>(10, false);
		let calls = 0;
		const produce = () => {
			calls++;
			return 7;
		};
		expect(cache.getOrSet("k", produce)).toBe(7);
		expect(cache.getOrSet("k", produce)).toBe(7);
		expect(calls).toBe(1);
	});

	test("a falsy stored value still counts as a hit on the next read", () => {
		const cache = new Cache<number>(10, false);
		let calls = 0;
		cache.getOrSet("zero", () => {
			calls++;
			return 0;
		});
		cache.getOrSet("zero", () => {
			calls++;
			return 0;
		});
		// 0 is a legitimate value; only `false` means "absent".
		expect(calls).toBe(1);
	});

	test("RemoveExpired reports how many it dropped", () => {
		const cache = new Cache<string>(10, false);
		cache.set("a", "1", -1);
		cache.set("b", "2", -1);
		cache.set("c", "3", 100);
		expect(cache.RemoveExpired()).toBe(2);
		expect(cache.getSize()).toBe(1);
	});

	test("the sweep timer does not hold the process open", () => {
		const cache = new Cache<string>(10, true, 5);
		// unref'd timers report as such; v1's did not and pinned the loop.
		cache.close();
		expect(cache.getSize()).toBe(0);
	});

	test("Remove and clear", () => {
		const cache = new Cache<string>(10, false);
		cache.set("a", "1");
		expect(cache.Remove("a")).toBe(true);
		expect(cache.Remove("a")).toBe(false);
		cache.set("b", "2");
		cache.clear();
		expect(cache.getSize()).toBe(0);
	});
});
