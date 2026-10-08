/**
 * The `<page>` block: what a page file says about itself beside its
 * template, when the defaults are not what it wants.
 *
 *   <page title="{{product.name}} | Shop" cache="60">
 *     <data product="products.bySlug slug=params.slug" required>
 *     <data stock="inventory:GET /stock/{{params.slug}}" fallback="null">
 *     <data cart="cart.forSession" when="session">
 *     <action review="reviews.add" auth="viewer">
 *   </page>
 *   <template>…</template>
 *
 * It sits at the top of the file, before `<template>`. uwu's SFC splitter
 * knows nothing of it, so it is cut out here (replaced by as many newlines
 * as it spanned, so uwu's line numbers stay the file's) before the rest goes
 * to `compile`.
 *
 * Everything in it is data, never code: an argument is a dotted path
 * (`params.slug`, `product.id`) or a literal (`"new"`, `10`, `true`,
 * `null`), and anything else is refused here, at compile time, with the
 * file and the line.
 */

import { PageCompileError } from "./errors.ts";

export type Literal = string | number | boolean | null;

/** An argument: a path into the page's data, or a literal. */
export type Arg = { t: "path"; segments: string[] } | { t: "literal"; v: Literal };

/** Text with `{{path}}` holes: plain strings and path segment lists, in order. */
export type TextTemplate = (string | string[])[];

export type DataFrom =
	/** A registered `source(name, fn)`, with arguments. */
	| { t: "source"; source: string; args: Record<string, Arg> }
	/** A GET to a configured service: `inventory:GET /stock/{{params.slug}}`. */
	| { t: "api"; service: string; method: "GET"; path: TextTemplate };

export interface DataDecl {
	/** The name the template reads it under. */
	name: string;
	from: DataFrom;
	/** Missing (null or undefined) answers a 404. */
	required: boolean;
	/** `"session"`: load only for a visitor with a session; the fallback otherwise. */
	when?: "session";
	/** Used when the value is missing or the load fails (wrapped, so `null` is a value). */
	fallback?: { v: unknown };
	line: number;
}

/**
 * `<action review="reviews.add" auth="viewer">`: the template's
 * `action:review` runs the registered action `reviews.add`, for a visitor
 * the `auth` rule lets through ("viewer": anyone signed in; any other
 * name: a registered `guard`).
 */
export interface ActionDecl {
	/** The name the template uses: `@submit="action:review"`. */
	short: string;
	/** The registered `action(name, …)` it runs. */
	name: string;
	auth?: string;
	line: number;
}

export interface PageBlock {
	title?: TextTemplate;
	description?: TextTemplate;
	/** "off", or seconds a signed-out visitor's page is kept. */
	cache?: "off" | number;
	/** "none", or a layout file under `pages/` (`_bare` for `pages/_bare.uwu`). */
	layout?: string;
	data: DataDecl[];
	actions: ActionDecl[];
	line: number;
}

const IDENT = /^[A-Za-z_$][\w$]*$/;
const PATH = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$\d][\w$]*)*$/;
const SOURCE_NAME = /^[A-Za-z_$][\w$-]*(?:\.[A-Za-z_$][\w$-]*)*$/;
const SERVICE_CALL = /^([A-Za-z_][\w-]*):([A-Za-z]+)\s+(.+)$/;
const PAGE_ATTRIBUTES = new Set(["title", "description", "cache", "layout"]);
const FLAGS = new Set(["required", "when", "fallback"]);
/** An action's short name, as uwu accepts it after `action:`. */
const ACTION_SHORT = /^[A-Za-z_$][\w$.:-]*$/;
const GUARD = /^[A-Za-z_][\w.:-]*$/;

export interface Split {
	/** The file with the block replaced by newlines. */
	rest: string;
	block: PageBlock | null;
}

function lineAt(source: string, offset: number): number {
	let line = 1;
	for (let i = 0; i < offset && i < source.length; i++) if (source.charCodeAt(i) === 10) line++;
	return line;
}

function skipBlank(source: string, i: number): number {
	for (;;) {
		while (i < source.length && /\s/.test(source[i]!)) i++;
		if (source.startsWith("<!--", i)) {
			const end = source.indexOf("-->", i + 4);
			if (end < 0) return source.length;
			i = end + 3;
			continue;
		}
		return i;
	}
}

interface Tag {
	attrs: { name: string; value: string | true; offset: number }[];
	/** Offset just past `>`. */
	end: number;
	selfClosing: boolean;
}

/** Read the attributes of a tag whose name ends at `i`. */
function readTag(source: string, i: number, file: string, tag: string): Tag {
	const attrs: Tag["attrs"] = [];
	const seen = new Set<string>();
	const fail = (at: number, message: string): never => {
		throw new PageCompileError(file, lineAt(source, at), message);
	};
	for (;;) {
		while (i < source.length && /\s/.test(source[i]!)) i++;
		if (i >= source.length) fail(i, `<${tag}> is not closed`);
		if (source.startsWith("/>", i)) return { attrs, end: i + 2, selfClosing: true };
		if (source[i] === ">") return { attrs, end: i + 1, selfClosing: false };
		const start = i;
		while (i < source.length && /[^\s=>/"']/.test(source[i]!)) i++;
		const name = source.slice(start, i);
		if (!name) fail(i, `unexpected '${source[i]}' in <${tag}>`);
		if (seen.has(name)) fail(start, `<${tag}> has two '${name}' attributes`);
		seen.add(name);
		let value: string | true = true;
		if (source[i] === "=") {
			i++;
			const quote = source[i];
			if (quote === '"' || quote === "'") {
				const close = source.indexOf(quote, i + 1);
				if (close < 0) fail(i, `unterminated value for '${name}' in <${tag}>`);
				value = source.slice(i + 1, close);
				i = close + 1;
			} else {
				const valueStart = i;
				while (i < source.length && /[^\s>]/.test(source[i]!) && !source.startsWith("/>", i)) i++;
				value = source.slice(valueStart, i);
			}
		}
		attrs.push({ name, value, offset: start });
	}
}

/**
 * Find the `<page>` block at the top of a page file, parse and check it,
 * and hand back the rest for uwu.
 */
export function splitPageBlock(source: string, file: string): Split {
	const start = skipBlank(source, 0);
	if (!/^<page[\s/>]/.test(source.slice(start, start + 6))) {
		// Anywhere but the top is a mistake worth naming: uwu would treat it as markup.
		const later = /^[ \t]*<page[\s/>]/m.exec(source);
		if (later) {
			throw new PageCompileError(file, lineAt(source, later.index), "<page> must come first in the file, before <template>");
		}
		return { rest: source, block: null };
	}
	const line = lineAt(source, start);
	const open = readTag(source, start + 5, file, "page");
	const block: PageBlock = { data: [], actions: [], line };
	for (const attr of open.attrs) applyPageAttribute(block, attr, source, file);

	let end = open.end;
	if (!open.selfClosing) {
		let i = open.end;
		for (;;) {
			i = skipBlank(source, i);
			if (i >= source.length) throw new PageCompileError(file, line, "<page> is not closed: add </page>");
			if (source.startsWith("</page>", i)) {
				end = i + "</page>".length;
				break;
			}
			if (/^<data[\s/>]/.test(source.slice(i, i + 6))) {
				const tag = readTag(source, i + 5, file, "data");
				block.data.push(parseData(tag, file, lineAt(source, i)));
				i = tag.end;
				if (!tag.selfClosing) {
					const after = skipBlank(source, i);
					if (source.startsWith("</data>", after)) i = after + "</data>".length;
				}
				continue;
			}
			if (/^<action[\s/>]/.test(source.slice(i, i + 8))) {
				const tag = readTag(source, i + 7, file, "action");
				block.actions.push(parseAction(tag, file, lineAt(source, i)));
				i = tag.end;
				if (!tag.selfClosing) {
					const after = skipBlank(source, i);
					if (source.startsWith("</action>", after)) i = after + "</action>".length;
				}
				continue;
			}
			throw new PageCompileError(file, lineAt(source, i), "only <data> and <action> elements may sit inside <page>");
		}
	}

	const names = new Set<string>();
	for (const decl of block.data) {
		if (names.has(decl.name)) throw new PageCompileError(file, decl.line, `'${decl.name}' is declared twice in <page>`);
		names.add(decl.name);
	}
	const shorts = new Set<string>();
	for (const decl of block.actions) {
		if (shorts.has(decl.short)) throw new PageCompileError(file, decl.line, `action '${decl.short}' is declared twice in <page>`);
		shorts.add(decl.short);
	}

	const spanned = source.slice(0, end);
	const blank = spanned.replace(/[^\n]/g, "");
	return { rest: blank + source.slice(end), block };
}

function applyPageAttribute(block: PageBlock, attr: Tag["attrs"][number], source: string, file: string): void {
	const line = lineAt(source, attr.offset);
	if (!PAGE_ATTRIBUTES.has(attr.name)) {
		throw new PageCompileError(file, line, `<page> has no '${attr.name}' attribute (title, description, cache, layout)`);
	}
	if (attr.value === true) throw new PageCompileError(file, line, `<page ${attr.name}> needs a value`);
	const value = attr.value;
	switch (attr.name) {
		case "title":
		case "description":
			block[attr.name] = parseText(value, file, line, attr.name);
			return;
		case "cache":
			if (value === "off") block.cache = "off";
			else if (/^\d+$/.test(value)) block.cache = Number(value);
			else throw new PageCompileError(file, line, `<page cache="${value}">: "off" or a number of seconds`);
			return;
		case "layout":
			if (value !== "none" && !/^[\w./-]+$/.test(value)) {
				throw new PageCompileError(file, line, `<page layout="${value}">: "none" or a layout file under pages/`);
			}
			block.layout = value;
			return;
	}
}

function parseData(tag: Tag, file: string, line: number): DataDecl {
	let named: Tag["attrs"][number] | undefined;
	let required = false;
	let when: "session" | undefined;
	let fallback: { v: unknown } | undefined;
	for (const attr of tag.attrs) {
		if (FLAGS.has(attr.name)) {
			if (attr.name === "required") {
				if (attr.value !== true && attr.value !== "" && attr.value !== "required") {
					throw new PageCompileError(file, line, "'required' takes no value");
				}
				required = true;
			} else if (attr.name === "when") {
				if (attr.value !== "session") throw new PageCompileError(file, line, `when="${attr.value === true ? "" : attr.value}": only when="session" is known`);
				when = "session";
			} else {
				if (attr.value === true) throw new PageCompileError(file, line, "fallback needs a value, such as fallback=\"null\"");
				try {
					fallback = { v: JSON.parse(attr.value) };
				} catch {
					throw new PageCompileError(file, line, `fallback="${attr.value}" is not a literal: null, true, 0, "text", [] or {}`);
				}
			}
			continue;
		}
		if (named) {
			throw new PageCompileError(file, line, `<data> names one value; it has '${named.name}' and '${attr.name}'`);
		}
		named = attr;
	}
	if (!named) throw new PageCompileError(file, line, `<data> needs a name: <data product="products.bySlug slug=params.slug">`);
	if (!IDENT.test(named.name)) throw new PageCompileError(file, line, `<data ${named.name}>: a name is an identifier`);
	if (named.value === true || !named.value.trim()) {
		throw new PageCompileError(file, line, `<data ${named.name}> needs a source: ${named.name}="source.name arg=path"`);
	}
	if (required && fallback) throw new PageCompileError(file, line, `<data ${named.name}> is both required and has a fallback`);
	return { name: named.name, from: parseFrom(named.value.trim(), file, line, named.name), required, when, fallback, line };
}

function parseAction(tag: Tag, file: string, line: number): ActionDecl {
	let named: Tag["attrs"][number] | undefined;
	let auth: string | undefined;
	for (const attr of tag.attrs) {
		if (attr.name === "auth") {
			if (attr.value === true || !GUARD.test(attr.value)) {
				throw new PageCompileError(file, line, `<action auth> names a rule: auth="viewer", or a registered guard("name", …)`);
			}
			auth = attr.value;
			continue;
		}
		if (named) throw new PageCompileError(file, line, `<action> names one action; it has '${named.name}' and '${attr.name}'`);
		named = attr;
	}
	if (!named) throw new PageCompileError(file, line, `<action> needs a name: <action review="reviews.add">`);
	if (!ACTION_SHORT.test(named.name)) throw new PageCompileError(file, line, `<action ${named.name}>: not a name uwu accepts after action:`);
	if (named.value === true || !SOURCE_NAME.test(named.value.trim())) {
		throw new PageCompileError(file, line, `<action ${named.name}> needs the registered action it runs: ${named.name}="area.name"`);
	}
	return { short: named.name, name: named.value.trim(), auth, line };
}

function parseFrom(spec: string, file: string, line: number, name: string): DataFrom {
	const call = SERVICE_CALL.exec(spec);
	if (call) {
		const [, service, method, path] = call;
		if (method!.toUpperCase() !== "GET") {
			throw new PageCompileError(file, line, `<data ${name}>: a page loads with GET only, not ${method!.toUpperCase()}`);
		}
		if (!path!.startsWith("/") || path!.startsWith("//")) {
			throw new PageCompileError(file, line, `<data ${name}>: the path starts with one '/' (the service's base URL is configured)`);
		}
		const text = parseText(path!, file, line, name);
		if (text.some((part) => typeof part === "string" && /\s/.test(part))) {
			throw new PageCompileError(file, line, `<data ${name}>: a service path has no spaces`);
		}
		return { t: "api", service: service!, method: "GET", path: text };
	}
	const tokens = tokenize(spec, file, line, name);
	const source = tokens.shift()!;
	if (!SOURCE_NAME.test(source)) {
		throw new PageCompileError(file, line, `<data ${name}>: '${source}' is not a source name (or service:GET /path)`);
	}
	const args: Record<string, Arg> = {};
	for (const token of tokens) {
		const eq = token.indexOf("=");
		const key = eq > 0 ? token.slice(0, eq) : "";
		if (!IDENT.test(key)) {
			throw new PageCompileError(file, line, `<data ${name}>: '${token}' is not an argument (key=path or key=literal)`);
		}
		if (key in args) throw new PageCompileError(file, line, `<data ${name}>: argument '${key}' is given twice`);
		args[key] = parseArg(token.slice(eq + 1), file, line, name);
	}
	return { t: "source", source, args };
}

/** Split on whitespace outside quotes. */
function tokenize(spec: string, file: string, line: number, name: string): string[] {
	const out: string[] = [];
	let current = "";
	let quote = "";
	for (const char of spec) {
		if (quote) {
			current += char;
			if (char === quote) quote = "";
		} else if (char === '"' || char === "'") {
			quote = char;
			current += char;
		} else if (/\s/.test(char)) {
			if (current) out.push(current);
			current = "";
		} else current += char;
	}
	if (quote) throw new PageCompileError(file, line, `<data ${name}>: unterminated string`);
	if (current) out.push(current);
	return out;
}

/** A dotted path or a literal; anything else (a call, an operator) is refused. */
export function parseArg(text: string, file: string, line: number, name: string): Arg {
	if (/^"[^"]*"$/.test(text) || /^'[^']*'$/.test(text)) return { t: "literal", v: text.slice(1, -1) };
	if (/^-?\d+(?:\.\d+)?$/.test(text)) return { t: "literal", v: Number(text) };
	if (text === "true" || text === "false") return { t: "literal", v: text === "true" };
	if (text === "null") return { t: "literal", v: null };
	if (PATH.test(text)) return { t: "path", segments: text.split(".") };
	throw new PageCompileError(
		file,
		line,
		`<data ${name}>: '${text}' is neither a dotted path nor a literal; no calls or expressions here (compute it in the source)`,
	);
}

/** `"{{product.name}} | Shop"` → `[["product","name"], " | Shop"]`. */
export function parseText(text: string, file: string, line: number, what: string): TextTemplate {
	const out: TextTemplate = [];
	let i = 0;
	while (i < text.length) {
		const open = text.indexOf("{{", i);
		if (open < 0) {
			out.push(text.slice(i));
			break;
		}
		if (open > i) out.push(text.slice(i, open));
		const close = text.indexOf("}}", open + 2);
		if (close < 0) throw new PageCompileError(file, line, `${what}: '{{' is not closed`);
		const inner = text.slice(open + 2, close).trim();
		if (!PATH.test(inner)) {
			throw new PageCompileError(file, line, `${what}: {{${inner}}} is not a dotted path; no calls or expressions here`);
		}
		out.push(inner.split("."));
		i = close + 2;
	}
	return out;
}

/** The paths a text template reads. */
export function textPaths(text: TextTemplate | undefined): string[][] {
	return (text ?? []).filter((part): part is string[] => Array.isArray(part));
}
