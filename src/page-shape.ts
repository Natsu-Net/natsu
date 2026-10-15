/**
 * A page's CSS shape, read from class attribute values seen before.
 *
 * Which chunk of a stylesheet a page gets depends only on which of the
 * classes and ids that sheet's rules name the page carries (see
 * `selectorNames` in uwu-template): that is the page's shape, and pages of
 * one shape share one chunk. Reading it with `profileDocument` costs several
 * times the render that drew the page, because every class attribute value
 * on every page is split and every name in it put in a Set, while a site
 * writes the same few hundred values on every page it draws.
 *
 * So each distinct value is read once: split (and renamed, when classes are
 * mangled) into the bits of the sheets' names it carries, and kept. A page's
 * shape is the OR of its values' bits, plus its ids when some rule names an
 * id. Tags are not read: no rule is kept or dropped for a tag name.
 *
 * It reads exactly what `profileDocument` and `renameAndProfile` read: the
 * same pattern finds the attributes (double, single or no quotes, any case,
 * space around `=`, anywhere in the text), the same split cuts a value into
 * names, an entity stays as it is written, and the rename is uwu-template's
 * own, applied one value at a time.
 *
 * What is kept is bounded, in two generations rather than as an exact LRU.
 * An LRU moves an entry to the back on every hit, and a page reads several
 * hundred attributes, so that is several hundred map writes per page where a
 * hit here is one map read. A value goes into the young generation; when that
 * is full (`GENERATION` values or `GENERATION_CHARS` characters) it becomes
 * the old one and the old one is dropped. A value found in the old generation
 * moves back to the young one, so what pages still use survives and what no
 * page wrote for a whole generation goes, as an LRU would drop it. Two
 * generations are 8192 values and half a million characters at most (a
 * megabyte), twice that with renaming on, which keeps a second memo; a value
 * longer than `MAX_VALUE` is read every time instead. Hub's seven pages
 * write 454 distinct values between them. Clearing everything at a cap would
 * be simpler, but the pages after it would pay every miss at once.
 */

import { type DocumentProfile, documentIds } from "uwu-template/assets";
import { renameHTMLClasses } from "uwu-template/assets/mangle";

/** What a page's chunks depend on. */
export interface PageShape {
	/** Bit `i` is set when the page carries the class numbered `i`. */
	bits: Uint32Array;
	/** The page's ids, read only when some sheet's rules name an id. */
	ids: Set<string> | undefined;
}

/** What one class attribute value adds to a page. */
interface Value {
	/** The value as kept: a copy that holds nothing of the page it came from. */
	key: string;
	/** The value as it goes out: renamed when classes are mangled. */
	text: string;
	/** The numbers of the classes it carries that some sheet's rules name. */
	bits: number[];
}

/**
 * Every class attribute, as both `profileDocument` and `renameAndProfile`
 * find them: the lead (`class=` and the space around it), then a double
 * quoted, single quoted or bare value.
 */
const CLASS_ATTRIBUTE = /(\sclass\s*=\s*)("([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi;
/** How both cut a value into names. */
const WHITESPACE = /\s+/;

/** Values a generation holds at most. */
export const GENERATION = 4096;
/** Characters (UTF-16 code units, values and their renamed text) a generation holds at most. */
export const GENERATION_CHARS = 1 << 18;
/** A value longer than this is read every time it is met, never kept. */
export const MAX_VALUE = 4096;

/**
 * A copy of `text` that shares no memory with the string it was cut from. A
 * regex capture is a view into the whole page it was found in, so a kept
 * capture would keep that page alive, and the memo would hold a page for
 * every value it holds. JSON's round trip builds a new string and keeps
 * every code unit, lone surrogates included.
 */
function detached(text: string): string {
	return JSON.parse(JSON.stringify(text)) as string;
}

/** Class attribute values, each read once: bounded, see the top of this file. */
class Values {
	private young = new Map<string, Value>();
	private old = new Map<string, Value>();
	private chars = 0;

	constructor(private readonly read: (raw: string, bare: boolean) => { text: string; bits: number[] }) {}

	/**
	 * What `raw` adds to a page. A bare value and a quoted one are kept
	 * apart, because the rename treats them differently. A bare one is keyed
	 * with `'"` in front, which no quoted value starts with: a value in double
	 * quotes holds no `"`, and one in single quotes no `'`.
	 */
	public get(raw: string, bare: boolean): Value {
		const lookup = bare ? `'"${raw}` : raw;
		const young = this.young.get(lookup);
		if (young !== undefined) return young;
		let value = this.old.get(lookup);
		if (value === undefined) {
			const read = this.read(raw, bare);
			if (raw.length > MAX_VALUE) return { key: raw, ...read };
			const key = detached(lookup);
			// Mostly the rename changes nothing, and the copy is shared.
			const text = read.text !== raw ? detached(read.text) : bare ? key.slice(2) : key;
			value = { key, text, bits: read.bits };
		}
		if (this.young.size >= GENERATION || this.chars >= GENERATION_CHARS) {
			this.old = this.young;
			this.young = new Map();
			this.chars = 0;
		}
		this.young.set(value.key, value);
		this.chars += value.key.length + value.text.length;
		return value;
	}

	/** Values held, both generations. */
	public get size(): number {
		return this.young.size + this.old.size;
	}
}

/** Tells apart the readers each `Assets.build()` makes. */
let builds = 0;

/**
 * Reads page shapes for a set of stylesheets. Built again on every
 * `Assets.build()`, since the sheets and the class names may have changed.
 */
export class PageShapes {
	/**
	 * In every key, so a shape remembered before a later build never matches
	 * a page after it: its bits were numbered for other sheets, and its chunk
	 * was cut from them.
	 */
	private readonly build = ++builds;
	/** Every class some sheet's rules name -> its bit. */
	private readonly index = new Map<string, number>();
	private readonly words: number;
	/** Sheet -> the bits of its own classes (null: all of them) and its ids. */
	private readonly sheets = new Map<string, { mask: Uint32Array | null; ids: Set<string> }>();
	/** Whether any sheet's rules name an id: if none does, ids are never read. */
	private readonly readsIds: boolean;
	/** Values as written, for a page whose classes are not renamed here. */
	private readonly written: Values;
	/** Values renamed, for a page whose classes are. */
	private readonly renamed: Values;

	/**
	 * `sheets` are each stylesheet's names (`selectorNames`, plus the classes
	 * `lazyStyles.whenPresent` looks for), `rename` the class renames, empty
	 * when classes are not mangled.
	 */
	constructor(
		sheets: ReadonlyMap<string, { classes: Set<string>; ids: Set<string> }>,
		private readonly rename: Map<string, string>,
	) {
		for (const names of sheets.values()) {
			for (const name of names.classes) if (!this.index.has(name)) this.index.set(name, this.index.size);
		}
		this.words = Math.ceil(this.index.size / 32);
		let readsIds = false;
		for (const [sheet, names] of sheets) {
			let mask: Uint32Array | null = null;
			if (sheets.size > 1) {
				mask = new Uint32Array(this.words);
				for (const name of names.classes) setBit(mask, this.index.get(name)!);
			}
			this.sheets.set(sheet, { mask, ids: names.ids });
			if (names.ids.size > 0) readsIds = true;
		}
		this.readsIds = readsIds;
		this.written = new Values((raw) => ({ text: raw, bits: this.bitsOf(raw) }));
		this.renamed = new Values((raw, bare) => {
			const text = this.renameValue(raw, bare);
			return { text, bits: this.bitsOf(text) };
		});
	}

	/** The shape of a page as it is written: `profileDocument`'s classes and ids, narrowed. */
	public read(html: string): PageShape {
		const bits = new Uint32Array(this.words);
		CLASS_ATTRIBUTE.lastIndex = 0;
		for (let m = CLASS_ATTRIBUTE.exec(html); m; m = CLASS_ATTRIBUTE.exec(html)) {
			// Unrenamed, a bare value reads as a quoted one does: one entry for both.
			orBits(bits, this.written.get(m[3] ?? m[4] ?? m[5] ?? "", false).bits);
		}
		return { bits, ids: this.readsIds ? documentIds(html) : undefined };
	}

	/**
	 * The page with its classes renamed, byte for byte what
	 * `renameAndProfile` gives, and the shape of the renamed page.
	 */
	public renameAndRead(html: string): { html: string; shape: PageShape } {
		const bits = new Uint32Array(this.words);
		const out = html.replace(
			CLASS_ATTRIBUTE,
			(all: string, lead: string, quoted: string, dq?: string, sq?: string, bare?: string) => {
				const value = bare === undefined ? this.renamed.get(dq ?? sq ?? "", false) : this.renamed.get(bare, true);
				orBits(bits, value.bits);
				if (bare !== undefined) return value.text === bare ? all : `${lead}${value.text}`;
				const quote = quoted[0]!;
				return value.text === (dq ?? sq) ? all : `${lead}${quote}${value.text}${quote}`;
			},
		);
		// Renaming touches class values only, so the ids are the source's.
		return { html: out, shape: { bits, ids: this.readsIds ? documentIds(html) : undefined } };
	}

	/** The shape of a profile someone else read. */
	public fromProfile(profile: DocumentProfile): PageShape {
		const bits = new Uint32Array(this.words);
		for (const name of profile.classes) {
			const bit = this.index.get(name);
			if (bit !== undefined) setBit(bits, bit);
		}
		return { bits, ids: profile.ids };
	}

	/**
	 * The key a page of this shape has for `sheet`: its classes and ids that
	 * the sheet's rules name, and nothing else, so two pages listing different
	 * things with the same classes share a chunk, and a page's own
	 * `id="review-81"` does not make it a shape of its own. Bun.hash, not
	 * sha256: the key never leaves this process.
	 */
	public key(sheet: string, shape: PageShape): string {
		const own = this.sheets.get(sheet);
		let bits = shape.bits;
		if (own?.mask) {
			bits = new Uint32Array(this.words);
			for (let i = 0; i < this.words; i++) bits[i] = (shape.bits[i] ?? 0) & (own.mask[i] ?? 0);
		}
		let ids = "";
		if (shape.ids !== undefined && (own === undefined || own.ids.size > 0)) {
			const list: string[] = [];
			for (const id of shape.ids) if (!own || own.ids.has(id)) list.push(id);
			// As JSON, so an id with a space in it is not the two either side of it.
			ids = JSON.stringify(list.sort());
		}
		return Bun.hash(bits, Bun.hash(`${this.build}\n${sheet}\n${ids}`)).toString(36);
	}

	/** Values held, for tests. */
	public get held(): number {
		return this.written.size + this.renamed.size;
	}

	/** The bits of the names in a value, cut the way `profileDocument` cuts it. */
	private bitsOf(text: string): number[] {
		const bits: number[] = [];
		for (const name of text.split(WHITESPACE)) {
			const bit = name ? this.index.get(name) : undefined;
			if (bit !== undefined) bits.push(bit);
		}
		return bits;
	}

	/**
	 * One value renamed by uwu-template's `renameHTMLClasses`, the rename
	 * `renameAndProfile` makes, handed an attribute of that one value. A
	 * quoted value is put back in a quote it does not hold: one that came in
	 * single quotes may hold `"`, never `'`.
	 */
	private renameValue(raw: string, bare: boolean): string {
		if (this.rename.size === 0) return raw;
		if (bare) return renameHTMLClasses(` class=${raw}`, this.rename).slice(" class=".length);
		const quote = raw.includes('"') ? "'" : '"';
		return renameHTMLClasses(` class=${quote}${raw}${quote}`, this.rename).slice(" class=".length + 1, -1);
	}
}

function setBit(bits: Uint32Array, bit: number): void {
	bits[bit >>> 5] = (bits[bit >>> 5] ?? 0) | (1 << (bit & 31));
}

function orBits(bits: Uint32Array, from: number[]): void {
	for (let i = 0; i < from.length; i++) setBit(bits, from[i]!);
}
