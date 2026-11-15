import { describe, expect, test } from "bun:test";
import { blockMatcher } from "../src/assets/blocklist.ts";

describe("blockMatcher", () => {
	test("no rules never blocks", () => {
		expect(blockMatcher(undefined)("https://ads.example/tag.js")).toBe(false);
		expect(blockMatcher([])("/assets/app.js")).toBe(false);
	});

	test("a string rule matches the whole ref as written", () => {
		const blocked = blockMatcher(["https://ads.example/tag.js", "/vendor/checkout.js"]);
		expect(blocked("https://ads.example/tag.js")).toBe(true);
		expect(blocked("/vendor/checkout.js")).toBe(true);
		expect(blocked("https://ads.example/tag.js?client=1")).toBe(false);
		expect(blocked("https://ads.example/tag")).toBe(false);
		expect(blocked("/vendor/checkout.js.map")).toBe(false);
	});

	test("a trailing star makes the rule a prefix", () => {
		const blocked = blockMatcher(["https://ads.example/*", "/pay/*"]);
		expect(blocked("https://ads.example/tag.js?client={{ client }}")).toBe(true);
		expect(blocked("https://ads.example/")).toBe(true);
		expect(blocked("https://ads.example.evil/tag.js")).toBe(false);
		expect(blocked("/pay/widget.js")).toBe(true);
		expect(blocked("/payments/widget.js")).toBe(false);
	});

	test("a protocol-relative ref is also read as https", () => {
		const blocked = blockMatcher(["https://ads.example/*", "https://one.example/a.js"]);
		expect(blocked("//ads.example/tag.js")).toBe(true);
		expect(blocked("//one.example/a.js")).toBe(true);
		expect(blocked("//other.example/a.js")).toBe(false);
		expect(blockMatcher(["//ads.example/*"])("//ads.example/tag.js")).toBe(true);
	});

	test("scheme and host are read without case, the path is never decoded", () => {
		const blocked = blockMatcher(["https://ads.example/tag.js"]);
		expect(blocked("https://ADS.example/tag.js")).toBe(true);
		expect(blocked(" https://ads.example/tag.js")).toBe(true);
		expect(blocked("https://ads.example/%74ag.js")).toBe(false);
		expect(blocked("https://ads.example/./tag.js")).toBe(false);
		expect(blocked("https://ads.example/TAG.js")).toBe(false);
	});

	test("a RegExp is tested against the ref as written", () => {
		const blocked = blockMatcher([/challenge-widget/, /^https:\/\/pay\.example\//i]);
		expect(blocked("https://cdn.example/challenge-widget/v0/api.js")).toBe(true);
		expect(blocked("HTTPS://PAY.example/v3")).toBe(true);
		expect(blocked("/assets/app.js")).toBe(false);
	});

	test("global and sticky RegExps give the same answer on every call", () => {
		const global = /tag\.js/g;
		const sticky = /https/y;
		const blocked = blockMatcher([global, sticky]);
		for (let n = 0; n < 4; n++) {
			expect(blocked("https://ads.example/tag.js")).toBe(true);
			expect(blocked("x https://other.example/a.js")).toBe(false);
		}
		expect(global.lastIndex).toBe(0);
		expect(sticky.lastIndex).toBe(0);
	});

	test("a rule of another type is refused when the matcher is built", () => {
		expect(() => blockMatcher([42 as unknown as string])).toThrow("block rule");
	});

	test("a ref the browser reads as the same URL is blocked however it is spelled", () => {
		const blocked = blockMatcher(["https://ads.example.com/*", "https://t.example.com/p.js?a=1&b=2"]);
		expect(blocked("HTTPS://ADS.EXAMPLE.COM/x.js")).toBe(true);
		expect(blocked("Https://Ads.Example.Com/x.js")).toBe(true);
		expect(blocked("//ADS.example.com/x.js")).toBe(true);
		expect(blocked("https://ads.exa\tmple.com/x.js")).toBe(true);
		expect(blocked("ht\ntps://ads.example.com/x.js")).toBe(true);
		expect(blocked("https:\\\\ads.example.com/x.js")).toBe(true);
		expect(blocked("https://t.example.com/p.js?a=1&amp;b=2")).toBe(true);
		expect(blocked("https://t.example.com/p.js?a=1&#38;b=2")).toBe(true);
		expect(blocked("https://ads.example.com.evil.test/x.js")).toBe(false);
		expect(blocked("https://ads.example.com/X.js")).toBe(true);
		expect(blocked("https://t.example.com/P.js?a=1&b=2")).toBe(false);
	});

	test("a rule written with capitals in its host still matches", () => {
		const blocked = blockMatcher(["https://Ads.Example.com/*", /^https:\/\/cdn\.example\.com\//]);
		expect(blocked("https://ads.example.com/x.js")).toBe(true);
		expect(blocked("https://CDN.example.com/x.js")).toBe(true);
	});
});
