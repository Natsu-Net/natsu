/**
 * Response compression: brotli where the client takes it, gzip where it
 * does not, nothing for bodies that would not shrink.
 *
 * Text on the web compresses four to six times over, and a server that sends
 * it raw is making every visitor download the difference. Three kinds of body
 * come through here and each is treated by how often it changes:
 *
 *  - **Files** (`Bun.file`, from the static handler) change only on deploy,
 *    so each is compressed once at brotli's highest level and kept, keyed by
 *    its path, size and mtime.
 *  - **Immutable strings** — a response that says `immutable` in its
 *    `Cache-Control`, which is how `Assets` serves hashed chunks — are the
 *    same: compressed once, at the top level, and kept by content.
 *  - **Everything else** is a page rendered for this request, so it is
 *    compressed at a level that costs well under a millisecond for a page.
 *
 *   app.use(compress());
 *
 * It has to be the outermost middleware that touches bodies, so register it
 * before anything that writes one.
 */

import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import type { Context, Middleware } from "./context.ts";

export interface CompressOptions {
	/** Bodies smaller than this go out as they are. A packet is ~1400 bytes. */
	threshold?: number;
	/** Brotli quality for per-request bodies (0–11). */
	dynamicQuality?: number;
	/** How many compressed files and immutable bodies to keep. */
	cacheEntries?: number;
}

/** Types worth compressing. Images, fonts and video are compressed already. */
const COMPRESSIBLE = /^(text\/|application\/(json|javascript|xml|manifest\+json|ld\+json)|image\/svg\+xml)/;

type Encoding = "br" | "gzip";

/** What the client will accept, brotli first. `q=0` is a refusal. */
export function negotiate(header: string | null): Encoding | undefined {
	if (!header) return undefined;
	const accepted = new Set<string>();
	for (const part of header.toLowerCase().split(",")) {
		const [name = "", ...params] = part.trim().split(";");
		const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
		if (q && Number(q.slice(2)) === 0) continue;
		accepted.add(name.trim());
	}
	if (accepted.has("br")) return "br";
	if (accepted.has("gzip")) return "gzip";
	return undefined;
}

function encode(bytes: Uint8Array, encoding: Encoding, quality: number): Uint8Array {
	if (encoding === "gzip") return gzipSync(bytes, { level: quality >= 11 ? 9 : 6 });
	return brotliCompressSync(bytes, {
		params: {
			[constants.BROTLI_PARAM_QUALITY]: quality,
			[constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
			[constants.BROTLI_PARAM_SIZE_HINT]: bytes.length,
		},
	});
}

/** A small LRU: a Map keeps insertion order, so the first key is the oldest. */
class Held {
	private readonly map = new Map<string, Uint8Array>();
	constructor(private readonly limit: number) {}
	get(key: string): Uint8Array | undefined {
		const hit = this.map.get(key);
		if (hit) {
			this.map.delete(key);
			this.map.set(key, hit);
		}
		return hit;
	}
	set(key: string, value: Uint8Array): void {
		this.map.set(key, value);
		if (this.map.size > this.limit) this.map.delete(this.map.keys().next().value as string);
	}
}

export function compress(options: CompressOptions = {}): Middleware {
	const threshold = options.threshold ?? 1024;
	const dynamicQuality = options.dynamicQuality ?? 5;
	const held = new Held(options.cacheEntries ?? 512);

	return async (ctx: Context, next: () => Promise<void>): Promise<void> => {
		await next();

		const encoding = negotiate(ctx.request.headers.get("accept-encoding"));
		if (!encoding || ctx.method === "HEAD") return;

		const response = ctx.response;
		const status = response.status;
		if (status !== 200 && status !== 404 && status !== 403) return;

		const body = response.body;
		if (body === undefined || body === null || body instanceof Response || body instanceof ReadableStream) return;

		const headers = response.headers;
		if (headers.has("content-encoding") || headers.has("content-range")) return;

		const type = headers.get("content-type") ?? defaultType(body);
		if (!COMPRESSIBLE.test(type)) return;

		let bytes: Uint8Array;
		let key: string | undefined;
		if (typeof body === "string") {
			bytes = new TextEncoder().encode(body);
			if ((headers.get("cache-control") ?? "").includes("immutable")) key = `s:${Bun.hash(bytes).toString(36)}:${bytes.length}`;
		} else if (isFile(body)) {
			const stat = await body.stat().catch(() => undefined);
			if (!stat) return;
			key = `f:${body.name}:${stat.size}:${stat.mtimeMs}`;
			const hit = held.get(`${key}:${encoding}`);
			if (hit) return send(ctx, hit, encoding, type);
			bytes = new Uint8Array(await body.arrayBuffer());
		} else if (body instanceof Uint8Array) {
			bytes = body;
		} else if (body instanceof ArrayBuffer) {
			bytes = new Uint8Array(body);
		} else if (typeof body === "object" && !(body instanceof Blob) && !ArrayBuffer.isView(body) && !(body instanceof FormData) && !(body instanceof URLSearchParams)) {
			// A plain object is JSON on the way out; stringify it here so it
			// can be compressed, with the type toResponse() would have given it.
			bytes = new TextEncoder().encode(JSON.stringify(body));
		} else {
			return;
		}

		if (bytes.length < threshold) return;

		if (key) {
			const hit = held.get(`${key}:${encoding}`);
			if (hit) return send(ctx, hit, encoding, type);
		}

		const out = encode(bytes, encoding, key ? 11 : dynamicQuality);
		// Brotli can lose on something already dense; never send more.
		if (out.length >= bytes.length) return;
		if (key) held.set(`${key}:${encoding}`, out);
		send(ctx, out, encoding, type);
	};
}

function send(ctx: Context, bytes: Uint8Array, encoding: Encoding, type: string): void {
	const headers = ctx.response.headers;
	headers.set("content-encoding", encoding);
	headers.append("vary", "Accept-Encoding");
	// A compressed body is not the file on disk, so byte ranges into it
	// would be ranges into the wrong thing.
	headers.delete("accept-ranges");
	headers.delete("content-length");
	if (!headers.has("content-type")) headers.set("content-type", type);
	ctx.response.body = bytes as Uint8Array<ArrayBuffer>;
}

/** The type `toResponse()` would give a body that names none. */
function defaultType(body: unknown): string {
	if (typeof body === "string") return body.startsWith("<") ? "text/html; charset=utf-8" : "text/plain; charset=utf-8";
	if (isFile(body)) return body.type;
	if (body instanceof Blob || body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return "";
	return "application/json; charset=utf-8";
}

function isFile(body: unknown): body is ReturnType<typeof Bun.file> {
	return body instanceof Blob && typeof (body as { name?: unknown }).name === "string" && typeof (body as { stat?: unknown }).stat === "function";
}
