import { describe, expect, test } from "bun:test";
import type { CriticalInput } from "../src/assets/contract.ts";
import { criticalPass, warmSignal } from "../src/assets/critical.ts";
import { stylePolicy } from "../src/csp.ts";

const SHEETS: Record<string, string> = {
	"/_a/core.aaaa.css": "body{margin:0}",
	"/_a/core-f1.bbbb.css": ".card{border:1px solid}",
	"/_a/big.cccc.css": `.big{content:"${"x".repeat(500)}"}`,
	"/_a/evil.dddd.css": ".a{}</STYLE><script>alert(1)</script>",
	"/_a/comment.eeee.css": ".a{}<!-- x",
	"/_a/uni.ffff.css": ".a{content:\"éé\"}",
};

function pass(overrides: Partial<CriticalInput> = {}) {
	return criticalPass({ publicPath: "/_a", maxBytes: 14_000, body: (url) => SHEETS[url], style: { allowed: true }, warm: false, ...overrides });
}

const page = (head: string, body = "<main>x</main>") => `<!doctype html><html><head><title>t</title>${head}</head><body>${body}</body></html>`;

describe("criticalPass", () => {
	test("inlines a held stylesheet and keeps a non-blocking fetch of the real chunk", () => {
		const critical = pass();
		const out = critical.apply(page('<link rel="stylesheet" href="/_a/core.aaaa.css">'));
		expect(out).toBe(page('<style data-natsu-critical="/_a/core.aaaa.css">body{margin:0}</style><link rel="preload" as="style" href="/_a/core.aaaa.css" data-natsu-warm>'));
		expect(critical.inlined).toEqual(["/_a/core.aaaa.css"]);
		expect(critical.bytes).toBe(14);
	});

	test("warm input writes no warming link", () => {
		expect(pass({ warm: true }).apply(page('<link rel="stylesheet" href="/_a/core.aaaa.css">'))).toBe(page('<style data-natsu-critical="/_a/core.aaaa.css">body{margin:0}</style>'));
	});

	test("the style nonce is written on the style and the warming link, and no other nonce", () => {
		const style = stylePolicy("script-src 'nonce-s1'; style-src 'self' 'nonce-c1'");
		const out = pass({ style }).apply(page('<link rel="stylesheet" href="/_a/core.aaaa.css" nonce="old">'));
		expect(out).toContain('<style data-natsu-critical="/_a/core.aaaa.css" nonce="c1">');
		expect(out).toContain('<link rel="preload" as="style" href="/_a/core.aaaa.css" nonce="c1" data-natsu-warm>');
		expect(out).not.toContain("old");
		expect(out).not.toContain("s1");
	});

	test("a policy that refuses inline styles makes the pass the identity", () => {
		const html = page('<link rel="stylesheet" href="/_a/core.aaaa.css">');
		const strict = pass({ style: stylePolicy("style-src 'self'") });
		expect(strict.apply(html)).toBe(html);
		expect(strict.inlined).toEqual([]);
		expect(pass({ style: { allowed: true, nonce: 'a"><script>' } }).apply(html)).toBe(html);
		expect(pass({ maxBytes: 0 }).apply(html)).toBe(html);
		expect(pass({ maxBytes: Number.NaN }).apply(html)).toBe(html);
	});

	test("families: the core carries its manifest, each family is inlined in link order", () => {
		const out = pass().apply(page('<link rel="stylesheet" href="/_a/core.aaaa.css" data-natsu-families="/_a/core.fam.json"><link rel="stylesheet" href="/_a/core-f1.bbbb.css"><link rel="prefetch" href="/_a/core-f2.css" data-natsu-prefetch>'));
		expect(out).toContain('<style data-natsu-critical="/_a/core.aaaa.css" data-natsu-families="/_a/core.fam.json">body{margin:0}</style>');
		expect(out).toContain('<style data-natsu-critical="/_a/core-f1.bbbb.css">.card{border:1px solid}</style>');
		expect(out.indexOf("core.aaaa.css")).toBeLessThan(out.indexOf("core-f1.bbbb.css"));
		expect(out).toContain('<link rel="prefetch" href="/_a/core-f2.css" data-natsu-prefetch>');
	});

	test("greedy within the byte budget: a sheet that does not fit stays a link, a later smaller one fits", () => {
		const critical = pass({ maxBytes: 40 });
		const out = critical.apply(page('<link rel="stylesheet" href="/_a/core.aaaa.css"><link rel="stylesheet" href="/_a/big.cccc.css"><link rel="stylesheet" href="/_a/core-f1.bbbb.css">'));
		expect(critical.inlined).toEqual(["/_a/core.aaaa.css", "/_a/core-f1.bbbb.css"]);
		expect(critical.bytes).toBe(37);
		expect(out).toContain('<link rel="stylesheet" href="/_a/big.cccc.css">');
	});

	test("the budget counts bytes, not characters", () => {
		const size = Buffer.byteLength(SHEETS["/_a/uni.ffff.css"]!);
		expect(size).toBeGreaterThan(SHEETS["/_a/uni.ffff.css"]!.length);
		const html = page('<link rel="stylesheet" href="/_a/uni.ffff.css">');
		expect(pass({ maxBytes: size - 1 }).apply(html)).toBe(html);
		expect(pass({ maxBytes: size }).apply(html)).not.toBe(html);
	});

	test("the count is kept across pieces of a kept page", () => {
		const critical = pass({ maxBytes: 20 });
		const before = '<!doctype html><html><head><link rel="stylesheet" href="/_a/core.aaaa.css">';
		const middle = '<link rel="stylesheet" href="/_a/core-f1.bbbb.css">';
		const after = '</head><body><link rel="stylesheet" href="/_a/core.aaaa.css"></body></html>';
		expect(critical.apply(before)).toContain("data-natsu-critical");
		expect(critical.apply(middle)).toBe(middle);
		expect(critical.apply(after)).toBe(after);
		expect(critical.bytes).toBe(14);
	});

	test("bodies that could close the style element or open a comment are never inlined", () => {
		const html = page('<link rel="stylesheet" href="/_a/evil.dddd.css"><link rel="stylesheet" href="/_a/comment.eeee.css">');
		expect(pass().apply(html)).toBe(html);
	});

	test("links it must leave alone", () => {
		const left = [
			'<link rel="stylesheet" href="/_a/core.aaaa.css" media="print">',
			'<link rel="stylesheet" href="/_a/core.aaaa.css" media="(min-width: 600px)">',
			'<link rel="stylesheet" href="/_a/core.aaaa.css" disabled>',
			'<link rel="stylesheet" href="/_a/core.aaaa.css" title="alt">',
			'<link rel="alternate stylesheet" href="/_a/core.aaaa.css">',
			'<link rel="stylesheet" href="/_a/core.aaaa.css" data-natsu-later="/_a/core-later.css">',
			'<link rel="stylesheet" href="/_a/core.aaaa.css" data-natsu-prefetch>',
			'<link rel="stylesheet" href="/_a/core.aaaa.css" id="theme">',
			'<link rel="stylesheet" href="/_a/core.aaaa.css" integrity="sha384-x">',
			'<link rel="prefetch" href="/_a/core.aaaa.css">',
			'<link rel="preload" as="style" href="/_a/core.aaaa.css">',
			'<link rel="stylesheet" href="/_a/unknown.css">',
			'<link rel="stylesheet" href="/other/core.aaaa.css">',
			'<link rel="stylesheet" href="https://cdn.example/_a/core.aaaa.css">',
			'<link rel="stylesheet" href="/_a/core.aaaa.css?v=1&amp;x=2">',
			'<link rel="stylesheet" type="text/less" href="/_a/core.aaaa.css">',
		];
		for (const link of left) expect(pass().apply(page(link))).toBe(page(link));
	});

	test("link shapes it accepts: single quotes, no quotes, self-closing, upper case, media all or screen", () => {
		expect(pass().apply(page("<LINK REL='stylesheet' HREF='/_a/core.aaaa.css' />"))).toContain('<style data-natsu-critical="/_a/core.aaaa.css">');
		expect(pass().apply(page("<link rel=stylesheet href=/_a/core.aaaa.css>"))).toContain('<style data-natsu-critical="/_a/core.aaaa.css">');
		expect(pass().apply(page('<link href="/_a/core.aaaa.css" type="text/css" rel="stylesheet" media="Screen">'))).toContain('<style data-natsu-critical="/_a/core.aaaa.css" media="screen">');
		expect(pass().apply(page('<link rel="stylesheet" href="/_a/core.aaaa.css" media="all">'))).toContain('media="all"');
	});

	test("the same sheet linked twice is inlined once", () => {
		const critical = pass();
		const out = critical.apply(page('<link rel="stylesheet" href="/_a/core.aaaa.css"><link rel="stylesheet" href="/_a/core.aaaa.css">'));
		expect(out.match(/<style /g)?.length).toBe(1);
		expect(critical.bytes).toBe(14);
	});

	test("only inside head: body links, comments, scripts and text before head are untouched", () => {
		const link = '<link rel="stylesheet" href="/_a/core.aaaa.css">';
		const inBody = page("", link);
		expect(pass().apply(inBody)).toBe(inBody);
		const commented = page(`<!-- ${link} -->`);
		expect(pass().apply(commented)).toBe(commented);
		const scripted = page(`<script>const s = '${link}';</script><style>/* ${link} */</style>`);
		expect(pass().apply(scripted)).toBe(scripted);
		const noHead = `<html>${link}<body></body></html>`;
		expect(pass().apply(noHead)).toBe(noHead);
		const implicitBody = `<html><head></head><BODY class="x">${link}`;
		expect(pass().apply(implicitBody)).toBe(implicitBody);
		const afterScript = page(`<script>if (a < b) x()</script>${link}`);
		expect(pass().apply(afterScript)).toContain("data-natsu-critical");
	});

	test("parts, islands and fragments have no head and come back as they were", () => {
		const part = '<link rel="stylesheet" href="/_a/core.aaaa.css"><div data-natsu-region="main">x</div>';
		const critical = pass();
		expect(critical.apply(part)).toBe(part);
		expect(critical.inlined).toEqual([]);
	});

	test("malformed markup never throws and is left as it was", () => {
		for (const html of ["<head><link rel=\"stylesheet href=/_a/core.aaaa.css>", "<head><link", "<head><", "<head><!-- open", "<head><script>never closed", "", "<head><link rel=stylesheet href>"]) {
			expect(pass().apply(html)).toBe(html);
		}
		const throwing = pass({
			body: () => {
				throw new Error("x");
			},
		});
		const html = page('<link rel="stylesheet" href="/_a/core.aaaa.css">');
		expect(throwing.apply(html)).toBe(html);
	});

	test("a comment or script left open in one piece hides links in the next", () => {
		const link = '<link rel="stylesheet" href="/_a/core.aaaa.css">';
		const commented = pass();
		commented.apply("<head><!-- start");
		expect(commented.apply(`${link} -->${link}`)).toBe(`${link} --><style data-natsu-critical="/_a/core.aaaa.css">body{margin:0}</style><link rel="preload" as="style" href="/_a/core.aaaa.css" data-natsu-warm>`);
		const scripted = pass();
		scripted.apply("<head><script>let a = `");
		expect(scripted.apply(`${link}\`</script>`)).toBe(`${link}\`</script>`);
	});

	test("a long head is scanned in linear time", () => {
		const head = '<meta name="a" content="b">'.repeat(200_000);
		const started = performance.now();
		const out = pass().apply(page(`${head}<link rel="stylesheet" href="/_a/core.aaaa.css">`));
		expect(out).toContain("data-natsu-critical");
		expect(performance.now() - started).toBeLessThan(2000);
		const open = `<head>${"<a b=\"".repeat(100_000)}`;
		const again = performance.now();
		expect(pass().apply(open)).toBe(open);
		expect(performance.now() - again).toBeLessThan(2000);
	});
});

describe("warmSignal", () => {
	test("warm when the cookie holds this build's id", () => {
		expect(warmSignal("a=1; natsu-a=b1234; z=2", "natsu-a", "b1234", true)).toEqual({ warm: true });
		expect(warmSignal('natsu-a="b1234"', "natsu-a", "b1234", false)).toEqual({ warm: true });
		expect(warmSignal("natsu-a=old; natsu-a=b1234", "natsu-a", "b1234", false)).toEqual({ warm: true });
	});

	test("cold without the cookie, with another build's id, or with a look-alike name", () => {
		const cookie = "natsu-a=b1234; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly";
		expect(warmSignal(null, "natsu-a", "b1234", false)).toEqual({ warm: false, setCookie: cookie });
		expect(warmSignal(undefined, "natsu-a", "b1234", false)).toEqual({ warm: false, setCookie: cookie });
		expect(warmSignal("natsu-a=older", "natsu-a", "b1234", false)).toEqual({ warm: false, setCookie: cookie });
		expect(warmSignal("xnatsu-a=b1234; natsu-ab=b1234", "natsu-a", "b1234", false)).toEqual({ warm: false, setCookie: cookie });
		expect(warmSignal("natsu-a=b1234x", "natsu-a", "b1234", false).warm).toBe(false);
		expect(warmSignal(";;=;natsu-a", "natsu-a", "b1234", false).warm).toBe(false);
	});

	test("Secure is added on a secure request", () => {
		expect(warmSignal("", "natsu-a", "b1", true).setCookie).toBe("natsu-a=b1; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly; Secure");
	});

	test("a name or build id that is not a plain token turns the feature off", () => {
		expect(warmSignal(null, "na me", "b1", false)).toEqual({ warm: true });
		expect(warmSignal(null, "natsu-a", "b1; Domain=evil.example", false)).toEqual({ warm: true });
		expect(warmSignal(null, "natsu-a", "b1\r\nSet-Cookie: x=y", false)).toEqual({ warm: true });
		expect(warmSignal(null, "natsu-a", "", false)).toEqual({ warm: true });
		expect(warmSignal(null, "", "b1", false)).toEqual({ warm: true });
		expect(warmSignal(null, "natsu-a", "x".repeat(65), false)).toEqual({ warm: true });
	});
});
