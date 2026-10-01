/**
 * The page cache: a page drawn once serves every visitor until it is old,
 * each with their own secrets, and what must not be kept never is.
 */

import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { type CachedPage, PageCache } from "../src/page-cache.ts";

const NONCE_A = "a".repeat(32);
const NONCE_B = "b".repeat(32);
const CSRF_A = "1".repeat(64);
const CSRF_B = "2".repeat(64);

/** A page that prints the secrets it was rendered with, and counts its renders. */
function renderer(body = "page") {
	let renders = 0;
	const draw = (nonce: string, csrf: string) => async (): Promise<CachedPage> => {
		renders++;
		return { body: `<script nonce="${nonce}"></script><input value="${csrf}">${body} ${renders}`, status: 200 };
	};
	return { draw, renders: () => renders };
}

afterEach(() => {
	setSystemTime();
});

describe("PageCache", () => {
	test("a page is drawn once and every visitor gets it with their own secrets", async () => {
		const cache = new PageCache();
		const page = renderer();
		const first = await cache.serve("/p", [NONCE_A, CSRF_A], page.draw(NONCE_A, CSRF_A));
		const second = await cache.serve("/p", [NONCE_B, CSRF_B], page.draw(NONCE_B, CSRF_B));
		expect(page.renders()).toBe(1);
		expect(first?.body).toBe(`<script nonce="${NONCE_A}"></script><input value="${CSRF_A}">page 1`);
		expect(second?.body).toBe(`<script nonce="${NONCE_B}"></script><input value="${CSRF_B}">page 1`);
		expect(second?.body).not.toContain(NONCE_A);
		expect(second?.body).not.toContain(CSRF_A);
		expect(cache.counts).toEqual({ fresh: 1, stale: 0, rendered: 1 });
	});

	test("visitors who arrive while it is being drawn share that one render", async () => {
		const cache = new PageCache();
		const page = renderer();
		const [a, b, c] = await Promise.all([
			cache.serve("/p", [NONCE_A, CSRF_A], page.draw(NONCE_A, CSRF_A)),
			cache.serve("/p", [NONCE_B, CSRF_B], page.draw(NONCE_B, CSRF_B)),
			cache.serve("/p", [NONCE_B, CSRF_A], page.draw(NONCE_B, CSRF_A)),
		]);
		expect(page.renders()).toBe(1);
		expect(a?.body).toContain(NONCE_A);
		expect(b?.body).toContain(NONCE_B);
		expect(c?.body).toContain(CSRF_A);
		expect(c?.body).toContain(NONCE_B);
	});

	test("an old page is served once more while it is drawn again, then never past its stale time", async () => {
		const cache = new PageCache({ fresh: 10, stale: 30 });
		const page = renderer();
		setSystemTime(new Date("2026-10-01T00:00:00Z"));
		await cache.serve("/p", [NONCE_A, CSRF_A], page.draw(NONCE_A, CSRF_A));

		setSystemTime(new Date("2026-10-01T00:00:15Z"));
		const stale = await cache.serve("/p", [NONCE_A, CSRF_A], page.draw(NONCE_A, CSRF_A));
		expect(stale?.body).toEndWith("page 1");
		await Bun.sleep(0);
		expect(page.renders()).toBe(2);
		const fresh = await cache.serve("/p", [NONCE_A, CSRF_A], page.draw(NONCE_A, CSRF_A));
		expect(fresh?.body).toEndWith("page 2");

		setSystemTime(new Date("2026-10-01T00:01:00Z"));
		const redrawn = await cache.serve("/p", [NONCE_A, CSRF_A], page.draw(NONCE_A, CSRF_A));
		expect(redrawn?.body).toEndWith("page 3");
	});

	test("a page the render will not let be kept is never kept, and its old copy goes", async () => {
		const cache = new PageCache({ fresh: 0, stale: 30 });
		await cache.serve("/p", [NONCE_A, CSRF_A], renderer().draw(NONCE_A, CSRF_A));
		expect(cache.size).toBe(1);
		let refused = 0;
		const no = async () => {
			refused++;
			return null;
		};
		await cache.serve("/p", [NONCE_A, CSRF_A], no);
		await Bun.sleep(0);
		expect(refused).toBe(1);
		expect(cache.size).toBe(0);
		expect(await cache.serve("/p", [NONCE_A, CSRF_A], no)).toBeNull();
	});

	test("a render that fails fails its own request; the others draw their own", async () => {
		const cache = new PageCache();
		let calls = 0;
		const failing = async (): Promise<CachedPage> => {
			calls++;
			await Bun.sleep(5);
			throw new Error("api down");
		};
		const leader = cache.serve("/p", [NONCE_A, CSRF_A], failing);
		const waiter = cache.serve("/p", [NONCE_B, CSRF_B], failing);
		await expect(leader).rejects.toThrow("api down");
		expect(await waiter).toBeNull();
		expect(calls).toBe(1);
		expect(cache.size).toBe(0);
	});

	test("pages past the size budget push out the least recently used", async () => {
		const cache = new PageCache({ maxChars: 400 });
		for (const key of ["/a", "/b", "/c"]) await cache.serve(key, [NONCE_A, CSRF_A], renderer("x".repeat(20)).draw(NONCE_A, CSRF_A));
		expect(cache.size).toBeLessThan(3);
		const huge = renderer("y".repeat(1000));
		await cache.serve("/huge", [NONCE_A, CSRF_A], huge.draw(NONCE_A, CSRF_A));
		await cache.serve("/huge", [NONCE_A, CSRF_A], huge.draw(NONCE_A, CSRF_A));
		expect(huge.renders()).toBe(2);
	});

	test("short secrets and long keys are not kept", async () => {
		const cache = new PageCache();
		const page = renderer();
		expect(await cache.serve("/p", ["short"], page.draw(NONCE_A, CSRF_A))).toBeNull();
		expect(await cache.serve(`/p?${"q".repeat(3000)}`, [NONCE_A], page.draw(NONCE_A, CSRF_A))).toBeNull();
		expect(cache.size).toBe(0);
	});

	test("a page's own headers go out with it, a copy each time", async () => {
		const cache = new PageCache();
		const draw = async (): Promise<CachedPage> => ({ body: "x", status: 200, headers: { "content-type": "text/html" } });
		const first = await cache.serve("/p", [NONCE_A], draw);
		first!.headers!["content-type"] = "changed";
		const second = await cache.serve("/p", [NONCE_A], draw);
		expect(second?.headers).toEqual({ "content-type": "text/html" });
	});
});
