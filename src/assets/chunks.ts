import { basename } from "node:path";
import type { ChunkGraph, ChunkGraphInput, ChunkManifest, MountChunk } from "./contract.ts";

const STATIC = "import-statement";

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function buildChunkGraph(input: ChunkGraphInput): ChunkGraph {
	const prefix = input.publicPath.replace(/\/+$/, "");
	const urlOf = (output: string) => `${prefix}/${basename(output)}`;
	const outputs = Object.entries(input.meta.outputs).filter(([output]) => /\.m?js$/.test(output));
	const built = new Set(outputs.map(([output]) => urlOf(output)));

	const imports: Record<string, string[]> = {};
	for (const [output, info] of outputs) {
		const url = urlOf(output);
		const list = new Set<string>();
		for (const entry of info.imports ?? []) {
			const to = urlOf(entry.path);
			if (entry.kind === STATIC && to !== url && built.has(to)) list.add(to);
		}
		if (list.size > 0) imports[url] = [...list].sort(byText);
	}

	const outputOf = new Map<string, string>();
	for (const [output, info] of outputs) if (info.entryPoint !== undefined && !outputOf.has(info.entryPoint)) outputOf.set(info.entryPoint, urlOf(output));

	const sourceClosure = (source: string): Set<string> => {
		const seen = new Set<string>([source]);
		const queue = [source];
		for (let at = 0; at < queue.length; at++) {
			for (const entry of input.meta.inputs[queue[at]!]?.imports ?? []) {
				if (entry.kind === "dynamic-import" || seen.has(entry.path)) continue;
				seen.add(entry.path);
				queue.push(entry.path);
			}
		}
		return seen;
	};

	const mounts: Record<string, MountChunk[]> = {};
	for (const [source, url] of outputOf) {
		const within = sourceClosure(source);
		const found = new Map<string, MountChunk>();
		for (const site of input.sites) {
			if (!within.has(site.from)) continue;
			const chunk = outputOf.get(site.module);
			if (chunk === undefined || chunk === url) continue;
			found.set(`${site.selector}\n${chunk}`, { selector: site.selector, chunk });
		}
		if (found.size > 0) mounts[url] = [...found.values()].sort((a, b) => byText(a.selector, b.selector) || byText(a.chunk, b.chunk));
	}

	return { imports: sorted(imports), mounts: sorted(mounts) };
}

function sorted<T>(record: Record<string, T>): Record<string, T> {
	const out: Record<string, T> = {};
	for (const key of Object.keys(record).sort(byText)) out[key] = record[key]!;
	return out;
}

export function chunkManifest(graph: ChunkGraph): ChunkManifest {
	const m: ChunkManifest["m"] = {};
	for (const [entry, list] of Object.entries(graph.mounts)) m[entry] = list.map((site): [string, string] => [site.selector, site.chunk]);
	const i: ChunkManifest["i"] = {};
	for (const [url, list] of Object.entries(graph.imports)) i[url] = [...list];
	return { i, m };
}

export function staticClosure(graph: ChunkGraph, urls: string[]): string[] {
	const roots = new Set(urls);
	const seen = new Set<string>();
	const queue = [...urls];
	for (let at = 0; at < queue.length; at++) {
		for (const to of graph.imports[queue[at]!] ?? []) {
			if (seen.has(to)) continue;
			seen.add(to);
			queue.push(to);
		}
	}
	return [...seen].filter((url) => !roots.has(url)).sort(byText);
}

export function chunksMeta(manifestUrl: string, max?: number): string {
	const escaped = manifestUrl.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
	const limit = max !== undefined && Number.isInteger(max) && max >= 0 ? ` data-max="${max}"` : "";
	return `<meta name="natsu-chunks" content="${escaped}"${limit}>`;
}
