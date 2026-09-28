/**
 * The containment check that natsu v1's static handler runs on every request.
 *
 * v1 is Deno and cannot be loaded here, but `src/public-path.ts` is
 * deliberately import-free so the one implementation both sides use can be
 * exercised by a test runner. This lives under v2 because that is where the
 * test runner is, not because it is about v2.
 */

import { describe, expect, test } from "bun:test";
import { resolvePublicPath } from "../../src/public-path.ts";

const ROOT = "/srv/app/public";

/** What v1 did before the fix, reproduced so the hole is on the record. */
function oldFilter(pathname: string): string {
	return `/srv/app/public/${pathname}`.replace(/\/\.\.\//g, "/");
}

/** Resolve a path the way the kernel would, for the comparison above. */
function collapse(path: string): string {
	const out: string[] = [];
	for (const segment of path.split("/")) {
		if (segment === "" || segment === ".") continue;
		if (segment === "..") out.pop();
		else out.push(segment);
	}
	return `/${out.join("/")}`;
}

describe("the hole this replaced", () => {
	test("one non-overlapping pass always leaves a `..` behind", () => {
		// The filtered string still contains `..`, and the filesystem — not the
		// regex — has the last word on what that means.
		expect(oldFilter("/../../config.json")).toContain("..");
		expect(collapse(oldFilter("/../../config.json"))).toBe("/srv/app/config.json");
		expect(collapse(oldFilter("/../../../../config.json"))).toBe("/srv/config.json");
	});
});

describe("resolvePublicPath", () => {
	test("refuses every spelling of climbing out", () => {
		for (const attack of [
			"/../../config.json",
			"/../../../../config.json",
			"/../config.json",
			"/..%2f..%2fconfig.json",
			"/%2e%2e%2f%2e%2e%2fconfig.json",
			"/a/../../config.json",
			"/./../.././config.json",
			"//../config.json",
			"/..\\..\\config.json",
			"/%00/../config.json",
		]) {
			expect(resolvePublicPath(ROOT, attack)).toBeUndefined();
		}
	});

	test("refuses a NUL and a malformed escape", () => {
		expect(resolvePublicPath(ROOT, "/foo\0.png")).toBeUndefined();
		expect(resolvePublicPath(ROOT, "/%ff%")).toBeUndefined();
	});

	test("refuses the document root itself, which is a directory", () => {
		expect(resolvePublicPath(ROOT, "/")).toBeUndefined();
		expect(resolvePublicPath(ROOT, "//")).toBeUndefined();
		expect(resolvePublicPath(ROOT, "/./")).toBeUndefined();
	});

	test("serves ordinary files unchanged", () => {
		expect(resolvePublicPath(ROOT, "/css/app.css")).toBe("/srv/app/public/css/app.css");
		expect(resolvePublicPath(ROOT, "/deep/a/b/c.js")).toBe("/srv/app/public/deep/a/b/c.js");
		expect(resolvePublicPath(ROOT, "/img/a%20b.png")).toBe("/srv/app/public/img/a b.png");
		expect(resolvePublicPath(ROOT, "/favicon.ico")).toBe("/srv/app/public/favicon.ico");
	});

	test("a `..` that stays inside is still allowed", () => {
		expect(resolvePublicPath(ROOT, "/css/../img/x.png")).toBe("/srv/app/public/img/x.png");
	});

	test("a filename that merely starts with dots is a filename", () => {
		expect(resolvePublicPath(ROOT, "/...hidden")).toBe("/srv/app/public/...hidden");
		expect(resolvePublicPath(ROOT, "/..foo/bar")).toBe("/srv/app/public/..foo/bar");
	});
});
