/**
 * Page shapes read from kept class attribute values.
 *
 * The claim is that reading a page this way gives the shape `profileDocument`
 * gives, and renaming it gives the page `renameAndProfile` gives, for every
 * way a page can spell a class attribute: so these compare the two on spelled
 * out cases, on a few thousand pages put together at random from the awkward
 * parts, and again once the kept values have been rotated out and back.
 */

import { describe, expect, test } from "bun:test";
import { profileDocument } from "uwu-template/assets";
import { renameAndProfile } from "uwu-template/assets/mangle";
import { GENERATION, GENERATION_CHARS, MAX_VALUE, PageShapes } from "../src/page-shape.ts";

const RENAME = new Map([
	["a", "q"],
	["b", "r"],
	["foo-bar", "s"],
	// Never renamed inside quotes (the rename takes whole ASCII words), but a
	// bare value is looked up whole: the two must be kept apart.
	["héllo", "t"],
]);

const CLASSES = ["a", "b", "c", "d", "e", "foo-bar", "héllo", "a&amp;b", "&#x61;", 'x"y', "x'y", "q", "r", "s", "t", "ÿ"];
const IDS = ["top", "main", "a b", "a", "b", "x"];

function shapes(rename = new Map<string, string>(), ids = IDS): PageShapes {
	return new PageShapes(new Map([["site", { classes: new Set(CLASSES), ids: new Set(ids) }]]), rename);
}

/** Bits and key of a page read here, against the same from `profileDocument`. */
function expectSameAsProfile(reader: PageShapes, page: string): void {
	const read = reader.read(page);
	const profiled = reader.fromProfile(profileDocument(page));
	expect([...read.bits]).toEqual([...profiled.bits]);
	expect(reader.key("site", read)).toBe(reader.key("site", profiled));
}

/** The renamed page and its shape, against `renameAndProfile`'s. */
function expectSameAsRename(reader: PageShapes, page: string): void {
	const ours = reader.renameAndRead(page);
	const theirs = renameAndProfile(page, RENAME);
	expect(ours.html).toBe(theirs.html);
	const profiled = reader.fromProfile(theirs.profile);
	expect([...ours.shape.bits]).toEqual([...profiled.bits]);
	expect(reader.key("site", ours.shape)).toBe(reader.key("site", profiled));
}

const SPELLINGS = [
	'<div class="a b">x</div>',
	"<div class='a b'>x</div>",
	"<div class=a>x</div>",
	'<div CLASS="b">x</div>',
	"<div Class = 'c'>x</div>",
	'<div\nclass\n=\n"d"\t>x</div>',
	'<div\tclass="e">x</div>',
	'<div class="a&amp;b">x</div>',
	'<div class="&#x61;">x</div>',
	'<div class="  a \n\t b  ">x</div>',
	'<div class="a b">x</div>',
	'<div class="">x</div>',
	"<div class=''>x</div>",
	'<div class="x\'y">x</div>',
	"<div class='x\"y'>x</div>",
	'<div class=foo-bar>x</div>',
	'<div class="foo-bar a">x</div>',
	'<div class=héllo>x</div><p class="héllo">y</p>',
	'<div class="ÿ">x</div>',
	'<div data-class="a">not a class</div>',
	'<div class="c"class="d">only the first</div>',
	'<script>el.innerHTML = \' class="a"\' + "<p class=\'b\'>"</script>',
	'<!-- <div class="e"> -->',
	'<div class=a/>',
	'<div class=a>b</div><div class="a">b</div><div class=\'a\'>b</div>',
	'<div class="a b" id="top"><p id="main" class=b></p><i id=\'a b\'></i><b ID="x"></b><s id=x></s></div>',
	'<div class="q r s t">already short</div>',
	'<div class="a\uD800b">a lone surrogate</div>',
];

describe("reading a page from kept values", () => {
	test("every spelling of a class attribute reads as profileDocument reads it", () => {
		const reader = shapes();
		// Twice: the first time from nothing, then from what was kept.
		for (const _round of [1, 2]) {
			for (const page of SPELLINGS) expectSameAsProfile(reader, page);
			expectSameAsProfile(reader, SPELLINGS.join("\n"));
		}
	});

	test("every spelling is renamed as renameAndProfile renames it", () => {
		const reader = shapes(RENAME);
		for (const _round of [1, 2]) {
			for (const page of SPELLINGS) expectSameAsRename(reader, page);
			expectSameAsRename(reader, SPELLINGS.join("\n"));
		}
	});

	test("a bare value and a quoted one with the same text stay apart", () => {
		const reader = shapes(RENAME);
		expect(reader.renameAndRead("<i class=héllo></i>").html).toBe("<i class=t></i>");
		expect(reader.renameAndRead('<i class="héllo"></i>').html).toBe('<i class="héllo"></i>');
		expect(reader.renameAndRead("<i class=héllo></i>").html).toBe("<i class=t></i>");
	});

	test("ids count only when a rule names one, and then only those", () => {
		const page = '<div class="a" id="top"><p id="review-81"></p></div>';
		const reader = shapes();
		const other = '<div class="a" id="top"><p id="review-82"></p></div>';
		expect(reader.key("site", reader.read(page))).toBe(reader.key("site", reader.read(other)));
		expect(reader.key("site", reader.read(page))).not.toBe(reader.key("site", reader.read('<div class="a"></div>')));
		const blind = shapes(new Map(), []);
		expect(blind.read(page).ids).toBeUndefined();
		expect(blind.key("site", blind.read(page))).toBe(blind.key("site", blind.read('<div class="a"></div>')));
	});

	test("one id with a space in it is not the two either side of it", () => {
		const reader = shapes();
		expect(reader.key("site", reader.read('<p id="a b"></p>'))).not.toBe(reader.key("site", reader.read('<p id="a"></p><p id="b"></p>')));
	});

	test("one class with a comma in it is not the two either side of it", () => {
		const reader = new PageShapes(new Map([["site", { classes: new Set(["a,b", "a", "b"]), ids: new Set<string>() }]]), new Map());
		expect(reader.key("site", reader.read('<p class="a,b"></p>'))).not.toBe(reader.key("site", reader.read('<p class="a b"></p>')));
	});

	test("with two sheets each one's key counts only its own names", () => {
		const reader = new PageShapes(
			new Map([
				["one", { classes: new Set(["a", "b"]), ids: new Set<string>() }],
				["two", { classes: new Set(["b", "c"]), ids: new Set(["top"]) }],
			]),
			new Map(),
		);
		const key = (sheet: string, page: string) => reader.key(sheet, reader.read(page));
		expect(key("one", '<p class="a b c"></p>')).toBe(key("one", '<p class="a b" id="top"></p>'));
		expect(key("two", '<p class="a b c"></p>')).toBe(key("two", '<p class="b c"></p>'));
		expect(key("two", '<p class="b c"></p>')).not.toBe(key("two", '<p class="b c" id="top"></p>'));
		expect(key("one", '<p class="a"></p>')).not.toBe(key("two", '<p class="a"></p>'));
	});
});

describe("pages put together at random", () => {
	/** A small, seeded generator, so a failure is the same failure every run. */
	function random(seed: number): () => number {
		let state = seed >>> 0;
		return () => {
			state = (state + 0x6d2b79f5) >>> 0;
			let t = state;
			t = Math.imul(t ^ (t >>> 15), t | 1);
			t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
			return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
		};
	}
	const SPACE = [" ", "  ", "\n", "\t", "\r\n", "\f", " ", " ", ""];
	const NAME = ["class", "CLASS", "Class", "cLaSs", "data-class", "klass", "id", "ID", "classes", "class-x"];
	const WORD = [...CLASSES, "unknown", "z-9", "-", "_", "1x", "&quot;", "&lt;", "<", ">", "=", "`", "{{t}}", "pill--{{tone}}"];

	function page(next: () => number, length: number): string {
		const pick = <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)]!;
		let out = "";
		for (let i = 0; i < length; i++) {
			const roll = next();
			if (roll < 0.15) {
				out += pick(["<div", "<P", "<x-y", "<script>", "</script>", ">", "/>", "text", "<!--", "-->", "'", '"']);
				continue;
			}
			const words: string[] = [];
			for (let n = Math.floor(next() * 4); n > 0; n--) words.push(pick(WORD));
			const value = words.join(pick(SPACE) || " ");
			const quote = pick(['"', "'", "", '"', "'"]);
			const safe = quote === "" ? value.replace(/[\s"'=<>`]/g, "") : value.split(quote).join("");
			out += `${pick(SPACE)}${pick(NAME)}${pick(["", " ", "\n"])}=${pick(["", " ", "\t"])}${quote}${safe}${quote}${pick(["", ">", " ", "/>", "x"])}`;
		}
		return out;
	}

	test("each reads as profileDocument reads it, and renames as renameAndProfile renames it", () => {
		const plain = shapes();
		const renaming = shapes(RENAME);
		const next = random(81);
		for (let i = 0; i < 3000; i++) {
			const html = page(next, 1 + Math.floor(next() * 12));
			expectSameAsProfile(plain, html);
			expectSameAsRename(renaming, html);
		}
	});
});

describe("what is kept", () => {
	test("is bounded: two generations of values at most, and no value longer than the limit", () => {
		const reader = shapes(RENAME);
		for (let i = 0; i < GENERATION * 3; i++) reader.read(`<p class="v${i} a"></p>`);
		expect(reader.held).toBeLessThanOrEqual(GENERATION * 2);
		for (let i = 0; i < GENERATION * 3; i++) reader.renameAndRead(`<p class="v${i} a"></p>`);
		expect(reader.held).toBeLessThanOrEqual(GENERATION * 4);

		const fresh = shapes();
		const long = `a ${"b ".repeat(MAX_VALUE)}`;
		fresh.read(`<p class="${long}"></p>`);
		expect(fresh.held).toBe(0);
		expectSameAsProfile(fresh, `<p class="${long}"></p>`);
	});

	test("is bounded in characters too: long values fill a generation sooner", () => {
		const reader = shapes();
		const size = 2000;
		for (let i = 0; i < GENERATION; i++) reader.read(`<p class="${String(i).padEnd(size, "x")}"></p>`);
		// Each value counts its key and its text: a generation holds about this many.
		expect(reader.held).toBeLessThanOrEqual(2 * Math.ceil(GENERATION_CHARS / (2 * size)) + 2);
	});

	test("a value rotated out and met again still reads the same", () => {
		const reader = shapes(RENAME);
		for (const html of SPELLINGS) expectSameAsRename(reader, html);
		for (let i = 0; i < GENERATION; i++) reader.renameAndRead(`<p class="filler-${i}"></p>`);
		for (const html of SPELLINGS) expectSameAsRename(reader, html);
		for (let i = 0; i < GENERATION * 2; i++) reader.renameAndRead(`<p class="filler-${i}-2"></p>`);
		for (const html of SPELLINGS) expectSameAsRename(reader, html);
	});
});
