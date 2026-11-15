import { escapeHtml } from "../pages/meta.ts";
import type { ChunkGraph } from "./contract.ts";

const MAX_HINTS = 12;

function closure(scripts: string[], graph: ChunkGraph): string[] {
	const seen = new Set<string>(scripts);
	const found: string[] = [];
	let level = scripts;
	while (level.length > 0) {
		const next: string[] = [];
		for (const url of level) {
			const imports = Object.hasOwn(graph.imports, url) ? graph.imports[url] : undefined;
			if (!Array.isArray(imports)) continue;
			for (const dependency of imports) {
				if (typeof dependency !== "string" || seen.has(dependency)) continue;
				seen.add(dependency);
				found.push(dependency);
				next.push(dependency);
			}
		}
		level = next;
	}
	return found;
}

function linked(present: string, url: string): boolean {
	return present.includes(url) || present.includes(escapeHtml(url));
}

export function modulePreloads(scripts: string[], graph: ChunkGraph, present: string, nonce?: string): string {
	let out = "";
	let count = 0;
	const attribute = nonce ? ` nonce="${escapeHtml(nonce)}"` : "";
	for (const url of closure(scripts, graph)) {
		if (count >= MAX_HINTS) break;
		if (!url || linked(present, url)) continue;
		out += `<link rel="modulepreload" href="${escapeHtml(url)}"${attribute} data-natsu-warm>`;
		count++;
	}
	return out;
}

export function stylePreloads(urls: string[], present: string): string {
	let out = "";
	const seen = new Set<string>();
	for (const url of urls) {
		if (seen.size >= MAX_HINTS) break;
		if (!url || seen.has(url) || linked(present, url)) continue;
		seen.add(url);
		out += `<link rel="preload" as="style" href="${escapeHtml(url)}" data-natsu-warm>`;
	}
	return out;
}
