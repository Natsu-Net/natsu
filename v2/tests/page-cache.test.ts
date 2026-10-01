/**
 * The page cache: a page drawn once serves every visitor until it is old,
 * each with their own secrets, and what must not be kept never is.
 */

import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { type CachedPage, PageCache, type PageRender } from "../src/page-cache.ts";

const NONCE_A = "a".repeat(32);
const NONCE_B = "b".repeat(32);
const CSRF_A = "1".repeat(64);
const CSRF_B = "2".repeat(64);

/** A page that prints what it is handed for the nonce and the CSRF token, and counts its renders. */
function renderer(body = "page") {
	let renders = 0;
	const draw: PageRender = async ([nonce, csrf]) => {
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
		const first = await cache.serve("/p", [NONCE_A, CSRF_A], page.draw);
		const second = await cache.serve("/p", [NONCE_B, CSRF_B], page.draw);
		expect(page.renders()).toBe(1);
		expect(first?.body).toBe(`<script nonce="${NONCE_A}"></script><input value="${CSRF_A}">page 1`);
		expect(second?.body).toBe(`<script nonce="${NONCE_B}"></script><input value="${CSRF_B}">page 1`);
		expect(cache.counts).toEqual({ fresh: 1, stale: 0, rendered: 1 });
	});

	test("visitors who arrive while it is being drawn share that one render", async () => {
		const cache = new PageCache();
		const page = renderer();
		const [a, b, c] = await Promise.all([
			cache.serve("/p", [NONCE_A, CSRF_A], page.draw),
			cache.serve("/p", [NONCE_B, CSRF_B], page.draw),
			cache.serve("/p", [NONCE_B, CSRF_A], page.draw),
		]);
		expect(page.renders()).toBe(1);
		expect(a?.body).toContain(NONCE_A);
		expect(b?.body).toContain(NONCE_B);
		expect(b?.body).not.toContain(CSRF_A);
		expect(c?.body).toContain(CSRF_A);
		expect(c?.body).toContain(NONCE_B);
	});

	test("a render that puts a real secret in the page is answered to its own visitor alone", async () => {
		const cache = new PageCache();
		let renders = 0;
		const careless: PageRender = async () => {
			renders++;
			return { body: `<input value="${CSRF_A}">`, status: 200 };
		};
		const [own, other] = await Promise.all([
			cache.serve("/p", [NONCE_A, CSRF_A], careless),
			cache.serve("/p", [NONCE_B, CSRF_B], careless),
		]);
		expect(own?.body).toBe(`<input value="${CSRF_A}">`);
		// The other visitor waited on that render, got nothing, and draws its own.
		expect(other).toBeNull();
		expect(renders).toBe(1);
		expect(cache.size).toBe(0);
	});

	test("a visitor who picks page text as their secret cannot change the page for anyone else", async () => {
		const cache = new PageCache();
		const page = renderer("Fast-stable-plugin");
		const chosen = "Fast-stable-plugin";
		const theirs = await cache.serve("/p", [NONCE_A, chosen], page.draw);
		expect(theirs?.body).toContain(chosen);
		expect(cache.size).toBe(0);
		const next = await cache.serve("/p", [NONCE_B, CSRF_B], page.draw);
		expect(next?.body).toBe(`<script nonce="${NONCE_B}"></script><input value="${CSRF_B}">Fast-stable-plugin 2`);
		const again = await cache.serve("/p", [NONCE_A, CSRF_A], page.draw);
		expect(again?.body).toBe(`<script nonce="${NONCE_A}"></script><input value="${CSRF_A}">Fast-stable-plugin 2`);
	});

	test("a secret that HTML could read as markup, a quote or a pattern is not filled in at all", async () => {
		const cache = new PageCache();
		const page = renderer();
		for (const secret of [`"><img src=x onerror=alert(1)>`, "$&", "a b", "it's"]) {
			expect(await cache.serve("/p", [NONCE_A, secret], page.draw)).toBeNull();
		}
		expect(page.renders()).toBe(0);
		// Hex, base64 and base64url are filled as they are.
		const fine = "aZ09+/=_-.~";
		expect((await cache.serve("/p", [NONCE_A, fine], page.draw))?.body).toContain(`value="${fine}"`);
	});

	test("a page forgotten while it is drawn answers who asked before, and is not kept", async () => {
		for (const forget of [(cache: PageCache) => cache.delete("/p"), (cache: PageCache) => cache.clear()]) {
			const cache = new PageCache({ fresh: 60 });
			let release = () => {};
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			const before = async (): Promise<CachedPage> => {
				await gate;
				return { body: "listed", status: 200 };
			};
			const first = cache.serve("/p", [], before);
			const joined = cache.serve("/p", [], before);
			// A takedown: the app forgets the page while the render above still runs.
			forget(cache);
			const after = cache.serve("/p", [], async () => ({ body: "gone", status: 200 }));
			release();
			expect((await first)?.body).toBe("listed");
			expect((await joined)?.body).toBe("listed");
			expect((await after)?.body).toBe("gone");
			expect((await cache.serve("/p", [], before))?.body).toBe("gone");
		}
	});

	test("a page that must not be kept is answered, its old copy goes, and waiters draw their own", async () => {
		const cache = new PageCache({ fresh: 0, stale: 30 });
		await cache.serve("/p", [NONCE_A, CSRF_A], renderer().draw);
		expect(cache.size).toBe(1);
		let views = 0;
		const perView = async ([nonce]: readonly string[]): Promise<CachedPage> => {
			views++;
			await Bun.sleep(1);
			return { body: `<script nonce="${nonce}"></script>ad ${views}`, status: 200, keep: false };
		};
		const [own, waiter] = await Promise.all([
			cache.serve("/q", [NONCE_A, CSRF_A], perView),
			cache.serve("/q", [NONCE_B, CSRF_B], perView),
		]);
		expect(own).toEqual({ body: `<script nonce="${NONCE_A}"></script>ad 1`, status: 200 });
		expect(waiter).toBeNull();
		await cache.serve("/p", [NONCE_A, CSRF_A], perView);
		await Bun.sleep(5);
		expect(cache.size).toBe(0);
	});

	test("a key whose page may not be kept is drawn by each visitor for a fresh span, without waiting", async () => {
		setSystemTime(new Date("2026-10-01T00:00:00Z"));
		const cache = new PageCache({ fresh: 10, stale: 30 });
		let renders = 0;
		const missing = async () => {
			renders++;
			return null;
		};
		expect(await cache.serve("/gone", [], missing)).toBeNull();
		// The next visitors draw their own at once: no render through the cache.
		expect(await cache.serve("/gone", [], missing)).toBeNull();
		expect(renders).toBe(1);
		const perView = async (): Promise<CachedPage> => {
			renders++;
			return { body: "ad", status: 200, keep: false };
		};
		expect((await cache.serve("/ads", [], perView))?.body).toBe("ad");
		expect(await cache.serve("/ads", [], perView)).toBeNull();
		expect(renders).toBe(2);
		// After the fresh span the key is tried again, and kept if it may be now.
		setSystemTime(new Date("2026-10-01T00:00:11Z"));
		const page = renderer();
		await cache.serve("/gone", [NONCE_A, CSRF_A], page.draw);
		await cache.serve("/gone", [NONCE_B, CSRF_B], page.draw);
		expect(page.renders()).toBe(1);
		// delete() forgets a refusal too.
		await cache.serve("/ads", [], perView);
		cache.delete("/ads");
		expect((await cache.serve("/ads", [NONCE_A, CSRF_A], page.draw))?.body).toContain("page 2");
	});

	test("keys remembered as not to be kept are bounded", async () => {
		const cache = new PageCache();
		for (let i = 0; i < 10_050; i++) await cache.serve(`/gone/${i}`, [], async () => null);
		expect((cache as unknown as { refused: Map<string, number> }).refused.size).toBe(10_000);
	});

	test("a refresh that carries a visitor's secret drops the older copy", async () => {
		setSystemTime(new Date("2026-10-01T00:00:00Z"));
		const cache = new PageCache({ fresh: 10, stale: 30 });
		let version = "old";
		const draw: PageRender = async ([nonce]) => ({ body: `${version} ${nonce} uuid-0199aaaa`, status: 200 });
		await cache.serve("/p", [NONCE_A], draw);
		version = "edited";
		setSystemTime(new Date("2026-10-01T00:00:15Z"));
		// A visitor whose secret is page text starts the refresh: their answer is the
		// old copy, the refresh is theirs alone, and the old copy goes with it.
		expect((await cache.serve("/p", ["uuid-0199aaaa"], draw))?.body).toStartWith("old");
		await Bun.sleep(0);
		expect(cache.size).toBe(0);
		expect((await cache.serve("/p", [NONCE_B], draw))?.body).toBe(`edited ${NONCE_B} uuid-0199aaaa`);
	});

	test("pages nobody asks for again are let go of once past their stale time", async () => {
		setSystemTime(new Date("2026-10-01T00:00:00Z"));
		const cache = new PageCache({ fresh: 1, stale: 1 });
		await cache.serve("/a", [], renderer().draw);
		await cache.serve("/b", [], renderer().draw);
		expect(cache.size).toBe(2);
		setSystemTime(new Date("2026-10-01T00:00:03Z"));
		await cache.serve("/c", [], renderer().draw);
		expect(cache.size).toBe(1);
	});

	test("an old page is served once more while it is drawn again, then never past its stale time", async () => {
		const cache = new PageCache({ fresh: 10, stale: 30 });
		const page = renderer();
		setSystemTime(new Date("2026-10-01T00:00:00Z"));
		await cache.serve("/p", [NONCE_A, CSRF_A], page.draw);

		setSystemTime(new Date("2026-10-01T00:00:15Z"));
		const stale = await cache.serve("/p", [NONCE_A, CSRF_A], page.draw);
		expect(stale?.body).toEndWith("page 1");
		await Bun.sleep(0);
		expect(page.renders()).toBe(2);
		const fresh = await cache.serve("/p", [NONCE_A, CSRF_A], page.draw);
		expect(fresh?.body).toEndWith("page 2");

		setSystemTime(new Date("2026-10-01T00:01:00Z"));
		const redrawn = await cache.serve("/p", [NONCE_A, CSRF_A], page.draw);
		expect(redrawn?.body).toEndWith("page 3");
	});

	test("a page the render will not let be kept is never kept, and its old copy goes", async () => {
		const cache = new PageCache({ fresh: 0, stale: 30 });
		await cache.serve("/p", [NONCE_A, CSRF_A], renderer().draw);
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
		for (const key of ["/a", "/b", "/c"]) await cache.serve(key, [NONCE_A, CSRF_A], renderer("x".repeat(20)).draw);
		expect(cache.size).toBeLessThan(3);
		const huge = renderer("y".repeat(1000));
		await cache.serve("/huge", [NONCE_A, CSRF_A], huge.draw);
		await cache.serve("/huge", [NONCE_A, CSRF_A], huge.draw);
		expect(huge.renders()).toBe(2);
	});

	test("long keys are drawn every time", async () => {
		const cache = new PageCache();
		const page = renderer();
		expect(await cache.serve(`/p?${"q".repeat(3000)}`, [NONCE_A], page.draw)).toBeNull();
		expect(page.renders()).toBe(0);
		expect(cache.size).toBe(0);
	});

	test("prepare runs once on each page kept, and never on one that is not", async () => {
		let prepared = 0;
		const cache = new PageCache({
			prepare: (body) => {
				prepared++;
				return body.replace("page", "PAGE");
			},
		});
		const page = renderer();
		const first = await cache.serve("/p", [NONCE_A, CSRF_A], page.draw);
		const second = await cache.serve("/p", [NONCE_B, CSRF_B], page.draw);
		expect(prepared).toBe(1);
		expect(first?.prepared).toBe(true);
		expect(second?.body).toBe(`<script nonce="${NONCE_B}"></script><input value="${CSRF_B}">PAGE 1`);
		const careless = await cache.serve("/q", [NONCE_A, CSRF_A], async () => ({ body: CSRF_A, status: 200 }));
		expect(careless).toEqual({ body: CSRF_A, status: 200 });
		expect(prepared).toBe(1);
	});

	test("a page's own headers go out with it, a copy each time", async () => {
		const cache = new PageCache();
		const headers = { "content-type": "text/html" };
		const draw = async (): Promise<CachedPage> => ({ body: "x", status: 200, headers });
		const first = await cache.serve("/p", [NONCE_A], draw);
		first!.headers!["content-type"] = "changed";
		headers["content-type"] = "changed too";
		const second = await cache.serve("/p", [NONCE_A], draw);
		expect(second?.headers).toEqual({ "content-type": "text/html" });
	});
});
