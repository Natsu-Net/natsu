/**
 * What a search engine reads in a page's head, without the page saying it
 * twice: the title is `<page title>` or, by default, the text of the page's
 * first `<h1>`; the description is `<page description>`; the canonical URL is
 * the configured public URL plus the path; and a page that read `viewer` or
 * `session` is about one visitor, so it says `noindex`.
 *
 * Layouts get it as `page`: `page.meta` (the fields), `page.title` and
 * `page.head`, the tags ready to drop into `<head>` with `{{{page.head}}}`,
 * the `<style>` of the files drawing this page included (`page.styles` is
 * that CSS alone).
 */

import type { TextTemplate } from "./block.ts";

export interface PageMeta {
	title: string;
	description: string;
	canonical: string;
	/** `"noindex"` or `""`. */
	robots: string;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decode(text: string): string {
	return text.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (whole, entity: string) => {
		if (entity[0] === "#") {
			const code = entity[1] === "x" || entity[1] === "X" ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1));
			return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole;
		}
		return ENTITIES[entity.toLowerCase()] ?? whole;
	});
}

export function escapeHtml(text: string): string {
	return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** The text of the first `<h1>` in `html`, tags stripped and entities read. */
export function firstHeading(html: string): string {
	const match = /<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/i.exec(html);
	if (!match) return "";
	return decode(match[1]!.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
}

/** Fill a `{{path}}` text with values (as text, not escaped: `headTags` escapes). */
export function fillText(text: TextTemplate | undefined, values: Record<string, unknown>): string {
	if (!text) return "";
	let out = "";
	for (const part of text) {
		if (typeof part === "string") out += part;
		else {
			let current: unknown = values;
			for (const segment of part) current = current === null || current === undefined ? undefined : (current as Record<string, unknown>)[segment];
			out += current === null || current === undefined ? "" : String(current);
		}
	}
	return out;
}

export function headTags(meta: PageMeta): string {
	let out = meta.title ? `<title>${escapeHtml(meta.title)}</title>` : "";
	if (meta.description) out += `<meta name="description" content="${escapeHtml(meta.description)}">`;
	if (meta.canonical) out += `<link rel="canonical" href="${escapeHtml(meta.canonical)}">`;
	if (meta.robots) out += `<meta name="robots" content="${meta.robots}">`;
	return out;
}
