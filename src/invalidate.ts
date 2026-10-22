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
 * Fan-out is node-local: this process's sockets and its PageCaches (those
 * made with `invalidate: true`, or that `listen()`). Several nodes need a
 * change feed between them, which is not here yet: it plugs into
 * `onInvalidate` (to send this node's invalidations out) and calls
 * `invalidate(tags, { remote: true })` for the ones that come in.
 *
 * An invalidation is `soft` when the data changed but what was shown before
 * may still be shown while it is drawn again (an edited description, not a
 * takedown): a PageCache then serves the old page once more instead of making
 * the next visitor wait. Listeners hear it as `info.soft`; one that ignores it
 * treats every invalidation as a plain one, which is always safe.
 *
 * The tags a page carries are signed so that a socket subscribes to what a
 * page this server drew listed, and nothing else; a page served by one node
 * and a socket held by another need the same secret (`setLiveSecret`, or
 * `NATSU_LIVE_SECRET`).
 */

import { timingSafeEqual } from "node:crypto";
import { config } from "./config.ts";

/** What a tag may be: no spaces, no `|`, a reasonable length. */
const TAG = /^[\w.:/@+=-]{1,160}$/;
/** Most tags one page carries; past it the page is not live. */
export const MAX_TAGS = 64;

/** What else an invalidation says: `soft`, see above. */
export interface InvalidateInfo {
	soft: boolean;
}

export type InvalidateListener = (tags: readonly string[], remote: boolean, info: InvalidateInfo) => void;

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
 * are let go (`soft`: served once more while they are drawn again), and
 * every browser showing one refreshes its regions.
 */
export function invalidate(tags: string | readonly string[], options: { remote?: boolean; soft?: boolean } = {}): void {
	const list = [...new Set(typeof tags === "string" ? [tags] : tags)].filter(isTag);
	if (list.length === 0) return;
	const remote = options.remote === true;
	for (const fn of [...listeners]) {
		try {
			fn(list, remote, { soft: options.soft === true });
		} catch {
			// One listener failing must not keep the others from hearing it.
		}
	}
}

// --- signing ---------------------------------------------------------------------

const FROM_ENV = process.env.NATSU_LIVE_SECRET;
if (FROM_ENV && FROM_ENV.length < 16) throw new TypeError("natsu: NATSU_LIVE_SECRET is at least 16 characters");
let secret: string = FROM_ENV || Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");

/** The key the tags in a page are signed with (default: `NATSU_LIVE_SECRET`, else random per process). */
export function setLiveSecret(next: string): void {
	if (next.length < 16) throw new TypeError("natsu: a live secret is at least 16 characters");
	secret = next;
}

function mac(text: string): string {
	return new Bun.CryptoHasher("sha256", secret).update(text).digest("base64url").slice(0, 27);
}

export function bindTo(domain: string, text: string): string {
	return new Bun.CryptoHasher("sha256", secret).update(`${domain}\0${text}`).digest("base64url");
}

function equal(a: string, b: string): boolean {
	const left = Buffer.from(a);
	const right = Buffer.from(b);
	return left.length === right.length && timingSafeEqual(left, right);
}

function tagMac(scope: string, expires: number, text: string): string {
	return mac(`live\0${scope}\0${expires}\0${text}`);
}

export function liveScope(ctx: { sessionLoaded: boolean; session: { id: string } }): string {
	return ctx.sessionLoaded ? ctx.session.id : "";
}

export function signTags(tags: Iterable<string>, scope = ""): string {
	const list = [...new Set(tags)].filter(isTag).sort().slice(0, MAX_TAGS);
	if (list.length === 0) return "";
	const text = list.join(" ");
	const expires = Math.floor(Date.now() / 1000) + config.General.liveTagTtl;
	return `${text}|${scope ? "s" : "p"}.${expires.toString(36)}.${tagMac(scope, expires, text)}`;
}

export interface CheckedTags {
	tags: string[];
	expired: boolean;
}

export function checkTags(signed: unknown, scope = ""): CheckedTags | null {
	if (typeof signed !== "string" || signed.length > 16384) return null;
	const bar = signed.lastIndexOf("|");
	if (bar < 1) return null;
	const text = signed.slice(0, bar);
	const parts = signed.slice(bar + 1).split(".");
	if (parts.length !== 3) return null;
	const [kind, stamp, given] = parts as [string, string, string];
	if ((kind !== "p" && kind !== "s") || !/^[0-9a-z]{1,10}$/.test(stamp)) return null;
	if (kind === "s" && !scope) return null;
	const expires = parseInt(stamp, 36);
	if (!equal(given, tagMac(kind === "s" ? scope : "", expires, text))) return null;
	const tags = text.split(" ");
	if (tags.length > MAX_TAGS || !tags.every(isTag)) return null;
	return { tags, expired: expires < Math.floor(Date.now() / 1000) };
}

export function verifyTags(signed: unknown, scope = ""): string[] | null {
	const checked = checkTags(signed, scope);
	return checked && !checked.expired ? checked.tags : null;
}

/** The pub/sub topic a tag's invalidations go to. */
export function tagTopic(tag: string): string {
	return `natsu:tag:${tag}`;
}
