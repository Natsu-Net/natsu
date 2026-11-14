import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
	AssetKind,
	AssetRule,
	DiscoveredRef,
	DiscoverInput,
	DiscoverOverride,
	Discovery,
	RemoteRef,
} from "./contract.ts";

export interface ScannedTag {
	tag: "script" | "link";
	ref: string;
	attributes: Record<string, string>;
	dynamic: boolean;
}

const DEFAULT_EXTENSIONS = [".html", ".htm", ".uwu"];
const DEFAULT_AS_IS: AssetRule[] = [/\.min\.js$/];
const SCRIPT_ALTERNATES = [".ts", ".tsx", ".mjs"];
const SKIPPED_DIRECTORIES = new Set(["node_modules"]);

function compare(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

function isSpace(code: number): boolean {
	return code === 32 || code === 9 || code === 10 || code === 13 || code === 12;
}

function isDynamic(value: string): boolean {
	return value.includes("{{") || value.includes("{%") || value.includes("${");
}

function nameAt(text: string, at: number, name: string): boolean {
	if (at + name.length > text.length) return false;
	for (let index = 0; index < name.length; index++) {
		if ((text.charCodeAt(at + index) | 32) !== name.charCodeAt(index)) return false;
	}
	const after = text.charCodeAt(at + name.length);
	return Number.isNaN(after) || isSpace(after) || after === 62 || after === 47;
}

function finder(text: string): (needle: string, from: number) => number {
	const none = new Map<string, number>();
	return (needle, from) => {
		const known = none.get(needle);
		if (known !== undefined && from >= known) return -1;
		const found = text.indexOf(needle, from);
		if (found === -1) none.set(needle, known === undefined ? from : Math.min(known, from));
		return found;
	};
}

function expressionEnd(text: string, at: number, find: (needle: string, from: number) => number): number {
	if (text.charCodeAt(at) !== 123) return -1;
	const next = text.charCodeAt(at + 1);
	if (next !== 123 && next !== 37) return -1;
	const close = find(next === 123 ? "}}" : "%}", at + 2);
	return close === -1 ? -1 : close + 2;
}

function readTag(
	text: string,
	from: number,
	find: (needle: string, from: number) => number,
): { attributes: Record<string, string>; end: number; closed: boolean } {
	const attributes: Record<string, string> = Object.create(null);
	const length = text.length;
	let at = from;
	while (at < length) {
		const code = text.charCodeAt(at);
		if (code === 62) return { attributes, end: at + 1, closed: true };
		if (isSpace(code) || code === 47) {
			at++;
			continue;
		}
		const skip = expressionEnd(text, at, find);
		if (skip !== -1) {
			at = skip;
			continue;
		}
		const start = at;
		while (at < length) {
			const inner = text.charCodeAt(at);
			if (isSpace(inner) || inner === 61 || inner === 62 || inner === 47) break;
			at++;
		}
		if (at === start) {
			at++;
			continue;
		}
		const name = text.slice(start, at).toLowerCase();
		while (at < length && isSpace(text.charCodeAt(at))) at++;
		let value = "";
		if (text.charCodeAt(at) === 61) {
			at++;
			while (at < length && isSpace(text.charCodeAt(at))) at++;
			const quote = text.charCodeAt(at);
			if (quote === 34 || quote === 39) {
				at++;
				const open = at;
				while (at < length && text.charCodeAt(at) !== quote) {
					const jump = expressionEnd(text, at, find);
					at = jump === -1 ? at + 1 : jump;
				}
				value = text.slice(open, Math.min(at, length));
				at = Math.min(at + 1, length);
			} else {
				const open = at;
				while (at < length) {
					const inner = text.charCodeAt(at);
					if (isSpace(inner) || inner === 62) break;
					const jump = expressionEnd(text, at, find);
					at = jump === -1 ? at + 1 : jump;
				}
				value = text.slice(open, Math.min(at, length));
			}
		}
		if (!(name in attributes)) attributes[name] = value;
	}
	return { attributes, end: length, closed: false };
}

function scriptEnd(text: string, from: number): number {
	let at = from;
	for (;;) {
		const close = text.indexOf("</", at);
		if (close === -1) return -1;
		if (nameAt(text, close + 2, "script")) return close + 8;
		at = close + 2;
	}
}

export function scanTemplate(text: string): ScannedTag[] {
	const found: ScannedTag[] = [];
	const find = finder(text);
	let at = 0;
	for (;;) {
		const open = text.indexOf("<", at);
		if (open === -1) break;
		if (text.startsWith("<!--", open)) {
			const end = text.indexOf("-->", open + 4);
			if (end === -1) break;
			at = end + 3;
			continue;
		}
		const tag = nameAt(text, open + 1, "script") ? "script" : nameAt(text, open + 1, "link") ? "link" : undefined;
		if (!tag) {
			at = open + 1;
			continue;
		}
		const { attributes, end, closed } = readTag(text, open + 1 + tag.length, find);
		if (!closed) break;
		at = end;
		if (tag === "script") {
			const ref = (attributes.src ?? "").trim();
			if (ref !== "") found.push({ tag, ref, attributes: { ...attributes }, dynamic: isDynamic(ref) });
			const close = scriptEnd(text, end);
			if (close === -1) break;
			at = close;
			continue;
		}
		const ref = (attributes.href ?? "").trim();
		const rel = (attributes.rel ?? "").toLowerCase().split(/[ \t\n\r\f]+/);
		if (ref !== "" && rel.includes("stylesheet")) {
			found.push({ tag, ref, attributes: { ...attributes }, dynamic: isDynamic(ref) });
		}
	}
	return found;
}

function withoutQuery(ref: string): string {
	let end = ref.length;
	const query = ref.indexOf("?");
	if (query !== -1) end = query;
	const fragment = ref.indexOf("#");
	if (fragment !== -1 && fragment < end) end = fragment;
	return ref.slice(0, end);
}

function slug(value: string): string {
	return value.replace(/[^A-Za-z0-9_]+/g, "-").replace(/^-+|-+$/g, "");
}

function withoutExtension(path: string): string {
	const slash = path.lastIndexOf("/");
	const dot = path.lastIndexOf(".");
	return dot > slash + 1 ? path.slice(0, dot) : path;
}

export function entryName(kind: AssetKind, ref: string, taken: ReadonlySet<string>): string {
	const prefix = kind === "style" ? "css" : "js";
	const path = withoutExtension(withoutQuery(ref));
	const stem = slug(path.slice(path.lastIndexOf("/") + 1)) || "asset";
	const short = `${prefix}-${stem}`;
	if (!taken.has(short)) return short;
	const full = `${prefix}-${slug(path) || "asset"}`;
	if (!taken.has(full)) return full;
	for (let count = 2; ; count++) {
		const numbered = `${full}-${count}`;
		if (!taken.has(numbered)) return numbered;
	}
}

function matches(rules: AssetRule[], value: string): boolean {
	for (const rule of rules) {
		if (typeof rule === "string") {
			if (rule.endsWith("*") ? value.startsWith(rule.slice(0, -1)) : value === rule) return true;
			continue;
		}
		rule.lastIndex = 0;
		if (rule.test(value)) return true;
	}
	return false;
}

function shown(cwd: string, path: string): string {
	const inside = relative(cwd, path);
	if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) return path;
	return sep === "/" ? inside : inside.split(sep).join("/");
}

async function real(path: string): Promise<string | undefined> {
	try {
		return await realpath(path);
	} catch {
		return undefined;
	}
}

async function isFile(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isFile();
	} catch {
		return false;
	}
}

async function templateFiles(cwd: string, templates: string[], extensions: string[]): Promise<string[]> {
	const found = new Set<string>();
	const seen = new Set<string>();
	const wanted = (name: string) => extensions.some((extension) => name.endsWith(extension));
	const walk = async (directory: string, named: string): Promise<void> => {
		const actual = await real(directory);
		if (actual === undefined) throw new Error(`discover: cannot read template directory ${named}`);
		if (seen.has(actual)) return;
		seen.add(actual);
		let entries;
		try {
			entries = await readdir(directory, { withFileTypes: true });
		} catch (cause) {
			throw new Error(`discover: cannot read template directory ${named}`, { cause });
		}
		entries.sort((a, b) => compare(a.name, b.name));
		for (const entry of entries) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) {
				if (!SKIPPED_DIRECTORIES.has(entry.name)) await walk(path, shown(cwd, path));
				continue;
			}
			if (entry.isSymbolicLink()) {
				let info;
				try {
					info = await stat(path);
				} catch {
					continue;
				}
				if (info.isDirectory()) {
					if (!SKIPPED_DIRECTORIES.has(entry.name)) await walk(path, shown(cwd, path));
				} else if (info.isFile() && wanted(entry.name)) found.add(path);
				continue;
			}
			if (entry.isFile() && wanted(entry.name)) found.add(path);
		}
	};
	for (const template of [...templates].sort(compare)) {
		const path = resolve(cwd, template);
		let info;
		try {
			info = await stat(path);
		} catch (cause) {
			throw new Error(`discover: cannot read template directory ${template}`, { cause });
		}
		if (info.isDirectory()) await walk(path, template);
		else found.add(path);
	}
	return [...found].sort(compare);
}

interface Occurrence {
	tag: "script" | "link";
	attributes: Record<string, string>;
	templates: Set<string>;
}

interface Resolved {
	ref: string;
	kind: AssetKind;
	file: string;
	actual: string;
	override: DiscoverOverride | undefined;
}

type Lookup = { file: string; actual: string } | { reason: string };

async function lookup(
	ref: string,
	roots: Array<[prefix: string, directory: string]>,
	cwd: string,
	alternates: boolean,
): Promise<Lookup> {
	const path = withoutQuery(ref);
	const root = roots.find(([prefix]) => path.startsWith(prefix));
	if (!root) return { reason: "no root matches this path" };
	const rest = path.slice(root[0].length);
	if (rest === "" || rest.includes("\0")) return { reason: "no file named after the root prefix" };
	const directory = resolve(cwd, root[1]);
	const actualRoot = await real(directory);
	if (actualRoot === undefined) return { reason: `root directory ${root[1]} does not exist` };
	const fence = actualRoot.endsWith(sep) ? actualRoot : actualRoot + sep;
	const candidates = [rest];
	if (alternates && rest.endsWith(".js")) {
		for (const extension of SCRIPT_ALTERNATES) candidates.push(rest.slice(0, -3) + extension);
	}
	let outside = false;
	for (const candidate of candidates) {
		const file = resolve(directory, `.${sep}${candidate}`);
		const actual = await real(file);
		if (actual === undefined) continue;
		if (!actual.startsWith(fence)) {
			outside = true;
			continue;
		}
		if (!(await isFile(actual))) continue;
		return { file: shown(cwd, file), actual };
	}
	return { reason: outside ? `resolves outside root directory ${root[1]}` : `no file under ${root[1]}` };
}

function stemOf(path: string): string {
	const base = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf(sep)) + 1);
	const dot = base.lastIndexOf(".");
	return dot > 0 ? base.slice(0, dot) : base;
}

function sorted<T>(record: Record<string, T>): Record<string, T> {
	const out: Record<string, T> = {};
	for (const key of Object.keys(record).sort(compare)) out[key] = record[key]!;
	return out;
}

export async function discoverAssets(input: DiscoverInput): Promise<Discovery> {
	const cwd = resolve(input.cwd ?? process.cwd());
	const extensions = input.extensions ?? DEFAULT_EXTENSIONS;
	const asIs = input.asIs ?? DEFAULT_AS_IS;
	const overrides = input.overrides ?? {};
	const explicit = input.explicit ?? {};
	const explicitRewrite = explicit.rewrite ?? {};
	const isBlocked = input.isBlocked ?? (() => false);
	const roots = Object.entries(input.roots ?? {}).sort((a, b) => b[0].length - a[0].length || compare(a[0], b[0]));

	const occurrences = new Map<string, Occurrence>();
	for (const file of await templateFiles(cwd, input.templates ?? [], extensions)) {
		let text: string;
		try {
			text = await readFile(file, "utf8");
		} catch (cause) {
			throw new Error(`discover: cannot read template ${shown(cwd, file)}`, { cause });
		}
		const template = shown(cwd, file);
		for (const tag of scanTemplate(text)) {
			const seen = occurrences.get(tag.ref);
			if (seen) seen.templates.add(template);
			else occurrences.set(tag.ref, { tag: tag.tag, attributes: tag.attributes, templates: new Set([template]) });
		}
	}

	const refs = new Map<string, DiscoveredRef>();
	const remote: RemoteRef[] = [];
	const resolved: Resolved[] = [];
	const order = [...occurrences.keys()].sort(compare);

	for (const ref of order) {
		const seen = occurrences.get(ref)!;
		const base = { ref, tag: seen.tag, templates: [...seen.templates].sort(compare) };
		const skip = (outcome: DiscoveredRef["outcome"], reason: string) => {
			refs.set(ref, { ...base, outcome, reason });
		};
		if (isBlocked(ref)) {
			skip("blocked", "matches a block rule");
			continue;
		}
		if (isDynamic(ref)) {
			skip("dynamic", "the path holds a template expression");
			continue;
		}
		if (Object.hasOwn(explicitRewrite, ref)) {
			refs.set(ref, { ...base, outcome: "explicit", name: explicitRewrite[ref]! });
			continue;
		}
		const override = Object.hasOwn(overrides, ref) ? overrides[ref] : undefined;
		if (override?.skip) {
			skip("left-out", "left out by an override");
			continue;
		}
		if (/^https?:\/\//i.test(ref) || ref.startsWith("//")) {
			if (!input.remote) {
				skip("left-out", "remote assets are off");
				continue;
			}
			const integrity = seen.attributes.integrity;
			remote.push({
				ref,
				url: ref.startsWith("//") ? `https:${ref}` : ref,
				kind: seen.tag === "script" ? "script" : "style",
				...(integrity ? { integrity } : {}),
			});
			refs.set(ref, { ...base, outcome: "remote" });
			continue;
		}
		if (/^[a-z][a-z0-9+.-]*:/i.test(ref)) {
			skip("unsupported", `scheme ${ref.slice(0, ref.indexOf(":") + 1)} is not handled`);
			continue;
		}
		const path = withoutQuery(ref);
		const kind: AssetKind =
			override?.kind ??
			(matches(asIs, ref) || matches(asIs, path)
				? "file"
				: seen.tag === "link"
					? "style"
					: (seen.attributes.type ?? "").trim().toLowerCase() === "module"
						? "module"
						: "classic");
		let found: Lookup;
		if (override?.file !== undefined) {
			const file = resolve(cwd, override.file);
			const actual = await real(file);
			found =
				actual !== undefined && (await isFile(actual))
					? { file: shown(cwd, file), actual }
					: { reason: `override file ${override.file} does not exist` };
		} else {
			found = await lookup(ref, roots, cwd, kind === "module" || kind === "classic");
		}
		if ("reason" in found) {
			skip("missing", found.reason);
			continue;
		}
		resolved.push({ ref, kind, file: found.file, actual: found.actual, override });
	}

	const actualOf = async (file: string) => (await real(resolve(cwd, file))) ?? resolve(cwd, file);
	const explicitByFile: Record<AssetKind, Map<string, string>> = {
		module: new Map(),
		classic: new Map(),
		file: new Map(),
		style: new Map(),
	};
	const taken = new Set<string>();
	const pairs: Array<[AssetKind, Record<string, string> | undefined]> = [
		["module", explicit.scripts],
		["classic", explicit.classicScripts],
		["file", explicit.files],
	];
	for (const [kind, entries] of pairs) {
		for (const name of Object.keys(entries ?? {}).sort(compare)) {
			taken.add(name);
			const actual = await actualOf(entries![name]!);
			if (!explicitByFile[kind].has(actual)) explicitByFile[kind].set(actual, name);
		}
	}
	for (const name of Object.keys(explicit.styles ?? {}).sort(compare)) {
		taken.add(name);
		const files = explicit.styles![name]!;
		if (files.length !== 1) continue;
		const actual = await actualOf(files[0]!);
		if (!explicitByFile.style.has(actual)) explicitByFile.style.set(actual, name);
	}

	const identity = (entry: Resolved) => `${entry.kind}\0${entry.actual}`;
	const assigned = new Map<string, string>();
	const owner = new Map<string, string>();
	const fresh = new Map<string, Resolved>();

	for (const entry of resolved) {
		const name = entry.override?.name;
		if (name === undefined) continue;
		const key = identity(entry);
		const held = assigned.get(key);
		if (held === name) continue;
		if (held !== undefined) {
			throw new Error(`discover: override name "${name}" for ${entry.ref} collides with "${held}" given to ${owner.get(held)} for the same file`);
		}
		if (taken.has(name)) {
			const other = owner.get(name);
			throw new Error(`discover: override name "${name}" for ${entry.ref} collides with ${other ? `the name given to ${other}` : "an explicit entry"}`);
		}
		taken.add(name);
		assigned.set(key, name);
		owner.set(name, entry.ref);
		fresh.set(name, entry);
	}
	for (const entry of resolved) {
		const key = identity(entry);
		if (assigned.has(key)) continue;
		const existing = explicitByFile[entry.kind].get(entry.actual);
		if (existing !== undefined) {
			assigned.set(key, existing);
			continue;
		}
		const name = entryName(entry.kind, entry.ref, taken);
		taken.add(name);
		assigned.set(key, name);
		owner.set(name, entry.ref);
		fresh.set(name, entry);
	}

	const stems = new Map<string, { actual: string; label: string }>();
	for (const [actual, name] of explicitByFile.module) {
		const stem = stemOf(actual);
		if (!stems.has(stem)) stems.set(stem, { actual, label: `explicit entry "${name}"` });
	}
	for (const name of [...fresh.keys()].sort(compare)) {
		const entry = fresh.get(name)!;
		if (entry.kind !== "module") continue;
		const stem = stemOf(entry.actual);
		const other = stems.get(stem);
		if (other && other.actual !== entry.actual) {
			throw new Error(
				`discover: module scripts ${other.label} and ref "${entry.ref}" both build from a file named "${stem}"; set overrides[ref].kind or overrides[ref].skip on one of them`,
			);
		}
		if (!other) stems.set(stem, { actual: entry.actual, label: `ref "${entry.ref}"` });
	}

	const scripts: Record<string, string> = {};
	const classicScripts: Record<string, string> = {};
	const files: Record<string, string> = {};
	const styles: Record<string, string[]> = {};
	const rewrite: Record<string, string> = {};
	for (const [name, entry] of fresh) {
		if (entry.kind === "module") scripts[name] = entry.file;
		else if (entry.kind === "classic") classicScripts[name] = entry.file;
		else if (entry.kind === "file") files[name] = entry.file;
		else styles[name] = [entry.file];
	}
	for (const entry of resolved) {
		const seen = occurrences.get(entry.ref)!;
		const name = assigned.get(identity(entry))!;
		rewrite[entry.ref] = name;
		refs.set(entry.ref, {
			ref: entry.ref,
			outcome: entry.kind,
			tag: seen.tag,
			templates: [...seen.templates].sort(compare),
			name,
			file: entry.file,
		});
	}

	const all = order.map((ref) => refs.get(ref)!);
	const skippedOutcomes = new Set(["dynamic", "missing", "unsupported", "blocked", "left-out"]);
	return {
		scripts: sorted(scripts),
		classicScripts: sorted(classicScripts),
		files: sorted(files),
		styles: sorted(styles),
		rewrite: sorted(rewrite),
		remote: remote.sort((a, b) => compare(a.ref, b.ref)),
		refs: all,
		skipped: all.filter((ref) => skippedOutcomes.has(ref.outcome)),
	};
}
