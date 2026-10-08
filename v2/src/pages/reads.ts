/**
 * Which top-level names a template reads, and which fields of each.
 *
 * uwu's parser hands back the template as a tree (`compile(...).template`);
 * this walks it the way uwu's code generator resolves paths:
 *
 * - at the top, `{{product.name}}` reads the name `product`, field `name`;
 * - inside `{{#each reviews}}` a path is the item's: `{{author.name}}` reads
 *   `reviews`, field `author.name`, and `../product.id` climbs back out;
 * - `{{#await x as v}}` binds `v` and resolves the rest against the top;
 * - `@index` and friends, and names a `<script>` block declares, are not data.
 *
 * A name read only for truth (`{{#if viewer}}`, `{{#if jobs.length}}`) needs
 * no fields; one used whole (`{{component "card" p=product}}`, `{{this}}`)
 * needs all of them, written `*`. What comes out is what a source or a model
 * resolver is handed as `fields`, so it can select only those.
 */

import type { Attr, Expr, TplNode } from "uwu-template/ast";

/** Where a read is (uwu's `Loc` without the offset). */
export interface Loc {
	line: number;
	col: number;
}

export interface Read {
	/** Dotted field paths read under this name. */
	fields: Set<string>;
	/** Used as a whole somewhere: every field is needed. */
	whole: boolean;
	/** Where it is first read. */
	loc: Loc;
}

export type Reads = Map<string, Read>;

export type { TplNode } from "uwu-template/ast";

/** A data frame: the top, or a loop item standing for `name.prefix[i]`. */
type Frame = { root: true } | { root: false; name?: string; prefix: string[] };

type Mode = "value" | "truth";

export interface CollectOptions {
	/** Names declared in the file's `<script>` blocks: never data. */
	scriptNames?: ReadonlySet<string>;
	/**
	 * A partial's tree, when natsu compiled the file: walked where it is
	 * included, against the data there (a partial renders with its caller's
	 * current data, so `{{name}}` in one included inside `{{#each products}}`
	 * reads `products`, field `name`).
	 */
	partial?: (name: string) => { nodes: readonly TplNode[]; scriptNames: ReadonlySet<string> } | undefined;
	/** Called for a partial `partial` does not know: its reads are invisible from here. */
	onPartial?: (name: string, loc: Loc) => void;
	/** Called for every `@event="action:name"` in the template (and its partials). */
	onAction?: (name: string, loc: Loc) => void;
	/** Called for every `@href="/path"` in the template itself (not in the partials it includes: each is checked in its own file). */
	onLink?: (href: string, loc: Loc) => void;
}

/** The `{{path}}` holes of an `@href` value, as uwu draws them: each a plain dotted path from the current data. */
export const HOLE = /\{\{\{?([^}]*?)\}?\}\}/g;

export function collectReads(nodes: readonly TplNode[], options: CollectOptions = {}): Reads {
	const reads: Reads = new Map();
	const frames: Frame[] = [{ root: true }];
	const locals: string[] = [];
	let scriptNames = options.scriptNames ?? new Set<string>();
	/** Partials being walked, to stop one that includes itself. */
	const including: string[] = [];

	const record = (name: string, rest: readonly string[], mode: Mode, loc: Loc): void => {
		let fields = rest;
		if (fields.length > 0 && fields[fields.length - 1] === "length") {
			fields = fields.slice(0, -1);
			mode = "truth";
		}
		let read = reads.get(name);
		if (!read) reads.set(name, (read = { fields: new Set(), whole: false, loc }));
		if (fields.length > 0) read.fields.add(fields.join("."));
		else if (mode === "value") read.whole = true;
	};

	/** Where a path points: a name and the fields under it, or nothing that is data. */
	const target = (expr: Expr & { t: "path" }): { name: string; rest: string[] } | undefined => {
		const head = expr.segments[0];
		if (head !== undefined && head.startsWith("@")) return undefined;
		if (head !== undefined && locals.includes(head)) return undefined;
		const frame = frames[Math.max(0, frames.length - 1 - expr.parentDepth)]!;
		if (frame.root) {
			if (head === undefined || scriptNames.has(head)) return undefined;
			return { name: head, rest: expr.segments.slice(1) };
		}
		if (!frame.name) return undefined;
		return { name: frame.name, rest: [...frame.prefix, ...expr.segments] };
	};

	const expr = (e: Expr | undefined, mode: Mode, loc: Loc): void => {
		if (!e) return;
		if (e.t === "path") {
			const at = target(e);
			if (at) record(at.name, at.rest, mode, loc);
		} else if (e.t === "js") {
			for (const part of e.parts) if (typeof part !== "string") expr(part, "value", loc);
		}
	};

	const attrs = (list: readonly Attr[], loc: Loc): void => {
		for (const attr of list) {
			if (attr.t === "dynamic") {
				for (const part of attr.parts) if (part.t === "interp") expr(part.expr, "value", loc);
			} else if (attr.t === "can") expr(attr.recordExpr, "value", loc);
			else if (attr.t === "action") options.onAction?.(attr.name, loc);
			else if (attr.t === "spaLink") {
				// uwu keeps the value as written and reads each hole as a dotted
				// path from the data in scope (`/p/{{slug}}` inside an each reads
				// the item's `slug`), so the holes are reads like any other.
				for (const m of attr.value.matchAll(HOLE)) {
					const path = m[1]!.trim();
					if (path) expr({ t: "path", segments: path.split("."), parentDepth: 0 }, "value", loc);
				}
				if (including.length === 0) options.onLink?.(attr.value, loc);
			}
		}
	};

	const walk = (list: readonly TplNode[]): void => {
		for (const node of list) {
			switch (node.t) {
				case "interp":
					expr(node.expr, "value", node.loc);
					break;
				case "if":
					for (const branch of node.branches) {
						expr(branch.cond, "truth", node.loc);
						walk(branch.body);
					}
					break;
				case "each": {
					expr(node.src, "truth", node.loc);
					const at = node.src.t === "path" ? target(node.src) : undefined;
					frames.push({ root: false, name: at?.name, prefix: at?.rest ?? [] });
					walk(node.body);
					frames.pop();
					if (node.empty) walk(node.empty);
					break;
				}
				case "await":
					expr(node.src, "value", node.loc);
					if (node.loading) walk(node.loading);
					frames.push({ root: true });
					locals.push(node.as);
					walk(node.body);
					locals.pop();
					frames.pop();
					break;
				case "helper":
					for (const arg of node.call.args) expr(arg, "value", node.loc);
					for (const value of Object.values(node.call.hash)) expr(value, "value", node.loc);
					break;
				case "component":
					for (const value of Object.values(node.props)) expr(value, "value", node.loc);
					break;
				case "layout": {
					if (node.name === "@child") break;
					const included = including.includes(node.name) ? undefined : options.partial?.(node.name);
					if (!included) {
						if (!including.includes(node.name)) options.onPartial?.(node.name, node.loc);
						break;
					}
					const outer = scriptNames;
					including.push(node.name);
					scriptNames = included.scriptNames;
					walk(included.nodes);
					scriptNames = outer;
					including.pop();
					break;
				}
				case "element":
					attrs(node.attrs, node.loc);
					walk(node.children);
					break;
				case "elementVoid":
					attrs(node.attrs, node.loc);
					break;
			}
		}
	};

	walk(nodes);
	return reads;
}

/** Add `path` (a name and its fields) to `reads`, as a value read. */
export function addRead(reads: Reads, segments: readonly string[], loc: Loc): void {
	const [name, ...rest] = segments;
	if (!name) return;
	let read = reads.get(name);
	if (!read) reads.set(name, (read = { fields: new Set(), whole: false, loc }));
	if (rest.length > 0) read.fields.add(rest.join("."));
	else read.whole = true;
}

/** The `fields` a source is handed: `["*"]` when used whole, else the sorted paths. */
export function fieldList(read: Read | undefined): string[] {
	if (!read) return [];
	if (read.whole) return ["*"];
	// `tags` is implied by `tags.label`: name the leaves only.
	const all = [...read.fields];
	return all.filter((field) => !all.some((other) => other.startsWith(`${field}.`))).sort();
}

/** Names declared at the top of a script block (const/let/var/function/class/import). */
export function scriptDeclarations(scripts: readonly { content: string }[]): Set<string> {
	const names = new Set<string>();
	for (const { content } of scripts) {
		for (const m of content.matchAll(/\b(?:const|let|var|function\*?|class)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]!);
		for (const m of content.matchAll(/\b(?:const|let|var)\s*\{([^}]*)\}/g)) {
			for (const part of m[1]!.split(",")) {
				const local = part.split(":").pop()!.split("=")[0]!.trim();
				if (local) names.add(local);
			}
		}
		for (const m of content.matchAll(/\bimport\s+([^;]*?)\s+from\b/g)) {
			for (const id of m[1]!.matchAll(/(?:\bas\s+)?([A-Za-z_$][\w$]*)/g)) names.add(id[1]!);
		}
	}
	return names;
}
