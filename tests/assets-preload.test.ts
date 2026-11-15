import { describe, expect, test } from "bun:test";
import type { ChunkGraph } from "../src/assets/contract.ts";
import { modulePreloads, stylePreloads } from "../src/assets/preload.ts";

const graph: ChunkGraph = {
	imports: {
		"/_a/entry.1.js": ["/_a/chunk-a.js", "/_a/chunk-b.js"],
		"/_a/chunk-a.js": ["/_a/chunk-c.js"],
		"/_a/chunk-c.js": ["/_a/chunk-a.js"],
		"/_a/other.2.js": ["/_a/chunk-b.js", "/_a/chunk-d.js"],
	},
	mounts: { "/_a/entry.1.js": [{ selector: ".x", chunk: "/_a/lazy.js" }] },
};

describe("modulePreloads", () => {
	test("static closure, breadth first, without the entries or mount chunks", () => {
		expect(modulePreloads(["/_a/entry.1.js"], graph, "")).toBe(
			'<link rel="modulepreload" href="/_a/chunk-a.js" data-natsu-warm><link rel="modulepreload" href="/_a/chunk-b.js" data-natsu-warm><link rel="modulepreload" href="/_a/chunk-c.js" data-natsu-warm>',
		);
	});

	test("de-duplicated across entries and survives cycles", () => {
		const out = modulePreloads(["/_a/entry.1.js", "/_a/other.2.js"], graph, "");
		expect(out.match(/chunk-b\.js/g)?.length).toBe(1);
		expect(out.match(/<link /g)?.length).toBe(4);
		expect(out).not.toContain("entry.1.js");
		expect(out).not.toContain("lazy.js");
	});

	test("skips what the page already names and writes the nonce", () => {
		const page = '<script type="module" src="/_a/entry.1.js"></script><link rel="modulepreload" href="/_a/chunk-a.js">';
		expect(modulePreloads(["/_a/entry.1.js"], graph, page, "n0")).toBe(
			'<link rel="modulepreload" href="/_a/chunk-b.js" nonce="n0" data-natsu-warm><link rel="modulepreload" href="/_a/chunk-c.js" nonce="n0" data-natsu-warm>',
		);
	});

	test("empty input, unknown entries and a hostile graph", () => {
		expect(modulePreloads([], graph, "")).toBe("");
		expect(modulePreloads(["/_a/none.js"], graph, "")).toBe("");
		expect(modulePreloads(["constructor", "__proto__"], graph, "")).toBe("");
		const hostile: ChunkGraph = { imports: { "/e.js": ['/x"><script>alert(1)</script>.js'] }, mounts: {} };
		const out = modulePreloads(["/e.js"], hostile, "", 'n"><b');
		expect(out).not.toContain("<script>");
		expect(out).not.toContain('"><');
		expect(out.match(/</g)?.length).toBe(1);
	});

	test("at most twelve hints", () => {
		const wide: ChunkGraph = { imports: { "/e.js": Array.from({ length: 30 }, (_, n) => `/c${n}.js`) }, mounts: {} };
		expect(modulePreloads(["/e.js"], wide, "").match(/<link /g)?.length).toBe(12);
	});
});

describe("stylePreloads", () => {
	test("preload links for sheets the page does not name, de-duplicated", () => {
		const page = '<link rel="stylesheet" href="/_a/core.css">';
		expect(stylePreloads(["/_a/core.css", "/_a/later.css", "/_a/later.css", "/_a/fam.css"], page)).toBe(
			'<link rel="preload" as="style" href="/_a/later.css" data-natsu-warm><link rel="preload" as="style" href="/_a/fam.css" data-natsu-warm>',
		);
	});

	test("empty input, escaping and the cap", () => {
		expect(stylePreloads([], "")).toBe("");
		expect(stylePreloads(['/a"onload="x.css'], "")).not.toContain('"onload="');
		expect(stylePreloads(Array.from({ length: 40 }, (_, n) => `/s${n}.css`), "").match(/<link /g)?.length).toBe(12);
	});
});
