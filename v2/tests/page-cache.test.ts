/**
 * The page cache: a page drawn once serves every visitor until it is old,
 * each with their own secrets, and what must not be kept never is.
 */

import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { invalidate } from "../src/invalidate.ts";
import { type CachedPage, PageCache, type PageRender, filledOf } from "../src/page-cache.ts";

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

	test("every mark is filled in one pass: many secrets, side by side, repeated, and a page with none", async () => {
		const cache = new PageCache();
		const secrets = ["s0", "s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8", "s9", "s10", "s11"];
		const draw: PageRender = async (marks) => ({ body: `${marks.join("")}|${marks[11]}${marks[0]}|${marks[1]}.x`, status: 200 });
		const first = await cache.serve("/many", secrets, draw);
		const kept = await cache.serve("/many", secrets, draw);
		const filled = `${secrets.join("")}|s11s0|s1.x`;
		expect([first?.body, kept?.body]).toEqual([filled, filled]);
		const none = await cache.serve("/none", [NONCE_A], async () => ({ body: "no marks here", status: 200 }));
		expect(none?.body).toBe("no marks here");
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

	test("an answer says which kept page it was filled from, and fills pieces of it with its own secrets", async () => {
		const cache = new PageCache({ prepare: (body) => body });
		const page = renderer();
		await cache.serve("/p", [NONCE_A, CSRF_A], page.draw);
		const answer = (await cache.serve("/p", [NONCE_B, CSRF_B], page.draw))!;
		const filled = filledOf(answer)!;
		const kept = filled.page.body;
		expect(kept).not.toContain(NONCE_A);
		const at = kept.indexOf("<input");
		expect(filled.fill(kept.slice(0, at)) + "|" + filled.fill(kept.slice(at))).toBe(answer.body.replace("<input", "|<input"));
		const plain = "no marks here";
		expect(filled.fill(plain)).toBe(plain);
		expect(filledOf({ body: answer.body, status: 200 })).toBeUndefined();
	});
});

/** A page tagged `tags` that says which render drew it. */
function tagged(tags: readonly string[], hold?: CachedPage["hold"]) {
	let renders = 0;
	const draw: PageRender = async () => {
		renders++;
		return { body: `drawn ${renders}`, status: 200, tags, ...(hold ? { hold } : {}) };
	};
	return { draw, renders: () => renders };
}

const index = (cache: PageCache) => (cache as unknown as { byTag: Map<string, Set<string>> }).byTag;

describe("PageCache tags", () => {
	test("dropping a tag deletes only the pages that carry it", async () => {
		const cache = new PageCache({ fresh: 60 });
		const shoe = tagged(["product:shoe", "catalog"]);
		const hat = tagged(["product:hat", "catalog"]);
		const plain = renderer();
		await cache.serve("/shoe", [], shoe.draw);
		await cache.serve("/hat", [], hat.draw);
		await cache.serve("/about", [NONCE_A, CSRF_A], plain.draw);
		expect(cache.dropTags(["product:shoe", "unknown"], "delete")).toBe(1);
		expect(cache.size).toBe(2);
		expect((await cache.serve("/shoe", [], shoe.draw))?.body).toBe("drawn 2");
		expect((await cache.serve("/hat", [], hat.draw))?.body).toBe("drawn 1");
		expect(cache.dropTags(["catalog"], "delete")).toBe(2);
		expect(cache.size).toBe(1);
		expect(plain.renders()).toBe(1);
	});

	test("tags and hold are never part of an answer", async () => {
		const cache = new PageCache();
		const page = tagged(["catalog"], { fresh: 5, stale: 5 });
		expect(await cache.serve("/p", [], page.draw)).toEqual({ body: "drawn 1", status: 200 });
		expect(await cache.serve("/p", [], page.draw)).toEqual({ body: "drawn 1", status: 200 });
		const once = await cache.serve("/q", [], async () => ({ body: "x", status: 200, keep: false, tags: ["catalog"] }));
		expect(once).toEqual({ body: "x", status: 200 });
	});

	test("an expired page is served once more while it is drawn again, then the new one", async () => {
		setSystemTime(new Date("2026-10-01T00:00:00Z"));
		const cache = new PageCache({ fresh: 60, stale: 30 });
		const page = tagged(["product:shoe"]);
		await cache.serve("/shoe", [], page.draw);
		expect(cache.dropTags(["product:shoe"], "expire")).toBe(1);
		expect((await cache.serve("/shoe", [], page.draw))?.body).toBe("drawn 1");
		await Bun.sleep(0);
		expect(page.renders()).toBe(2);
		expect((await cache.serve("/shoe", [], page.draw))?.body).toBe("drawn 2");
		expect(cache.counts).toEqual({ fresh: 1, stale: 1, rendered: 2 });
		// Within its stale time only: past it the next visitor waits on a render.
		cache.dropTags(["product:shoe"], "expire");
		setSystemTime(new Date("2026-10-01T00:00:31Z"));
		expect((await cache.serve("/shoe", [], page.draw))?.body).toBe("drawn 3");
	});

	test("expiring a page kept with no stale time forgets it", async () => {
		const cache = new PageCache({ fresh: 60, stale: 0 });
		const page = tagged(["catalog"]);
		await cache.serve("/p", [], page.draw);
		expect(cache.dropTags(["catalog"], "expire")).toBe(1);
		expect(cache.size).toBe(0);
		expect((await cache.serve("/p", [], page.draw))?.body).toBe("drawn 2");
	});

	test("a render under way when its tag drops answers who asked, and is not kept", async () => {
		for (const mode of ["delete", "expire"] as const) {
			const cache = new PageCache({ fresh: 60 });
			let release = () => {};
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			let renders = 0;
			const draw: PageRender = async () => {
				const n = ++renders;
				if (n === 1) await gate;
				return { body: `drawn ${n}`, status: 200, tags: ["product:shoe"] };
			};
			// Not kept yet, so nothing in the index names it: the drop still reaches it.
			const first = cache.serve("/shoe", [], draw);
			cache.dropTags(["product:shoe"], mode);
			release();
			expect((await first)?.body).toBe("drawn 1");
			expect(cache.size).toBe(0);
			expect((await cache.serve("/shoe", [], draw))?.body).toBe("drawn 2");
			// A render under way for a page that draws other data is kept (the drop
			// below deletes or expires /shoe again, and leaves /hat).
			const other = tagged(["product:hat"]);
			let open = () => {};
			const wait = new Promise<void>((resolve) => {
				open = resolve;
			});
			const hat = cache.serve("/hat", [], async (marks) => (await wait, other.draw(marks)));
			cache.dropTags(["product:shoe"], mode);
			open();
			await hat;
			expect(cache.size).toBe(mode === "delete" ? 1 : 2);
			expect(cache.dropTags(["product:hat"], "delete")).toBe(1);
		}
	});

	test("a request after a drop does not join the first render of a page, which read the old data", async () => {
		for (const mode of ["delete", "expire"] as const) {
			const cache = new PageCache({ fresh: 60 });
			let data = "visible";
			let release = () => {};
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			let renders = 0;
			const draw: PageRender = async () => {
				const n = ++renders;
				const read = data;
				if (n === 1) await gate;
				return { body: `${read} ${n}`, status: 200, tags: ["product:1"] };
			};
			// Nothing kept yet for the key, so the drop finds no page to forget.
			const first = cache.serve("/p", [], draw);
			data = "taken down";
			cache.dropTags(["product:1"], mode);
			const after = cache.serve("/p", [], draw);
			// One new render: whoever comes next joins it.
			const later = cache.serve("/p", [], draw);
			release();
			expect((await first)?.body).toBe("visible 1");
			expect((await after)?.body).toBe("taken down 2");
			expect((await later)?.body).toBe("taken down 2");
			expect(renders).toBe(2);
			expect((await cache.serve("/p", [], draw))?.body).toBe("taken down 2");
		}
	});

	test("expiring voids a refresh already under way, which read the old data", async () => {
		setSystemTime(new Date("2026-10-01T00:00:00Z"));
		const cache = new PageCache({ fresh: 10, stale: 30 });
		let version = "old";
		let release = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const draw: PageRender = async () => {
			const read = version;
			if (read === "old" && cache.counts.rendered > 0) await gate;
			return { body: read, status: 200, tags: ["doc:1"] };
		};
		await cache.serve("/doc", [], draw);
		setSystemTime(new Date("2026-10-01T00:00:15Z"));
		// A stale answer starts a refresh, which reads "old" and then waits.
		expect((await cache.serve("/doc", [], draw))?.body).toBe("old");
		version = "new";
		cache.dropTags(["doc:1"], "expire");
		release();
		await Bun.sleep(0);
		// The refresh was not kept; the next answer is still the old page, and starts a new refresh.
		expect((await cache.serve("/doc", [], draw))?.body).toBe("old");
		await Bun.sleep(0);
		expect((await cache.serve("/doc", [], draw))?.body).toBe("new");
	});

	test("the tag index stays bounded as pages are pushed out and replaced", async () => {
		const cache = new PageCache({ maxChars: 2000 });
		for (let i = 0; i < 500; i++) {
			await cache.serve(`/p/${i}`, [], async () => ({ body: "x".repeat(100), status: 200, tags: [`product:${i}`, "catalog"] }));
		}
		expect(cache.size).toBeLessThan(20);
		expect(index(cache).size).toBe(cache.size + 1);
		expect(index(cache).get("catalog")?.size).toBe(cache.size);
		// A page drawn again with other tags leaves its old ones.
		const last = "/p/499";
		cache.delete(last);
		await cache.serve(last, [], async () => ({ body: "y", status: 200, tags: ["other"] }));
		expect(index(cache).has("product:499")).toBe(false);
		cache.clear();
		expect(index(cache).size).toBe(0);
	});

	test("a page with too many tags, or one that is not a tag, keeps none", async () => {
		const cache = new PageCache({ fresh: 60 });
		const many = Array.from({ length: 65 }, (_, i) => `t:${i}`);
		await cache.serve("/many", [], tagged(many).draw);
		await cache.serve("/bad", [], tagged(["catalog", "has space"]).draw);
		const exactly = Array.from({ length: 64 }, (_, i) => `t:${i}`);
		await cache.serve("/fits", [], tagged([...exactly, ...exactly]).draw);
		expect(cache.size).toBe(3);
		expect(cache.dropTags(["t:0", "catalog"], "delete")).toBe(1);
		expect(cache.size).toBe(2);
		expect(index(cache).size).toBe(0);
	});

	test("hold keeps a page for its own fresh and stale time", async () => {
		setSystemTime(new Date("2026-10-01T00:00:00Z"));
		const cache = new PageCache({ fresh: 10, stale: 30 });
		const long = tagged(["catalog"], { fresh: 300, stale: 600 });
		const odd = tagged(["catalog"], { fresh: -1, stale: Number.NaN });
		await cache.serve("/long", [], long.draw);
		await cache.serve("/odd", [], odd.draw);
		setSystemTime(new Date("2026-10-01T00:04:00Z"));
		expect((await cache.serve("/long", [], long.draw))?.body).toBe("drawn 1");
		expect(cache.counts.fresh).toBe(1);
		// A hold that is not a number of seconds is the cache's own: long gone by now.
		expect((await cache.serve("/odd", [], odd.draw))?.body).toBe("drawn 2");
		setSystemTime(new Date("2026-10-01T00:14:00Z"));
		expect((await cache.serve("/long", [], long.draw))?.body).toBe("drawn 1");
		expect(cache.counts.stale).toBe(1);
	});

	test("expireAll makes every page old and caps how long it is served", async () => {
		setSystemTime(new Date("2026-10-01T00:00:00Z"));
		const cache = new PageCache({ fresh: 10, stale: 30 });
		const long = tagged([], { fresh: 300, stale: 600 });
		const plain = renderer();
		await cache.serve("/long", [], long.draw);
		await cache.serve("/plain", [NONCE_A, CSRF_A], plain.draw);
		cache.expireAll(5);
		setSystemTime(new Date("2026-10-01T00:00:04Z"));
		expect((await cache.serve("/long", [], long.draw))?.body).toBe("drawn 1");
		await Bun.sleep(0);
		expect(long.renders()).toBe(2);
		setSystemTime(new Date("2026-10-01T00:00:06Z"));
		// Past the cap the old page is not served; the redrawn one is fresh again.
		expect((await cache.serve("/plain", [NONCE_A, CSRF_A], plain.draw))?.body).toEndWith("page 2");
		expect((await cache.serve("/long", [], long.draw))?.body).toBe("drawn 2");
		expect(cache.counts.fresh).toBe(1);
		cache.expireAll(0);
		expect(cache.size).toBe(0);
	});

	test("a render under way when everything expires is not kept", async () => {
		const cache = new PageCache({ fresh: 60 });
		let release = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const first = cache.serve("/p", [], async () => (await gate, { body: "before", status: 200 }));
		cache.expireAll(30);
		release();
		expect((await first)?.body).toBe("before");
		expect(cache.size).toBe(0);
	});

	test("a burst of expires draws a page one render at a time", async () => {
		const cache = new PageCache({ fresh: 60, stale: 30 });
		const gates: (() => void)[] = [];
		let renders = 0;
		let running = 0;
		let most = 0;
		const draw: PageRender = async () => {
			const n = ++renders;
			running++;
			most = Math.max(most, running);
			if (n > 1) await new Promise<void>((resolve) => gates.push(resolve));
			running--;
			return { body: `drawn ${n}`, status: 200, tags: ["catalog"] };
		};
		await cache.serve("/home", [], draw);
		for (let i = 0; i < 5; i++) {
			cache.dropTags(["catalog"], "expire");
			expect((await cache.serve("/home", [], draw))?.body).toBe("drawn 1");
			expect((await cache.serve("/home", [], draw))?.body).toBe("drawn 1");
		}
		expect(renders).toBe(2);
		// The render under way read what was there before the later drops: not kept.
		gates.shift()?.();
		await Bun.sleep(0);
		expect((await cache.serve("/home", [], draw))?.body).toBe("drawn 1");
		expect(renders).toBe(3);
		gates.shift()?.();
		await Bun.sleep(0);
		expect((await cache.serve("/home", [], draw))?.body).toBe("drawn 3");
		expect(most).toBe(1);
	});

	test("a visitor after a drop never waits on a render that read what was there before", async () => {
		const cache = new PageCache({ fresh: 60, stale: 30 });
		let release = () => {};
		let renders = 0;
		const draw: PageRender = async () => {
			const n = ++renders;
			if (n === 2) await new Promise<void>((resolve) => (release = resolve));
			return { body: `drawn ${n}`, status: 200, tags: ["catalog"] };
		};
		await cache.serve("/home", [], draw);
		cache.dropTags(["catalog"], "expire");
		expect((await cache.serve("/home", [], draw))?.body).toBe("drawn 1");
		// Nothing may be served any more: the next visitor draws its own page.
		cache.expireAll(0);
		expect((await cache.serve("/home", [], draw))?.body).toBe("drawn 3");
		release();
		await Bun.sleep(0);
		expect((await cache.serve("/home", [], draw))?.body).toBe("drawn 3");
	});

	test("with invalidate: true, a plain invalidation deletes and a soft one expires", async () => {
		const cache = new PageCache({ fresh: 60, invalidate: true });
		const page = tagged(["product:shoe"]);
		await cache.serve("/shoe", [], page.draw);
		invalidate("product:shoe", { soft: true });
		expect((await cache.serve("/shoe", [], page.draw))?.body).toBe("drawn 1");
		await Bun.sleep(0);
		expect((await cache.serve("/shoe", [], page.draw))?.body).toBe("drawn 2");
		invalidate(["product:shoe"], { remote: true });
		expect(cache.size).toBe(0);
		expect((await cache.serve("/shoe", [], page.draw))?.body).toBe("drawn 3");
		cache.clear();
	});

	test("listen() does the same until it is stopped; a cache left alone hears nothing", async () => {
		const deaf = new PageCache({ fresh: 60 });
		const cache = new PageCache({ fresh: 60 });
		const page = tagged(["doc:7"]);
		await deaf.serve("/doc", [], page.draw);
		await cache.serve("/doc", [], page.draw);
		const stop = cache.listen();
		invalidate("doc:7");
		expect(cache.size).toBe(0);
		expect(deaf.size).toBe(1);
		await cache.serve("/doc", [], page.draw);
		stop();
		invalidate("doc:7");
		expect(cache.size).toBe(1);
	});
});
