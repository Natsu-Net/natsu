/**
 * What reading a page's CSS shape costs, on the seven hub pages in
 * `tests/fixtures/shapes`.
 *
 * Every page that goes out has its shape read to pick its chunk, so this is
 * a cost per page view, paid on top of the render. Measured on a warm
 * pipeline (every shape remembered, as in a running server), per page:
 *
 * - `pageStyle`: the chunk for a page, nothing else;
 * - `rewrite`: the whole rewrite a page goes through, links and all;
 * - `rewrite, renamed`: the same with class renaming on;
 *
 * and, with `--against`, the same calls on another checkout's pipeline (the
 * one before a change), in the same process, taking turns, so both see the
 * same machine. Each number is the median of `--runs` calls, in µs.
 *
 *   bun run bench/page-shape.ts [--runs 2000] [--against ../../natsu-main/v2]
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { profileDocument } from "uwu-template/assets";
import { renameAndProfile } from "uwu-template/assets/mangle";
import { Assets } from "../src/assets.ts";
import { setColorEnabled, setLogSink } from "../src/logger.ts";

setColorEnabled(false);
setLogSink(() => {});

function flag(name: string): string | undefined {
	const index = Bun.argv.indexOf(`--${name}`);
	return index === -1 ? undefined : Bun.argv[index + 1];
}

const RUNS = Number(flag("runs") ?? 2000);
const AGAINST = flag("against");
const FIXTURES = join(import.meta.dir, "..", "tests", "fixtures", "shapes");
const PAGES = readdirSync(FIXTURES)
	.filter((file) => file.endsWith(".html"))
	.sort()
	.map((file) => ({ name: file.slice(0, -".html".length), html: readFileSync(join(FIXTURES, file), "utf8") }));

type Pipeline = {
	build(): Promise<unknown>;
	rewrite(html: string): string;
	pageStyle(name: string, html: string): string;
};
type PipelineClass = new (options: Record<string, unknown>) => Pipeline;

const out = mkdtempSync(join(tmpdir(), "natsu-bench-shapes-"));

async function pipelines(Class: PipelineClass, label: string) {
	const make = async (renamed: boolean) => {
		const pipeline = new Class({
			outDir: join(out, `${label}-${renamed}`),
			minify: true,
			styles: { site: [join(FIXTURES, "site.css")] },
			safelist: [/^text-danger$/],
			rewrite: { "/assets/site.css": "site" },
			...(renamed ? { mangle: { scripts: [], markup: [FIXTURES] } } : {}),
		});
		await pipeline.build();
		// Every shape remembered, every value seen: a server that has been up a while.
		for (const page of PAGES) pipeline.rewrite(page.html);
		return pipeline;
	};
	return { plain: await make(false), renamed: await make(true) };
}

/** Median µs of `runs` calls, taking turns between the candidates so drift hits them alike. */
function race(candidates: Array<() => unknown>, runs: number): number[] {
	const times = candidates.map(() => new Float64Array(runs));
	for (const run of candidates) for (let i = 0; i < 200; i++) run();
	for (let i = 0; i < runs; i++) {
		for (let c = 0; c < candidates.length; c++) {
			const start = Bun.nanoseconds();
			candidates[c]!();
			times[c]![i] = Bun.nanoseconds() - start;
		}
	}
	return times.map((list) => {
		list.sort();
		return list[runs >> 1]! / 1000;
	});
}

const now = await pipelines(Assets as unknown as PipelineClass, "now");
const before = AGAINST
	? await pipelines((await import(resolve(AGAINST, "src/assets.ts"))).Assets as PipelineClass, "before")
	: undefined;

const operations: Array<{ label: string; call: (set: Awaited<ReturnType<typeof pipelines>>, html: string) => unknown }> = [
	{ label: "pageStyle", call: (set, html) => set.plain.pageStyle("site", html) },
	{ label: "rewrite", call: (set, html) => set.plain.rewrite(html) },
	{ label: "rewrite, renamed", call: (set, html) => set.renamed.rewrite(html) },
];

const fmt = (n: number) => (n >= 100 ? n.toFixed(0) : n.toFixed(1));
const lines: string[] = [];
const header = ["page", "KB", "profileDocument", "renameAndProfile"];
for (const op of operations) header.push(...(before ? [`${op.label} before`, `${op.label} after`, "×"] : [op.label]));
lines.push(`| ${header.join(" | ")} |`, `|${header.map(() => "---").join("|")}|`);

const map = (now.renamed as unknown as { classes: Map<string, string> }).classes;
for (const page of PAGES) {
	const row = [page.name, (page.html.length / 1024).toFixed(1)];
	const [profile, rename] = race([() => profileDocument(page.html), () => renameAndProfile(page.html, map)], RUNS);
	row.push(fmt(profile!), fmt(rename!));
	for (const op of operations) {
		if (!before) {
			row.push(fmt(race([() => op.call(now, page.html)], RUNS)[0]!));
			continue;
		}
		// Same answer from both, or the comparison means nothing.
		if (op.call(before, page.html) !== op.call(now, page.html)) throw new Error(`${page.name}: ${op.label} differs`);
		const [then, after] = race([() => op.call(before, page.html), () => op.call(now, page.html)], RUNS);
		row.push(fmt(then!), fmt(after!), `${(then! / after!).toFixed(1)}×`);
	}
	lines.push(`| ${row.join(" | ")} |`);
}

console.log(`page shapes — Bun ${Bun.version}, median of ${RUNS} calls, µs${before ? `, before = ${AGAINST}` : ""}\n`);
console.log(lines.join("\n"));
rmSync(out, { recursive: true, force: true });
