import { describe, expect, test } from "bun:test";
import { sameSitePath } from "../src/pages/actions.ts";

describe("sameSitePath", () => {
	test.each(["//evil.com", "/\\evil.com", "/\t/evil.com", "/\n/evil.com", "/\r/evil.com", "\\\\evil.com", "https://evil.com", "javascript:alert(1)", "evil.com", "", "/\u0000", "/\u007f/", "/\ud800"])(
		"refuses %j",
		(target) => {
			expect(sameSitePath(target)).toBeNull();
		},
	);

	test.each(["/", "/a/b?c=d#e", "/%2f/evil.com", "/%5cevil.com", "/.//evil.com", "/ok/../fine"])("keeps %j on this site", (target) => {
		const out = sameSitePath(target)!;
		expect(out).toBe(target);
		expect(new URL(out, "https://site.test").host).toBe("site.test");
	});

	test("anything outside printable ASCII is percent-encoded so the header is valid", () => {
		for (const target of ["/→", "/é?q=ü", "/ ", "/∕evil.com", "/／evil.com", "/​", "/😀"]) {
			const out = sameSitePath(target)!;
			expect(out).toMatch(/^\/[\x21-\x7e]*$/);
			expect(() => new Headers().set("location", out)).not.toThrow();
			expect(new URL(out, "https://site.test").host).toBe("site.test");
		}
		expect(sameSitePath("/é")).toBe("/%C3%A9");
	});
});
