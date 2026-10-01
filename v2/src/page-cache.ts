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

export interface PageCacheOptions {
	/** Seconds a kept page is served as it is (default 10). */
	fresh?: number;
	/**
	 * Seconds after that the page is still served while one request renders
	 * it again (default 30). 0 waits for the new render instead.
	 */
	stale?: number;
	/** Most characters of pages kept; the least recently used go first (default 32 million). */
	maxChars?: number;
	/**
	 * Work done once on each page as it is kept rather than on every answer,
	 * such as `(html) => assets.rewrite(html)`. Answers built from it say so
	 * (`prepared`), so the step that would repeat it can skip them
	 * (`assets.markRewritten(ctx)`).
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
}

/**
 * Draws the page with `marks[i]` wherever the request's `secrets[i]` goes,
 * written as it is (not escaped or encoded: the marks need neither). Answers
 * null for a page that must not be kept: an error, a redirect, anything for
 * this visitor only.
 */
export type PageRender = (marks: readonly string[]) => Promise<CachedPage | null>;

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

export class PageCache {
	private readonly entries = new Map<string, Entry>();
	/** Renders under way, and the page each one kept for whoever waits on it. */
	private readonly pending = new Map<string, Promise<Entry | null>>();
	private readonly fresh: number;
	private readonly stale: number;
	private readonly maxChars: number;
	private readonly prepare: ((body: string) => string) | undefined;
	/** Per process and never sent, so no page can carry a mark it was not given. */
	private readonly mark = `natsu-secret-${crypto.randomUUID()}-`;
	private readonly marks: string[] = [];
	private chars = 0;
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
	 * key is too long to keep, `render` said no, or another request's render
	 * was the one that said no or failed. The caller then draws the page
	 * itself, with its real secrets; a render that throws throws here.
	 */
	public async serve(key: string, secrets: readonly string[], render: PageRender): Promise<CachedPage | null> {
		if (key.length > MAX_KEY) return null;
		const now = Date.now();
		const kept = this.entries.get(key);
		if (kept && now < kept.until) {
			// Most recently used last, so the oldest page is the one dropped.
			this.entries.delete(key);
			this.entries.set(key, kept);
			if (now < kept.fresh) {
				this.counts.fresh++;
			} else {
				this.counts.stale++;
				if (!this.pending.has(key)) void this.draw(key, secrets, render).catch(() => null);
			}
			return this.fill(kept.page, secrets);
		}

		// Past its stale time a page is not served; its memory goes with it.
		if (kept) this.delete(key);
		const running = this.pending.get(key);
		if (running) {
			// Someone else is drawing it: their page, our secrets.
			const entry = await running;
			return entry ? this.fill(entry.page, secrets) : null;
		}
		return this.draw(key, secrets, render);
	}

	/** Forget one page, so the next request draws it again. */
	public delete(key: string): void {
		const entry = this.entries.get(key);
		if (!entry) return;
		this.entries.delete(key);
		this.chars -= entry.chars;
	}

	/** Forget every page. */
	public clear(): void {
		this.entries.clear();
		this.chars = 0;
	}

	/** Draws the page for this request, keeps it if it may be kept, and tells whoever waits. */
	private draw(key: string, secrets: readonly string[], render: PageRender): Promise<CachedPage | null> {
		let share: (entry: Entry | null) => void = () => {};
		this.pending.set(key, new Promise((resolve) => { share = resolve; }));
		let entry: Entry | null = null;
		return (async (): Promise<CachedPage | null> => {
			try {
				const page = await render(this.marksFor(secrets.length));
				this.counts.rendered++;
				if (!page) {
					// What was kept is no longer what this key draws (it is gone, or
					// for one visitor now): stop serving it.
					this.delete(key);
					return null;
				}
				// The render put a real secret in the page: this visitor's alone.
				if (secrets.some((secret) => page.body.includes(secret))) return this.fill(page, secrets);
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
				this.keep(key, entry);
				return this.fill(entry.page, secrets);
			} finally {
				this.pending.delete(key);
				share(entry);
			}
		})();
	}

	private marksFor(count: number): readonly string[] {
		while (this.marks.length < count) this.marks.push(`${this.mark}${this.marks.length}.`);
		return this.marks.slice(0, count);
	}

	private keep(key: string, entry: Entry): void {
		this.delete(key);
		// A page larger than the whole budget is served, never kept.
		if (entry.chars > this.maxChars) return;
		this.entries.set(key, entry);
		this.chars += entry.chars;
		while (this.chars > this.maxChars) {
			const oldest = this.entries.keys().next();
			if (oldest.done) break;
			this.delete(oldest.value);
		}
	}

	private fill(page: CachedPage, secrets: readonly string[]): CachedPage {
		let body = page.body;
		for (const [index, secret] of secrets.entries()) body = body.replaceAll(`${this.mark}${index}.`, secret);
		return { ...page, body, ...(page.headers ? { headers: { ...page.headers } } : {}) };
	}
}
