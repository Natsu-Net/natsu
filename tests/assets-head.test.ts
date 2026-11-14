import { describe, expect, test } from "bun:test";
import type { HeadTag } from "../src/assets/contract.ts";
import { addHeadTags, headTags, headTagsOf, insertHeadTags, renderHeadTags } from "../src/assets/head.ts";

describe("headTags", () => {
	test("collects link, meta and script per ctx", () => {
		const ctx = {};
		const other = {};
		headTags(ctx).link({ rel: "canonical", href: "/a" }).meta({ name: "robots", content: "noindex" }).script({ src: "/x.js", defer: true });
		expect(headTagsOf(ctx)).toEqual([
			{ tag: "link", attributes: { rel: "canonical", href: "/a" } },
			{ tag: "meta", attributes: { name: "robots", content: "noindex" } },
			{ tag: "script", attributes: { src: "/x.js", defer: true } },
		]);
		expect(headTagsOf(other)).toEqual([]);
		expect(headTags(ctx).list()).toHaveLength(3);
	});

	test("duplicates collapse whatever the attribute order or case", () => {
		const ctx = {};
		headTags(ctx).link({ rel: "icon", href: "/i.png" }).link({ href: "/i.png", rel: "icon" }).link({ HREF: "/i.png", Rel: "icon", media: undefined, disabled: false });
		expect(headTagsOf(ctx)).toHaveLength(1);
	});

	test("preload and modulepreload helpers, fonts default to anonymous CORS", () => {
		const ctx = {};
		headTags(ctx).preload("/fonts/a.woff2", "font", { type: "font/woff2" }).preload("/b.woff2", "font", { crossorigin: "use-credentials" }).preload("/hero.avif", "image").modulepreload("/m.js");
		expect(renderHeadTags(headTagsOf(ctx))).toBe(
			'<link rel="preload" href="/fonts/a.woff2" as="font" crossorigin="anonymous" type="font/woff2">' +
				'<link rel="preload" href="/b.woff2" as="font" crossorigin="use-credentials">' +
				'<link rel="preload" href="/hero.avif" as="image">' +
				'<link rel="modulepreload" href="/m.js">',
		);
	});

	test("refuses other tags, bad attribute names, handlers, inline or scripted src", () => {
		const ctx = {};
		const api = headTags(ctx);
		expect(() => api.link({ onload: "alert(1)" })).toThrow(/event handler/);
		expect(() => api.link({ ONERROR: "x" })).toThrow(/event handler/);
		expect(() => api.meta({ 'a"b': "x" })).toThrow(/not allowed/);
		expect(() => api.meta({ "a b": "x" })).toThrow(/not allowed/);
		expect(() => api.meta({ "a>b": "x" })).toThrow(/not allowed/);
		expect(() => api.script({ defer: true })).toThrow(/needs a src/);
		expect(() => api.script({ src: "javascript:alert(1)" })).toThrow(/http/);
		expect(() => api.script({ src: " data:text/javascript,alert(1)" })).toThrow(/http/);
		expect(() => api.meta({ content: 3 as unknown as string })).toThrow(/string or boolean/);
		expect(headTagsOf(ctx)).toEqual([]);
		addHeadTags(ctx, [{ tag: "style" as unknown as "link", attributes: {} }, { tag: "script", attributes: {} }, { tag: "link", attributes: { onload: "x" } }, null as unknown as HeadTag]);
		expect(headTagsOf(ctx)).toEqual([]);
	});

	test("addHeadTags carries tags to another ctx", () => {
		const first = {};
		const second = {};
		headTags(first).meta({ name: "a", content: "1" }).script({ src: "https://cdn.example/x.js", async: true });
		const kept = JSON.parse(JSON.stringify(headTagsOf(first))) as HeadTag[];
		headTags(second).meta({ name: "a", content: "1" });
		addHeadTags(second, kept);
		expect(headTagsOf(second)).toEqual(headTagsOf(first));
	});

	test("the list is bounded", () => {
		const ctx = {};
		for (let n = 0; n < 200; n++) headTags(ctx).meta({ name: `m${n}`, content: "x" });
		expect(headTagsOf(ctx)).toHaveLength(64);
	});
});

describe("renderHeadTags", () => {
	test("escapes values, writes bare attributes, omits false", () => {
		const out = renderHeadTags([{ tag: "meta", attributes: { name: "description", content: `"><script>alert('x')</script>&` } }, { tag: "link", attributes: { rel: "preload", href: "/a?b=1&c=2", as: "fetch", crossorigin: true, disabled: false } }]);
		expect(out).not.toContain("<script>");
		expect(out).not.toContain(`"">`);
		expect(out.match(/</g)?.length).toBe(2);
		expect(out).toContain('href="/a?b=1&#38;c=2"');
		expect(out).toContain(" crossorigin>");
		expect(out).not.toContain("disabled");
	});

	test("scripts get the answer's nonce, never the caller's, and modulepreload too", () => {
		const tags: HeadTag[] = [
			{ tag: "script", attributes: { src: "/x.js", nonce: "mine", type: "module" } },
			{ tag: "link", attributes: { rel: "modulepreload", href: "/m.js" } },
			{ tag: "link", attributes: { rel: "icon", href: "/i.png" } },
			{ tag: "meta", attributes: { name: "a", content: "b" } },
		];
		expect(renderHeadTags(tags, { nonce: "n1" })).toBe('<script src="/x.js" type="module" nonce="n1"></script><link rel="modulepreload" href="/m.js" nonce="n1"><link rel="icon" href="/i.png"><meta name="a" content="b">');
		expect(renderHeadTags(tags)).toBe('<script src="/x.js" type="module"></script><link rel="modulepreload" href="/m.js"><link rel="icon" href="/i.png"><meta name="a" content="b">');
		expect(renderHeadTags(tags, { nonce: 'n"><x' })).not.toContain('"><x');
	});

	test("skips a resource the page already links, keeps the rest", () => {
		const page = '<html><head><link rel="stylesheet" href="/_a/core.css"><style>@font-face{src:url("/f.woff2")}</style></head><body><a href="/about">x</a><script src="/late.js"></script></body></html>';
		const tags: HeadTag[] = [
			{ tag: "link", attributes: { rel: "preload", href: "/_a/core.css", as: "style" } },
			{ tag: "link", attributes: { rel: "preload", href: "/f.woff2", as: "font", crossorigin: "anonymous" } },
			{ tag: "link", attributes: { rel: "canonical", href: "/about" } },
			{ tag: "link", attributes: { rel: "preload", href: "/late.js", as: "script" } },
			{ tag: "script", attributes: { src: "/late.js" } },
			{ tag: "script", attributes: { src: "/new.js" } },
		];
		expect(renderHeadTags(tags, { present: page })).toBe(
			'<link rel="preload" href="/f.woff2" as="font" crossorigin="anonymous"><link rel="canonical" href="/about"><link rel="preload" href="/late.js" as="script"><script src="/new.js"></script>',
		);
	});

	test("duplicates and invalid tags handed in directly are dropped", () => {
		const tags = [
			{ tag: "meta", attributes: { name: "a", content: "b" } },
			{ tag: "meta", attributes: { content: "b", name: "a" } },
			{ tag: "iframe", attributes: { src: "/x" } },
			{ tag: "link", attributes: { "x y": "1" } },
			{ tag: "script", attributes: { src: "vbscript:x" } },
			undefined,
		] as unknown as HeadTag[];
		expect(renderHeadTags(tags)).toBe('<meta name="a" content="b">');
		expect(renderHeadTags([])).toBe("");
		expect(renderHeadTags(undefined as unknown as HeadTag[])).toBe("");
	});
});

describe("insertHeadTags", () => {
	test("right before the head's end tag", () => {
		expect(insertHeadTags("<html><head><title>t</title></head><body></body></html>", "<meta name=a>")).toBe("<html><head><title>t</title><meta name=a></head><body></body></html>");
		expect(insertHeadTags("<HEAD></HEAD >", "<x>")).toBe("<HEAD><x></HEAD >");
	});

	test("unchanged without a head or without tags", () => {
		const part = '<div data-natsu-region="main">x</div>';
		expect(insertHeadTags(part, "<meta name=a>")).toBe(part);
		expect(insertHeadTags("<head></head>", "")).toBe("<head></head>");
	});

	test("a navigation part's head carries the tags", () => {
		const ctx = {};
		headTags(ctx).meta({ property: "og:title", content: "Page two" });
		const full = "<html><head><title>two</title></head><body><main>2</main></body></html>";
		const out = insertHeadTags(full, renderHeadTags(headTagsOf(ctx), { present: full }));
		expect(out).toContain('<title>two</title><meta property="og:title" content="Page two"></head>');
	});
});
