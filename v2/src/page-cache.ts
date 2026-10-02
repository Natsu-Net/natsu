/**
 * Whole rendered pages, kept and shared between visitors.
 *
 * A page most visitors see the same way (a product page, a listing, a
 * changelog, for someone who is not signed in) costs its data fetches and
 * its render on every view. Kept here, it costs a map lookup and a string
 * fill until it is `fresh` seconds old. For `stale` seconds after that it is
 * still served while one request renders it again in the background, so no
 * visitor waits on a render that a busy page has already paid for.
 *
 * What differs per visitor inside an otherwise shared page (a CSP nonce, a
 * CSRF token) is a secret. The render never sees one: it draws the marks it
 * is handed where the secrets go, and each answer is filled with that
 * request's own. A page that carries a secret anyway (the render used the
 * real one) is answered once and never kept, so no visitor's secret, and no
 * text a visitor chose as their "secret", ever reaches another visitor.
 *
 * Which pages to keep is the app's call: only what is the same for everyone
 * who gets it. A page that depends on who is asking (a session, a flash
 * message) must not come through here. The key says what else a page
 * depends on: its path and query, and anything else the app knows changes it.
 */

import { log } from "./logger.ts";

export interface PageCacheOptions {
	/** Seconds a kept page is served as it is (default 10). */
	fresh?: number;
	/**
	 * Seconds after that the page is still served while one request renders
	 * it again (default 30). 0 waits for the new render instead.
	 */
	stale?: number;
	/**
	 * Most characters (UTF-16 code units) of pages kept; the least recently
	 * used go first (default 32 million).
	 */
	maxChars?: number;
	/**
	 * Work done once on each page as it is kept rather than on every answer,
	 * such as `(html) => assets.rewrite(html)`. Answers built from it say so
	 * (`prepared`), so the step that would repeat it can skip them
	 * (`assets.markRewritten(ctx, page)`).
	 */
	prepare?: (body: string) => string;
}

/** A page as `render` draws it, and as `serve` answers it. */
export interface CachedPage {
	body: string;
	status: number;
	/** Headers that go out with the page, the same for every visitor. */
	headers?: Record<string, string>;
	/** Set on an answer whose page went through `prepare`. */
	prepared?: boolean;
	/**
	 * False on a page that may be answered but must not be kept: one that
	 * differs on every view (an ad picked for this view, a count that must
	 * see each one). Whoever was waiting on it draws their own.
	 */
	keep?: boolean;
}

/**
 * Draws the page with `marks[i]` wherever the request's `secrets[i]` goes,
 * written as it is (not escaped or encoded: the marks need neither). Answers
 * null for a page that must not be kept: an error, a redirect, anything for
 * this visitor only.
 */
export type PageRender = (marks: readonly string[]) => Promise<CachedPage | null>;

/**
 * How an answer came out of a kept page, for a step after the route that
 * would otherwise read the whole answer again (`Assets` adding navigation's
 * tags to a page kept rewritten): it reads the kept page once instead, and
 * builds each answer from its pieces.
 */
export interface Filled {
	/** The kept page, with marks where this answer's secrets went. */
	readonly page: CachedPage;
	/**
	 * `text`, a piece of the kept page (or text with no marks), with this
	 * answer's secrets in place of its marks: the same string when it holds
	 * none. Pieces put back together with `+` are copied once, when the
	 * answer is read.
	 */
	fill(text: string): string;
}

const fills = new WeakMap<CachedPage, Filled>();

/** How `answer`, a page `PageCache.serve` gave, was filled; undefined for any other page. */
export function filledOf(answer: CachedPage): Filled | undefined {
	return fills.get(answer);
}

interface Entry {
	/** The page with marks where the secrets go. */
	page: CachedPage;
	/** When it stops being fresh, then stops being served at all (ms). */
	fresh: number;
	until: number;
	chars: number;
}

/** Keys longer than this (a made-up query string) are rendered every time. */
const MAX_KEY = 2048;

/**
 * What a secret may hold: it is written into the page as it is, so nothing
 * that HTML would read as markup or a quote (hex, base64 and base64url fit).
 */
const SECRET = /^[\w.~+/=-]*$/;

/** Most keys remembered as not to be kept (a page that is missing, or differs per view). */
const MAX_REFUSED = 10_000;

/** A render under way; `void` once the key was forgotten while it ran. */
interface Run {
	done: Promise<Entry | null>;
	void: boolean;
}

export class PageCache {
	private readonly entries = new Map<string, Entry>();
	/** Renders under way, and the page each one drew for whoever waits on it. */
	private readonly pending = new Map<string, Run>();
	/**
	 * Keys whose last render said not to keep the page, and until when (ms).
	 * Until then they are not drawn through here at all: a visitor draws their
	 * own page at once instead of waiting on someone else's render that will
	 * not be shared either (a missing page, a page with an ad picked per view).
	 */
	private readonly refused = new Map<string, number>();
	private readonly fresh: number;
	private readonly stale: number;
	private readonly maxChars: number;
	private readonly prepare: ((body: string) => string) | undefined;
	/** Per process and never sent, so no page can carry a mark it was not given. */
	private readonly mark = `natsu-secret-${crypto.randomUUID()}-`;
	private readonly marks: string[] = [];
	private chars = 0;
	/** When pages past their stale time were last let go of (ms). */
	private swept = Date.now();
	/** Answers kept pages gave, fresh and stale, and renders. */
	public readonly counts = { fresh: 0, stale: 0, rendered: 0 };

	constructor(options: PageCacheOptions = {}) {
		this.fresh = (options.fresh ?? 10) * 1000;
		this.stale = (options.stale ?? 30) * 1000;
		this.maxChars = options.maxChars ?? 32_000_000;
		this.prepare = options.prepare;
	}

	/** Pages kept now. */
	public get size(): number {
		return this.entries.size;
	}

	/**
	 * The page for `key`, filled with this request's `secrets`: kept, or drawn
	 * by `render` (see PageRender) and kept. Null when nothing came of it: the
	 * key is too long to keep, a secret holds more than letters, digits and
	 * `_.~+/=-`, `render` said no (or `keep: false`) for this key less than
	 * `fresh` seconds ago, or another request's render was the one that said
	 * no, kept nothing or failed. The caller then draws the page
	 * itself, with its real secrets; a render that throws throws here.
	 */
	public async serve(key: string, secrets: readonly string[], render: PageRender): Promise<CachedPage | null> {
		if (key.length > MAX_KEY || !secrets.every((secret) => SECRET.test(secret))) return null;
		const now = Date.now();
		const refusedUntil = this.refused.get(key);
		if (refusedUntil !== undefined) {
			if (now < refusedUntil) return null;
			this.refused.delete(key);
		}
		const kept = this.entries.get(key);
		if (kept && now < kept.until) {
			// Most recently used last, so the oldest page is the one dropped.
			this.entries.delete(key);
			this.entries.set(key, kept);
			if (now < kept.fresh) {
				this.counts.fresh++;
			} else {
				this.counts.stale++;
				// Until a new render succeeds, the page stays served for the rest of
				// its stale time (an API that is down shows the last good page).
				if (!this.pending.has(key)) {
					void this.draw(key, secrets, render).catch((error) => {
						log.warn(`[<yellow>page-cache</yellow>] refreshing ${key} failed: ${(error as Error).message}`);
					});
				}
			}
			return this.fill(kept.page, secrets);
		}

		// Past its stale time a page is not served; its memory goes with it.
		if (kept) this.forget(key);
		const running = this.pending.get(key);
		if (running) {
			// Someone else is drawing it: their page, our secrets.
			const entry = await running.done;
			return entry ? this.fill(entry.page, secrets) : null;
		}
		return this.draw(key, secrets, render);
	}

	/**
	 * Forget one page, so the next request draws it again. A render of it
	 * already under way read what was there before, so it is not kept either:
	 * it answers the requests that came before this call and no other.
	 */
	public delete(key: string): void {
		this.forget(key);
		this.refused.delete(key);
		const running = this.pending.get(key);
		if (running) {
			running.void = true;
			this.pending.delete(key);
		}
	}

	/** Forget every page, and every render under way, as `delete` does. */
	public clear(): void {
		this.entries.clear();
		this.chars = 0;
		this.refused.clear();
		for (const running of this.pending.values()) running.void = true;
		this.pending.clear();
	}

	/** Draws the page for this request, keeps it if it may be kept, and tells whoever waits. */
	private draw(key: string, secrets: readonly string[], render: PageRender): Promise<CachedPage | null> {
		let share: (entry: Entry | null) => void = () => {};
		const run: Run = { done: new Promise((resolve) => { share = resolve; }), void: false };
		this.pending.set(key, run);
		let entry: Entry | null = null;
		return (async (): Promise<CachedPage | null> => {
			try {
				const page = await render(this.marksFor(secrets.length));
				this.counts.rendered++;
				if (!page || page.keep === false) {
					// What was kept is no longer what this key draws (it is gone, or
					// different for each visitor or view now): stop serving it, and
					// for a fresh span let each visitor draw their own.
					if (!run.void) {
						this.forget(key);
						this.refuse(key, Date.now());
					}
					return page ? this.fill(page, secrets) : null;
				}
				// The render put a real secret in the page: this visitor's alone. The
				// copy kept before is older than this render, so it goes too.
				if (secrets.some((secret) => secret !== "" && page.body.includes(secret))) {
					if (!run.void) this.forget(key);
					return this.fill(page, secrets);
				}
				const body = this.prepare ? this.prepare(page.body) : page.body;
				const now = Date.now();
				entry = {
					page: {
						...page,
						body,
						...(page.headers ? { headers: { ...page.headers } } : {}),
						...(this.prepare ? { prepared: true } : {}),
					},
					fresh: now + this.fresh,
					until: now + this.fresh + this.stale,
					chars: body.length + key.length,
				};
				// Forgotten while it ran: answer whoever asked before that, keep nothing.
				if (!run.void) this.keep(key, entry, now);
				return this.fill(entry.page, secrets);
			} finally {
				if (this.pending.get(key) === run) this.pending.delete(key);
				share(entry);
			}
		})();
	}

	private marksFor(count: number): readonly string[] {
		while (this.marks.length < count) this.marks.push(`${this.mark}${this.marks.length}.`);
		return this.marks.slice(0, count);
	}

	private keep(key: string, entry: Entry, now: number): void {
		this.forget(key);
		// Pages nobody asked for again stay until something pushes them out;
		// once per stale span, let go of those past their stale time.
		if (now - this.swept > this.fresh + this.stale) {
			this.swept = now;
			for (const [kept, old] of this.entries) if (old.until <= now) this.forget(kept);
		}
		// A page larger than the whole budget is served, never kept.
		if (entry.chars > this.maxChars) return;
		this.entries.set(key, entry);
		this.chars += entry.chars;
		while (this.chars > this.maxChars) {
			const oldest = this.entries.keys().next();
			if (oldest.done) break;
			this.forget(oldest.value);
		}
	}

	private refuse(key: string, now: number): void {
		this.refused.delete(key);
		this.refused.set(key, now + this.fresh);
		while (this.refused.size > MAX_REFUSED) {
			const oldest = this.refused.keys().next();
			if (oldest.done) break;
			this.refused.delete(oldest.value);
		}
	}

	/** Drops a kept page and its memory; renders under way carry on. */
	private forget(key: string): void {
		const entry = this.entries.get(key);
		if (!entry) return;
		this.entries.delete(key);
		this.chars -= entry.chars;
	}

	private fill(page: CachedPage, secrets: readonly string[]): CachedPage {
		const fill = (text: string): string => this.fillText(text, secrets);
		const { keep: _keep, ...answer } = page;
		const filled = { ...answer, body: fill(page.body), ...(page.headers ? { headers: { ...page.headers } } : {}) };
		fills.set(filled, { page, fill });
		return filled;
	}

	private fillText(text: string, secrets: readonly string[]): string {
		// One split on what every mark starts with, then each piece starts with
		// its mark's index. The pieces are joined with `+`, which copies nothing
		// until the answer is read: a copy of a large page is most of a hit's
		// cost, and a step that cuts the page to add to it (see `Filled`) builds
		// from the kept page instead, so the page is copied once, as it goes
		// out. Not replaceAll: a `$&` in a secret is text, not a pattern.
		const pieces = text.split(this.mark);
		if (pieces.length === 1) return text;
		let body = pieces[0]!;
		for (let i = 1; i < pieces.length; i++) {
			const piece = pieces[i]!;
			const dot = piece.indexOf(".");
			const index = dot > 0 && dot < 7 ? Number(piece.slice(0, dot)) : Number.NaN;
			body += Number.isInteger(index) && index < secrets.length ? secrets[index]! + piece.slice(dot + 1) : this.mark + piece;
		}
		return body;
	}
}
