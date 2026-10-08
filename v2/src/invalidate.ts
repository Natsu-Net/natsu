/**
 * Live data: a page that drew a live source is told when that source's data
 * changes, and draws itself again.
 *
 * A source is live unless it says `live: false`; every value it loads is
 * tagged with its name and with the tags its `tags(…)` gives for the
 * arguments it was called with (`product:blue-shoe`). The page carries
 * those tags, signed, in `<meta name="natsu-live">`; the runtime sends them
 * over natsu's socket (`/_uwu/socket`) and refreshes the page's regions when
 * one is invalidated:
 *
 *   source("product", load, { tags: ({ args }) => [`product:${args.slug}`] });
 *   invalidate(`product:${slug}`);        // after a write, from anywhere
 *   action("products.save", save, { touches: ["product"] });
 *
 * Fan-out is node-local: this process's sockets and its PageCache. Several
 * nodes need a change feed between them, which is not here yet: it plugs
 * into `onInvalidate` (to send this node's invalidations out) and calls
 * `invalidate(tags, { remote: true })` for the ones that come in.
 *
 * The tags a page carries are signed so that a socket subscribes to what a
 * page this server drew listed, and nothing else; a page served by one node
 * and a socket held by another need the same secret (`setLiveSecret`, or
 * `NATSU_LIVE_SECRET`).
 */

/** What a tag may be: no spaces, no `|`, a reasonable length. */
const TAG = /^[\w.:/@+=-]{1,160}$/;
/** Most tags one page carries; past it the page is not live. */
export const MAX_TAGS = 64;

export type InvalidateListener = (tags: readonly string[], remote: boolean) => void;

const listeners = new Set<InvalidateListener>();

/**
 * Run `fn` for every invalidation: this node's own (`remote` false) and those
 * a change feed passes in. Returns the function that removes it.
 */
export function onInvalidate(fn: InvalidateListener): () => void {
	listeners.add(fn);
	return () => listeners.delete(fn);
}

/** Whether `tag` is one natsu can carry. */
export function isTag(tag: unknown): tag is string {
	return typeof tag === "string" && TAG.test(tag);
}

/**
 * Tell every page that drew data tagged so to draw itself again: kept pages
 * are let go, and every browser showing one refreshes its regions.
 */
export function invalidate(tags: string | readonly string[], options: { remote?: boolean } = {}): void {
	const list = [...new Set(typeof tags === "string" ? [tags] : tags)].filter(isTag);
	if (list.length === 0) return;
	for (const fn of [...listeners]) {
		try {
			fn(list, options.remote === true);
		} catch {
			// One listener failing must not keep the others from hearing it.
		}
	}
}

// --- signing ---------------------------------------------------------------------

let secret: string = process.env.NATSU_LIVE_SECRET || Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");

/** The key the tags in a page are signed with (default: `NATSU_LIVE_SECRET`, else random per process). */
export function setLiveSecret(next: string): void {
	if (next.length < 16) throw new TypeError("natsu: a live secret is at least 16 characters");
	secret = next;
}

function mac(text: string): string {
	return new Bun.CryptoHasher("sha256", secret).update(text).digest("base64url").slice(0, 27);
}

/** `tags`, signed, as `<meta name="natsu-live">` carries them; "" for none. */
export function signTags(tags: Iterable<string>): string {
	const list = [...new Set(tags)].filter(isTag).sort().slice(0, MAX_TAGS);
	if (list.length === 0) return "";
	const text = list.join(" ");
	return `${text}|${mac(text)}`;
}

/** The tags of a signed list, or null when it was not signed here. */
export function verifyTags(signed: unknown): string[] | null {
	if (typeof signed !== "string" || signed.length > 16384) return null;
	const bar = signed.lastIndexOf("|");
	if (bar < 1) return null;
	const text = signed.slice(0, bar);
	const given = signed.slice(bar + 1);
	const want = mac(text);
	if (given.length !== want.length) return null;
	let diff = 0;
	for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ given.charCodeAt(i);
	if (diff !== 0) return null;
	const tags = text.split(" ");
	return tags.length <= MAX_TAGS && tags.every(isTag) ? tags : null;
}

/** The pub/sub topic a tag's invalidations go to. */
export function tagTopic(tag: string): string {
	return `natsu:tag:${tag}`;
}
