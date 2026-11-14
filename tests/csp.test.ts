import { describe, expect, test } from "bun:test";
import { scriptNonce, styleNonce, stylePolicy } from "../src/csp.ts";

describe("stylePolicy", () => {
	test("no header or no style directive allows inline styles", () => {
		expect(stylePolicy(null)).toEqual({ allowed: true });
		expect(stylePolicy(undefined)).toEqual({ allowed: true });
		expect(stylePolicy("")).toEqual({ allowed: true });
		expect(stylePolicy("script-src 'self'; img-src *")).toEqual({ allowed: true });
	});

	test("unsafe-inline alone allows, a nonce is returned, self alone refuses", () => {
		expect(stylePolicy("style-src 'self' 'unsafe-inline'")).toEqual({ allowed: true });
		expect(stylePolicy("style-src 'self' 'nonce-abc123'")).toEqual({ allowed: true, nonce: "abc123" });
		expect(stylePolicy("style-src 'self'")).toEqual({ allowed: false });
		expect(stylePolicy("style-src 'none'")).toEqual({ allowed: false });
	});

	test("a nonce or hash switches unsafe-inline off", () => {
		expect(stylePolicy("style-src 'unsafe-inline' 'nonce-n1'")).toEqual({ allowed: true, nonce: "n1" });
		expect(stylePolicy("style-src 'unsafe-inline' 'sha256-AAAA'")).toEqual({ allowed: false });
	});

	test("style-src-elem beats style-src beats default-src, first directive of a name counts", () => {
		expect(stylePolicy("default-src 'self'; style-src 'nonce-b'; style-src-elem 'nonce-a'")).toEqual({ allowed: true, nonce: "a" });
		expect(stylePolicy("default-src 'nonce-d'; style-src 'nonce-b'")).toEqual({ allowed: true, nonce: "b" });
		expect(stylePolicy("default-src 'nonce-d'")).toEqual({ allowed: true, nonce: "d" });
		expect(stylePolicy("default-src 'self'")).toEqual({ allowed: false });
		expect(stylePolicy("style-src 'self'; style-src 'nonce-late'")).toEqual({ allowed: false });
		expect(stylePolicy("STYLE-SRC 'NONCE-Mixed'")).toEqual({ allowed: true, nonce: "Mixed" });
	});

	test("a script nonce is not a style nonce", () => {
		const header = "script-src 'nonce-s'; style-src 'self'";
		expect(scriptNonce(header)).toBe("s");
		expect(stylePolicy(header)).toEqual({ allowed: false });
		expect(styleNonce(header)).toBeUndefined();
	});

	test("several policies must all allow the same nonce", () => {
		expect(stylePolicy("style-src 'nonce-a', style-src 'nonce-a' 'nonce-b'")).toEqual({ allowed: true, nonce: "a" });
		expect(stylePolicy("style-src 'nonce-a', style-src 'nonce-b'")).toEqual({ allowed: false });
		expect(stylePolicy("style-src 'unsafe-inline', style-src 'nonce-b'")).toEqual({ allowed: true, nonce: "b" });
		expect(stylePolicy("style-src 'nonce-a', style-src 'self'")).toEqual({ allowed: false });
		expect(stylePolicy("script-src 'self', img-src *")).toEqual({ allowed: true });
	});

	test("a malformed nonce source is not a nonce", () => {
		expect(stylePolicy(`style-src 'nonce-a"b'`)).toEqual({ allowed: false });
		expect(stylePolicy("style-src 'nonce-'")).toEqual({ allowed: false });
	});

	test("styleNonce returns the nonce and scriptNonce is unchanged", () => {
		expect(styleNonce("style-src 'nonce-xyz'")).toBe("xyz");
		expect(styleNonce(null)).toBeUndefined();
		expect(scriptNonce("default-src 'nonce-q'")).toBe("q");
		expect(scriptNonce(null)).toBeUndefined();
	});
});
