import { escapeHtml } from "../pages/meta.ts";
import type { HeadAttributes, HeadRenderOptions, HeadTag, HeadTags } from "./contract.ts";

const TAGS = new Set(["link", "meta", "script"]);
const ATTRIBUTE_NAME = /^[a-zA-Z][\w:.-]*$/;
const SCHEME = /^[\t\n\f\r ]*([a-zA-Z][a-zA-Z0-9+.-]*):/;
const RESOURCE_RELS = new Set(["stylesheet", "preload", "modulepreload", "prefetch"]);
const MAX_TAGS = 64;

const store = new WeakMap<object, Map<string, HeadTag>>();

function problem(tag: unknown, attributes: unknown): string | undefined {
	if (typeof tag !== "string" || !TAGS.has(tag)) return `head tag <${String(tag)}> is not allowed, only link, meta and script`;
	if (typeof attributes !== "object" || attributes === null || Array.isArray(attributes)) return `head tag <${tag}> needs an attributes object`;
	for (const [name, value] of Object.entries(attributes)) {
		if (!ATTRIBUTE_NAME.test(name)) return `head tag <${tag}> attribute name ${JSON.stringify(name)} is not allowed`;
		if (name.toLowerCase().startsWith("on")) return `head tag <${tag}> attribute ${name} is an event handler`;
		if (value !== undefined && typeof value !== "string" && typeof value !== "boolean") return `head tag <${tag}> attribute ${name} must be a string or boolean`;
	}
	if (tag === "script") {
		const src = Object.entries(attributes).find(([name]) => name.toLowerCase() === "src")?.[1];
		if (typeof src !== "string" || src.trim() === "") return "head tag <script> needs a src";
		const scheme = SCHEME.exec(src)?.[1]?.toLowerCase();
		if (scheme !== undefined && scheme !== "http" && scheme !== "https") return `head tag <script> src ${JSON.stringify(src)} must be a path or an http(s) URL`;
	}
	return undefined;
}

function normalised(tag: HeadTag["tag"], attributes: HeadAttributes): HeadTag {
	const out: HeadAttributes = {};
	for (const [name, value] of Object.entries(attributes)) {
		if (value === undefined || value === false) continue;
		const key = name.toLowerCase();
		if (tag === "script" && key === "nonce") continue;
		out[key] = value;
	}
	return { tag, attributes: out };
}

function keyOf(tag: HeadTag): string {
	const names = Object.keys(tag.attributes).sort();
	return JSON.stringify([tag.tag, names.map((name) => [name, tag.attributes[name]])]);
}

function listOf(ctx: object): Map<string, HeadTag> {
	let list = store.get(ctx);
	if (!list) {
		list = new Map();
		store.set(ctx, list);
	}
	return list;
}

function push(ctx: object, tag: HeadTag): void {
	const list = listOf(ctx);
	const key = keyOf(tag);
	if (list.has(key) || list.size >= MAX_TAGS) return;
	list.set(key, tag);
}

function add(ctx: object, tag: HeadTag["tag"], attributes: HeadAttributes): void {
	const reason = problem(tag, attributes);
	if (reason) throw new Error(reason);
	push(ctx, normalised(tag, attributes));
}

export function headTags(ctx: object): HeadTags {
	const api: HeadTags = {
		link(attributes) {
			add(ctx, "link", attributes);
			return api;
		},
		meta(attributes) {
			add(ctx, "meta", attributes);
			return api;
		},
		script(attributes) {
			add(ctx, "script", attributes);
			return api;
		},
		preload(href, as, attributes = {}) {
			const font = as === "font" && !Object.keys(attributes).some((name) => name.toLowerCase() === "crossorigin");
			add(ctx, "link", { rel: "preload", href, as, ...(font ? { crossorigin: "anonymous" } : {}), ...attributes });
			return api;
		},
		modulepreload(href) {
			add(ctx, "link", { rel: "modulepreload", href });
			return api;
		},
		list() {
			return headTagsOf(ctx);
		},
	};
	return api;
}

export function headTagsOf(ctx: object): HeadTag[] {
	const list = store.get(ctx);
	if (!list) return [];
	return [...list.values()].map((tag) => ({ tag: tag.tag, attributes: { ...tag.attributes } }));
}

export function addHeadTags(ctx: object, tags: HeadTag[]): void {
	if (!Array.isArray(tags)) return;
	for (const tag of tags) {
		if (typeof tag !== "object" || tag === null || problem(tag.tag, tag.attributes)) continue;
		push(ctx, normalised(tag.tag, tag.attributes));
	}
}

function resource(tag: HeadTag): string | undefined {
	if (tag.tag === "script") {
		const src = tag.attributes.src;
		return typeof src === "string" ? src : undefined;
	}
	if (tag.tag !== "link") return undefined;
	const rel = tag.attributes.rel;
	const href = tag.attributes.href;
	if (typeof rel !== "string" || typeof href !== "string" || href === "") return undefined;
	return rel.toLowerCase().split(/[\t\n\f\r ]+/).some((token) => RESOURCE_RELS.has(token)) ? href : undefined;
}

function referenced(present: string, tag: HeadTag["tag"], url: string): boolean {
	const scope = tag === "script" ? present : present.slice(0, headEnd(present) ?? present.length);
	const forms = new Set([url, escapeHtml(url), url.replace(/&/g, "&amp;")]);
	for (const form of forms) {
		for (const name of ["href", "src"]) {
			if (scope.includes(`${name}="${form}"`) || scope.includes(`${name}='${form}'`)) return true;
		}
	}
	return false;
}

function headEnd(html: string): number | undefined {
	const match = /<\/head\s*>/i.exec(html);
	return match ? match.index : undefined;
}

export function renderHeadTags(tags: HeadTag[], options: HeadRenderOptions = {}): string {
	if (!Array.isArray(tags)) return "";
	const nonce = options.nonce ? ` nonce="${escapeHtml(options.nonce)}"` : "";
	const seen = new Set<string>();
	let out = "";
	for (const raw of tags) {
		if (typeof raw !== "object" || raw === null || problem(raw.tag, raw.attributes)) continue;
		const tag = normalised(raw.tag, raw.attributes);
		const key = keyOf(tag);
		if (seen.has(key)) continue;
		seen.add(key);
		const url = resource(tag);
		if (url !== undefined && options.present && referenced(options.present, tag.tag, url)) continue;
		let text = `<${tag.tag}`;
		let preloadsModule = false;
		for (const [name, value] of Object.entries(tag.attributes)) {
			if (tag.tag === "link" && name === "nonce") continue;
			if (name === "rel" && typeof value === "string" && value.toLowerCase().trim() === "modulepreload") preloadsModule = true;
			text += value === true ? ` ${name}` : ` ${name}="${escapeHtml(String(value))}"`;
		}
		if (tag.tag === "script") out += `${text}${nonce}></script>`;
		else if (tag.tag === "link" && preloadsModule) out += `${text}${nonce}>`;
		else out += `${text}>`;
	}
	return out;
}

export function insertHeadTags(html: string, rendered: string): string {
	if (!rendered) return html;
	const at = headEnd(html);
	if (at === undefined) return html;
	return `${html.slice(0, at)}${rendered}${html.slice(at)}`;
}
