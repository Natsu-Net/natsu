import { describe, expect, test } from "bun:test";
import { parseCookies, serializeCookie } from "../src/context.ts";

describe("serializeCookie refuses what would end the pair or add an attribute", () => {
	test("names", () => {
		for (const name of ["a=b; Domain=evil.com; x", "a b", "a;b", "a\r\nb", "", "a,b", "é", "a(b)"]) {
			expect(() => serializeCookie(name, "v")).toThrow(TypeError);
		}
		expect(serializeCookie("__Host-a.b_c~1!", "v", { secure: true })).toContain("__Host-a.b_c~1!=v");
	});

	test("path and domain", () => {
		expect(() => serializeCookie("a", "v", { path: "/; Domain=evil.com" })).toThrow(TypeError);
		expect(() => serializeCookie("a", "v", { path: "/a\r\nX: 1" })).toThrow(TypeError);
		expect(() => serializeCookie("a", "v", { path: "no-slash" })).toThrow(TypeError);
		expect(() => serializeCookie("a", "v", { domain: "x.com; SameSite=None" })).toThrow(TypeError);
		expect(() => serializeCookie("a", "v", { domain: "x.com\r\nSet-Cookie: b=1" })).toThrow(TypeError);
		expect(serializeCookie("a", "v", { path: "/app", domain: ".example.com" })).toContain("Domain=.example.com; Path=/app");
	});

	test("max-age must be a number", () => {
		expect(() => serializeCookie("a", "v", { maxAge: Number.NaN })).toThrow(TypeError);
		expect(() => serializeCookie("a", "v", { maxAge: Number.POSITIVE_INFINITY })).toThrow(TypeError);
	});

	test("SameSite=None and the cookie prefixes are always Secure", () => {
		expect(serializeCookie("a", "v", { sameSite: "none" })).toContain("; Secure;");
		expect(serializeCookie("__Host-a", "v")).toContain("; Secure;");
		expect(serializeCookie("__Secure-a", "v")).toContain("; Secure;");
	});

	test("__Host- cookies cannot carry a domain or another path", () => {
		expect(() => serializeCookie("__Host-a", "v", { domain: "example.com" })).toThrow(TypeError);
		expect(() => serializeCookie("__Host-a", "v", { path: "/app" })).toThrow(TypeError);
	});

	test("values are encoded", () => {
		expect(serializeCookie("a", "v;\r\nSet-Cookie: x=1")).not.toMatch(/[\r\n]/);
		expect(serializeCookie("a", "v;\r\nSet-Cookie: x=1").split(";")[0]).toBe("a=v%3B%0D%0ASet-Cookie%3A%20x%3D1");
	});
});

describe("parseCookies", () => {
	test("the first of a repeated name wins, as the most specific cookie is sent first", () => {
		expect(parseCookies("a=1; a=2; b=3").get("a")).toBe("1");
		expect(parseCookies("b=3; a=1; a=2").get("a")).toBe("1");
	});

	test("a __proto__ name is a plain key", () => {
		const cookies = parseCookies("__proto__=x; constructor=y");
		expect(cookies.get("__proto__")).toBe("x");
		expect(({} as Record<string, unknown>).x).toBeUndefined();
	});
});

describe("the flash cookie", () => {
	const body = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");

	test("round-trips what the server wrote", async () => {
		const { decodeFlash, encodeFlash } = await import("../src/pages/actions.ts");
		expect(decodeFlash(encodeFlash({ message: "Saved", ok: true }))).toEqual({ message: "Saved", ok: true });
		expect(decodeFlash(encodeFlash({ message: "No", ok: false }))).toEqual({ message: "No", ok: false });
	});

	test("a value nobody signed shows nothing", async () => {
		const { decodeFlash, encodeFlash } = await import("../src/pages/actions.ts");
		const forged = body({ m: "Call 555-0100 to keep your account", ok: true });
		expect(decodeFlash(forged)).toBeNull();
		expect(decodeFlash(`${forged}.`)).toBeNull();
		expect(decodeFlash(`${forged}.${"A".repeat(43)}`)).toBeNull();
		const real = encodeFlash({ message: "Saved", ok: true });
		const mac = real.slice(real.lastIndexOf(".") + 1);
		expect(decodeFlash(`${forged}.${mac}`)).toBeNull();
	});
});
