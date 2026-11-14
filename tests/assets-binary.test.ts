import { describe, expect, test } from "bun:test";
import { contentHash, hashedName, mediaType, rewriteCssUrls } from "../src/assets/binary.ts";

describe("mediaType", () => {
	test("text types are served with their charset and compressed", () => {
		expect(mediaType("site.css")).toEqual({ type: "text/css; charset=utf-8", binary: false, compress: true });
		expect(mediaType("a/b/app.js")).toEqual({ type: "text/javascript; charset=utf-8", binary: false, compress: true });
		expect(mediaType("app.mjs")?.type).toBe("text/javascript; charset=utf-8");
		expect(mediaType("data.json")?.type).toBe("application/json; charset=utf-8");
		expect(mediaType("app.js.map")?.type).toBe("application/json; charset=utf-8");
		expect(mediaType("logo.svg")).toEqual({ type: "image/svg+xml", binary: false, compress: true });
		expect(mediaType("robots.txt")?.type).toBe("text/plain; charset=utf-8");
		expect(mediaType("site.webmanifest")?.type).toBe("application/manifest+json");
	});

	test("binary types skip compression when they are already packed", () => {
		for (const [file, type] of [
			["a.woff2", "font/woff2"],
			["a.woff", "font/woff"],
			["a.png", "image/png"],
			["a.jpg", "image/jpeg"],
			["a.jpeg", "image/jpeg"],
			["a.gif", "image/gif"],
			["a.webp", "image/webp"],
			["a.avif", "image/avif"],
			["a.mp3", "audio/mpeg"],
			["a.ogg", "audio/ogg"],
		] as const) {
			expect(mediaType(file)).toEqual({ type, binary: true, compress: false });
		}
		for (const [file, type] of [
			["a.ttf", "font/ttf"],
			["a.otf", "font/otf"],
			["a.ico", "image/x-icon"],
			["a.wasm", "application/wasm"],
		] as const) {
			expect(mediaType(file)).toEqual({ type, binary: true, compress: true });
		}
	});

	test("the extension is read from the last segment, any case", () => {
		expect(mediaType("FONT.WOFF2")?.type).toBe("font/woff2");
		expect(mediaType("dir.css/file")).toBeUndefined();
		expect(mediaType("dir.css\\file")).toBeUndefined();
	});

	test("anything outside the list is unknown", () => {
		for (const file of ["page.html", "page.htm", "a.php", "a.exe", "a.ts", "noext", "a.", ".css.bak", "a.xml"]) {
			expect(mediaType(file)).toBeUndefined();
		}
	});

	test("a caller cannot change the table through a result", () => {
		const first = mediaType("a.png");
		if (first) first.type = "text/html";
		expect(mediaType("a.png")?.type).toBe("image/png");
	});
});

describe("contentHash and hashedName", () => {
	test("a string hashes as it did before: sha256 hex, first ten", () => {
		const body = "body { margin: 0; }\n";
		const before = new Bun.CryptoHasher("sha256").update(body).digest("hex").slice(0, 10);
		expect(contentHash(body)).toBe(before);
		expect(contentHash(body)).toMatch(/^[0-9a-f]{10}$/);
	});

	test("a string and its UTF-8 bytes hash the same", () => {
		const body = "/* é ✓ */ .a{color:red}";
		expect(contentHash(new TextEncoder().encode(body))).toBe(contentHash(body));
	});

	test("bytes that are not text hash by content", () => {
		const a = new Uint8Array([0, 255, 128, 13, 10, 0]);
		const b = new Uint8Array([0, 255, 128, 13, 10, 1]);
		expect(contentHash(a)).toBe(contentHash(new Uint8Array(a)));
		expect(contentHash(a)).not.toBe(contentHash(b));
	});

	test("the name carries the hash between name and extension", () => {
		const body = new Uint8Array([1, 2, 3]);
		expect(hashedName("font-inter", body, ".woff2")).toBe(`font-inter.${contentHash(body)}.woff2`);
		expect(hashedName("font-inter", body, "woff2")).toBe(`font-inter.${contentHash(body)}.woff2`);
		expect(hashedName("raw", "x", "")).toBe(`raw.${contentHash("x")}`);
	});
});

describe("rewriteCssUrls", () => {
	const known: Record<string, string> = {
		"/fonts/inter.woff2": "/_a/inter.1234567890.woff2",
		"/img/bg.png": "/_a/bg.abcdefabcd.png",
		"/css/other.css": "/_a/other.0000000000.css",
	};
	const resolve = (target: string): string | undefined => known[target];

	test("a known target is replaced, quotes kept", () => {
		const css = `@font-face{src:url(/fonts/inter.woff2) format("woff2")}.a{background:url("/img/bg.png")}.b{background:url( '/img/bg.png' )}`;
		expect(rewriteCssUrls(css, { resolve })).toBe(
			`@font-face{src:url(/_a/inter.1234567890.woff2) format("woff2")}.a{background:url("/_a/bg.abcdefabcd.png")}.b{background:url( '/_a/bg.abcdefabcd.png' )}`,
		);
	});

	test("query and fragment are kept on the new URL", () => {
		const css = `.a{src:url("/fonts/inter.woff2?v=3#iefix")}.b{mask:url(/img/bg.png#m)}`;
		expect(rewriteCssUrls(css, { resolve })).toBe(`.a{src:url("/_a/inter.1234567890.woff2?v=3#iefix")}.b{mask:url(/_a/bg.abcdefabcd.png#m)}`);
	});

	test("an unknown target is left byte for byte", () => {
		const css = `.a{background:url(/img/none.png)}.b{background:URL( "/x.png" )}`;
		expect(rewriteCssUrls(css, { resolve })).toBe(css);
	});

	test("string @import is rewritten, url() @import too", () => {
		const css = `@import "/css/other.css" screen;@import url(/css/other.css);@IMPORT '/css/other.css';`;
		expect(rewriteCssUrls(css, { resolve })).toBe(`@import "/_a/other.0000000000.css" screen;@import url(/_a/other.0000000000.css);@IMPORT '/_a/other.0000000000.css';`);
	});

	test("data, fragment and absolute targets reach resolve unchanged and stay when it declines", () => {
		const seen: string[] = [];
		const css = `.a{background:url(data:image/png;base64,AAAA?x#y)}.b{filter:url(#blur)}.c{background:url(https://cdn.example/a.png?v=1)}.d{background:url(//cdn.example/b.png)}`;
		const out = rewriteCssUrls(css, {
			resolve: (target) => {
				seen.push(target);
				return undefined;
			},
		});
		expect(out).toBe(css);
		expect(seen).toEqual(["data:image/png;base64,AAAA?x#y", "#blur", "https://cdn.example/a.png?v=1", "//cdn.example/b.png"]);
	});

	test("comments and strings outside url() are not touched", () => {
		const css = `/* url(/img/bg.png) @import "/css/other.css" */.a::before{content:"url(/img/bg.png)"}.b{content:'@import "/css/other.css"'}.c{background:url(/img/bg.png)}`;
		expect(rewriteCssUrls(css, { resolve })).toBe(
			`/* url(/img/bg.png) @import "/css/other.css" */.a::before{content:"url(/img/bg.png)"}.b{content:'@import "/css/other.css"'}.c{background:url(/_a/bg.abcdefabcd.png)}`,
		);
	});

	test("a relative target is resolved against the base", () => {
		const css = `.a{background:url(../img/bg.png)}.b{src:url("inter.woff2")}.c{src:url(./x/../inter.woff2?v=1)}`;
		const seen: string[] = [];
		const out = rewriteCssUrls(css, {
			base: "/fonts/site.css",
			resolve: (target) => {
				seen.push(target);
				return known[target];
			},
		});
		expect(seen).toEqual(["/img/bg.png", "/fonts/inter.woff2", "/fonts/inter.woff2"]);
		expect(out).toBe(`.a{background:url(/_a/bg.abcdefabcd.png)}.b{src:url("/_a/inter.1234567890.woff2")}.c{src:url(/_a/inter.1234567890.woff2?v=1)}`);
	});

	test("without a base a relative target is handed over as written", () => {
		const seen: string[] = [];
		rewriteCssUrls(`.a{background:url(img/bg.png?x)}`, {
			resolve: (target) => {
				seen.push(target);
				return undefined;
			},
		});
		expect(seen).toEqual(["img/bg.png"]);
	});

	test("a replacement that needs escaping stays inside its token", () => {
		const out = rewriteCssUrls(`.a{background:url(/img/bg.png)}.b{background:url("/img/bg.png")}`, { resolve: () => `/x y/"q")z.png` });
		expect(out).toBe(`.a{background:url(/x\\ y/\\"q\\"\\)z.png)}.b{background:url("/x y/\\"q\\")z.png")}`);
	});

	test("escaped characters in a target are read before resolving", () => {
		const seen: string[] = [];
		rewriteCssUrls(`.a{background:url(/img/b\\67 .png)}.b{background:url("/img/a\\ b.png")}`, {
			resolve: (target) => {
				seen.push(target);
				return undefined;
			},
		});
		expect(seen).toEqual(["/img/bg.png", "/img/a b.png"]);
	});

	test("an identifier that only ends in url is not a url()", () => {
		const css = `.a{background:myurl(/img/bg.png)}.b{--x:curl(/img/bg.png)}`;
		expect(rewriteCssUrls(css, { resolve })).toBe(css);
	});

	test("malformed input is returned as it came", () => {
		for (const css of [`.a{background:url(/img/bg.png`, `.a{background:url("/img/bg.png`, `/* never closed url(/img/bg.png)`, `.a{content:"open`, `@import`, `@import "`, `url(`, `url()`, ""]) {
			expect(rewriteCssUrls(css, { resolve })).toBe(css);
		}
	});

	test("a long hostile sheet is handled in linear time", () => {
		const css = `${"url(".repeat(50_000)}${'@import "'.repeat(50_000)}${"/*".repeat(50_000)}`;
		const started = performance.now();
		expect(rewriteCssUrls(css, { resolve })).toBe(css);
		expect(performance.now() - started).toBeLessThan(2000);
	});
});
