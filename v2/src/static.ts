/**
 * Static files.
 *
 * v1 read the whole file into a `Uint8Array`, kept it in a TTL cache, and
 * guarded the path with `.replace(/\/\.\.\//g, "/")` — a filter that misses
 * `%2e%2e/`, `....//`, a trailing `/..`, and symlinks pointing out of the root.
 * Both halves are replaced here:
 *
 *   - `Bun.file()` is handed to `Bun.serve`, which sends it with `sendfile(2)`.
 *     The bytes never enter the heap, so there is nothing to cache.
 *   - The path is resolved against the root and the *result* is checked for
 *     containment, which is the only form of this check that holds.
 */

import { realpathSync, statSync, type Stats } from "node:fs";
import { resolve, sep } from "node:path";
import type { Context } from "./context.ts";
import { Cache } from "./cache.ts";
import type { NatsuConfig } from "./config.ts";
import { staticRoot } from "./config.ts";

export interface StaticOptions {
	root: string;
	maxAge?: number;
	etag?: boolean;
	lastModified?: boolean;
	/** File served for a directory; empty disables directory handling. */
	index?: string;
	/** Serve paths with a dot-prefixed segment (`.env`, `.git/config`). */
	dotfiles?: boolean;
	/** When false, a symlink leaving the root is refused. */
	followSymlinks?: boolean;
	/** Cache path resolution (not file bytes) for this many seconds; 0 disables. */
	resolveCacheTTL?: number;
}

export type RejectReason = "escape" | "dotfile" | "malformed";

/** A few types Bun gets wrong or vague for the web. */
const MIME_OVERRIDES: Readonly<Record<string, string>> = {
	".svg": "image/svg+xml",
	".mjs": "text/javascript; charset=utf-8",
	".map": "application/json; charset=utf-8",
	".xyz": "text/plain; charset=utf-8",
	".nnt": "text/plain; charset=utf-8",
	".uwu": "text/plain; charset=utf-8",
};

function statOf(path: string): Stats | undefined {
	try {
		return statSync(path, { throwIfNoEntry: false });
	} catch {
		// EACCES, ELOOP and friends: not readable is the same as not there.
		return undefined;
	}
}

function extname(path: string): string {
	const slash = path.lastIndexOf("/");
	const dot = path.lastIndexOf(".");
	return dot > slash ? path.slice(dot).toLowerCase() : "";
}

export interface ResolvedFile {
	path: string;
}

export class StaticFiles {
	public readonly root: string;
	public readonly options: Required<Omit<StaticOptions, "root">>;

	/**
	 * pathname -> absolute file path. Only successful resolutions are cached:
	 * caching a miss would mean a file added at runtime stays 404 until the TTL
	 * expires, which in development is indistinguishable from a bug.
	 */
	private readonly resolved: Cache<string> | undefined;

	constructor(options: StaticOptions) {
		this.root = resolve(options.root);
		this.options = {
			maxAge: options.maxAge ?? 0,
			etag: options.etag ?? true,
			lastModified: options.lastModified ?? true,
			index: options.index ?? "",
			dotfiles: options.dotfiles ?? false,
			followSymlinks: options.followSymlinks ?? false,
			resolveCacheTTL: options.resolveCacheTTL ?? 0,
		};
		this.resolved = this.options.resolveCacheTTL > 0 ? new Cache<string>(this.options.resolveCacheTTL) : undefined;
	}

	static fromConfig(config: NatsuConfig, cwd?: string): StaticFiles {
		return new StaticFiles({
			root: staticRoot(config, cwd),
			maxAge: config.Static.maxAge,
			etag: config.Static.etag,
			lastModified: config.Static.lastModified,
			index: config.Static.index,
			dotfiles: config.Static.dotfiles,
			followSymlinks: config.Static.followSymlinks,
			resolveCacheTTL: config.Cache.enablePublicCache ? config.Cache.publicCacheTTL : 0,
		});
	}

	/**
	 * Map a URL pathname to an absolute path inside the root, or explain why it
	 * cannot be one. Nothing here touches the filesystem except the optional
	 * symlink check.
	 */
	public resolvePath(pathname: string): { path: string } | { rejected: RejectReason } {
		let decoded: string;
		try {
			// A single decode, then no further normalisation of the *text*: the
			// answer comes from resolve(), so `%2e%2e%2f` and `..%2f` both end
			// up as the same absolute path and are judged there.
			decoded = decodeURIComponent(pathname);
		} catch {
			return { rejected: "malformed" };
		}

		// A NUL truncates the path at the syscall boundary — never let one through.
		if (decoded.includes("\0")) return { rejected: "malformed" };

		const target = resolve(this.root, `.${decoded.startsWith("/") ? decoded : `/${decoded}`}`);
		if (!this.contains(target)) return { rejected: "escape" };

		if (!this.options.dotfiles) {
			const relative = target.slice(this.root.length);
			for (const segment of relative.split(sep)) {
				if (segment.startsWith(".") && segment !== "") return { rejected: "dotfile" };
			}
		}

		if (!this.options.followSymlinks) {
			try {
				// realpath only answers for paths that exist; a miss is handled
				// later as a plain 404.
				const real = realpathSync(target);
				if (!this.contains(real)) return { rejected: "escape" };
			} catch {
				// ENOENT here means "no such file", not "unsafe".
			}
		}

		return { path: target };
	}

	private contains(path: string): boolean {
		return path === this.root || path.startsWith(this.root + sep);
	}

	/**
	 * Answer the request from disk if possible.
	 *
	 * Returns true when it wrote a response (including 304/403/416) and false
	 * when the path is simply not a file here, so the caller can carry on.
	 */
	public async serve(ctx: Context): Promise<boolean> {
		const method = ctx.method;
		if (method !== "GET" && method !== "HEAD") return false;

		const pathname = ctx.path;
		const cached = this.resolved?.get(pathname);
		let filePath: string;

		if (typeof cached === "string") {
			filePath = cached;
		} else {
			const outcome = this.resolvePath(pathname);
			if ("rejected" in outcome) {
				// Say the same thing for "outside the root" as for "absent":
				// a 403 on `/../../etc/passwd` confirms the layout to whoever
				// asked. Malformed encoding is the client's own bug, so it gets
				// a 400.
				if (outcome.rejected === "malformed") {
					ctx.response.status = 400;
					ctx.response.body = "Bad Request";
					return true;
				}
				return false;
			}
			filePath = outcome.path;
		}

		// Deliberately the synchronous stat: Bun's async `file.stat()` hops to
		// the thread pool and measures ~36µs per call against ~1.3µs here, and
		// a static request is otherwise ~70µs end to end. Blocking the loop for
		// a microsecond is the cheaper of the two.
		let stat = statOf(filePath);

		if (stat?.isDirectory()) {
			if (!this.options.index) return false;
			filePath = resolve(filePath, this.options.index);
			if (!this.contains(filePath)) return false;
			stat = statOf(filePath);
		}

		if (!stat || !stat.isFile()) return false;

		this.resolved?.set(pathname, filePath);

		const file = Bun.file(filePath);
		const { headers } = ctx.response;
		headers.set("Content-Type", MIME_OVERRIDES[extname(filePath)] ?? file.type ?? "application/octet-stream");
		headers.set("Accept-Ranges", "bytes");

		const mtime = Math.floor(stat.mtimeMs);
		const etag = this.options.etag ? `W/"${stat.size.toString(16)}-${mtime.toString(16)}"` : undefined;
		if (etag) headers.set("ETag", etag);
		if (this.options.lastModified) headers.set("Last-Modified", new Date(mtime).toUTCString());
		if (this.options.maxAge > 0) {
			headers.set("Cache-Control", `public, max-age=${this.options.maxAge}`);
			headers.set("Expires", new Date(Date.now() + this.options.maxAge * 1000).toUTCString());
		}

		if (isFresh(ctx, etag, mtime)) {
			ctx.response.status = 304;
			ctx.response.body = null;
			return true;
		}

		const range = parseRange(ctx.request.headers.get("range"), stat.size);
		if (range === "unsatisfiable") {
			ctx.response.status = 416;
			headers.set("Content-Range", `bytes */${stat.size}`);
			ctx.response.body = null;
			return true;
		}

		if (range) {
			ctx.response.status = 206;
			headers.set("Content-Range", `bytes ${range.start}-${range.end}/${stat.size}`);
			// slice() keeps the file descriptor: still no bytes on the heap.
			ctx.response.body = file.slice(range.start, range.end + 1);
			return true;
		}

		ctx.response.status = 200;
		ctx.response.body = file;
		return true;
	}
}

/** RFC 9110 conditional request handling: ETag wins over the date. */
function isFresh(ctx: Context, etag: string | undefined, mtime: number): boolean {
	const ifNoneMatch = ctx.request.headers.get("if-none-match");
	if (ifNoneMatch && etag) {
		if (ifNoneMatch.trim() === "*") return true;
		for (const candidate of ifNoneMatch.split(",")) {
			// Weak comparison: `W/"x"` and `"x"` are the same entity here.
			const value = candidate.trim().replace(/^W\//, "");
			if (value === etag.replace(/^W\//, "")) return true;
		}
		return false;
	}

	const ifModifiedSince = ctx.request.headers.get("if-modified-since");
	if (ifModifiedSince) {
		const since = Date.parse(ifModifiedSince);
		// HTTP dates have one-second resolution; compare at that resolution or
		// a file written twice in the same second looks unchanged.
		if (!Number.isNaN(since) && Math.floor(mtime / 1000) * 1000 <= since) return true;
	}

	return false;
}

export function parseRange(header: string | null, size: number): { start: number; end: number } | "unsatisfiable" | undefined {
	if (!header) return undefined;
	const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
	// Multi-range is legal and rare; declining it (by serving the whole file)
	// is allowed and keeps the response single-part.
	if (!match) return undefined;

	const [, rawStart = "", rawEnd = ""] = match;
	if (rawStart === "" && rawEnd === "") return undefined;

	if (rawStart === "") {
		const length = Number(rawEnd);
		if (length === 0) return "unsatisfiable";
		const start = Math.max(0, size - length);
		return { start, end: size - 1 };
	}

	const start = Number(rawStart);
	if (start >= size) return "unsatisfiable";
	const end = rawEnd === "" ? size - 1 : Math.min(Number(rawEnd), size - 1);
	if (end < start) return "unsatisfiable";
	return { start, end };
}
