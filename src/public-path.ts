/**
 * Resolve a request path inside the static document root — or refuse it.
 *
 * ## What was wrong
 *
 * `web.ts` used to sanitise the path with a single
 * `.replace(/\/\.\.\//g, "/")`. That is one non-overlapping pass, and
 * consecutive `../` sequences share a slash, so one always survives it. The
 * string that came out still contained `..`, and the *filesystem* resolved
 * that:
 *
 *   /../../config.json        ->  <cwd>/public//../config.json  ->  <cwd>/config.json
 *   /../../../../config.json  ->  ...                           ->  <cwd>/../config.json
 *
 * Every doubled pair climbed one directory, and `config.json` — which holds
 * the database password — sits in the working directory. The guard made it
 * worse: `exists()` was called on the *unfiltered* path while the read used
 * the filtered one, so the check and the read were about different files.
 *
 * ## Why this shape
 *
 * Filtering a path is the wrong idea at any level of cleverness — there is
 * always another spelling. This walks the segments instead and refuses to pop
 * above the root, so there is nothing left to out-spell: `..`, `%2e%2e`,
 * doubled slashes and empty segments all reduce to the same walk.
 *
 * Deliberately free of imports so it can be exercised by a test runner that is
 * not Deno; `v2/tests/v1-public-path.test.ts` is that test.
 */

/**
 * @param root Absolute path of the document root, with no trailing slash.
 * @param pathname The request's URL path, percent-encoded as it arrived.
 * @returns The absolute path to serve, or undefined if the request does not
 *   name a file inside `root`.
 */
export function resolvePublicPath(root: string, pathname: string): string | undefined {
	let decoded: string;
	try {
		decoded = decodeURIComponent(pathname);
	} catch {
		// A malformed percent escape is not a file name.
		return undefined;
	}
	// A NUL truncates the path inside the syscall, which can hide a suffix.
	if (decoded.includes("\0")) return undefined;

	const segments: string[] = [];
	for (const segment of decoded.split(/[/\\]/)) {
		if (segment === "" || segment === ".") continue;
		if (segment === "..") {
			// Climbing out of the document root is the whole attack.
			if (segments.length === 0) return undefined;
			segments.pop();
			continue;
		}
		segments.push(segment);
	}

	// No segments left means the request was for the root itself, which is a
	// directory rather than something to send.
	if (segments.length === 0) return undefined;
	return `${root}/${segments.join("/")}`;
}
