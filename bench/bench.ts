/**
 * natsu v2 benchmark.
 *
 * The question this answers is not "how fast is Bun" — it is "what does natsu
 * cost on top of Bun". So every scenario is run twice: once against an app
 * built with natsu, once against a bare `Bun.serve` doing the same work by
 * hand, on the same machine, in the same process, back to back.
 *
 * Timing is `Bun.nanoseconds()` (monotonic; `Date.now()` can step), each
 * scenario gets a warm-up pass that is thrown away, and the report is
 * percentiles rather than a mean, because a mean hides exactly the tail that
 * makes a server feel slow.
 *
 *   bun run bench/bench.ts [--duration 2] [--connections 32] [--save]
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Application } from "../src/server.ts";
import { Router } from "../src/router.ts";
import { setConfig } from "../src/config.ts";
import { setColorEnabled } from "../src/logger.ts";
import { compile } from "./template.ts";

setColorEnabled(false);

// --- options ---------------------------------------------------------------

function flag(name: string, fallback: number): number {
	const index = Bun.argv.indexOf(`--${name}`);
	if (index === -1) return fallback;
	const value = Number(Bun.argv[index + 1]);
	return Number.isFinite(value) ? value : fallback;
}

function listFlag(name: string, fallback: number[]): number[] {
	const index = Bun.argv.indexOf(`--${name}`);
	if (index === -1) return fallback;
	const parsed = (Bun.argv[index + 1] ?? "")
		.split(",")
		.map(Number)
		.filter((value) => Number.isFinite(value) && value > 0);
	return parsed.length ? parsed : fallback;
}

const DURATION_MS = flag("duration", 2) * 1000;
const WARMUP_MS = flag("warmup", 0.5) * 1000;
/**
 * Two levels, because they answer different questions. At one connection the
 * number is the framework's serial cost per request. At many, the in-process
 * load generator and the server share one event loop, so the gap widens into
 * "what it costs when the loop is the bottleneck" — the pessimistic bound.
 */
const CONNECTION_LEVELS = listFlag("connections", [1, 32]);
const SAVE = Bun.argv.includes("--save");

// --- fixtures --------------------------------------------------------------

const root = join(tmpdir(), "natsu-bench-public");
mkdirSync(root, { recursive: true });
const STATIC_BODY = "x".repeat(8 * 1024); // 8 KB, a plausible small asset
writeFileSync(join(root, "asset.txt"), STATIC_BODY);

const PAGE = `<!doctype html>
<html><head><title>{{title}}</title></head>
<body><h1>{{title}}</h1><p>Hello {{name}}, you are visitor {{count}}.</p>
<ul><li>{{a}}</li><li>{{b}}</li><li>{{c}}</li></ul></body></html>`;
const render = compile(PAGE);

const TEMPLATE_DATA = { title: "natsu", name: "aiko", count: 41, a: "one", b: "two", c: "three" };

const PLAIN = "Hello, world!";

// --- measurement -----------------------------------------------------------

interface Result {
	name: string;
	requests: number;
	seconds: number;
	rps: number;
	mean: number;
	p50: number;
	p95: number;
	p99: number;
	max: number;
	bytes: number;
}

function percentile(sorted: Float64Array, fraction: number): number {
	if (sorted.length === 0) return 0;
	const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
	return sorted[index] as number;
}

/**
 * Drive `connections` requests in flight for `ms`, recording each request's own
 * latency. The load generator shares this process with the server, so the
 * absolute numbers are conservative — but both sides of every comparison pay
 * the same tax, which is what makes the *difference* meaningful.
 */
async function measure(name: string, url: string, ms: number, connections: number): Promise<Result> {
	const latencies: number[] = [];
	let bytes = 0;
	const deadline = Bun.nanoseconds() + ms * 1e6;
	const started = Bun.nanoseconds();

	const worker = async (): Promise<void> => {
		while (Bun.nanoseconds() < deadline) {
			const t0 = Bun.nanoseconds();
			const response = await fetch(url);
			// The body has to be drained or the timing is a lie.
			const body = await response.arrayBuffer();
			const t1 = Bun.nanoseconds();
			if (response.status !== 200) throw new Error(`${url} answered ${response.status}`);
			bytes += body.byteLength;
			latencies.push((t1 - t0) / 1e6);
		}
	};

	await Promise.all(Array.from({ length: connections }, worker));
	const seconds = (Bun.nanoseconds() - started) / 1e9;

	const sorted = Float64Array.from(latencies).sort();
	const mean = latencies.reduce((sum, value) => sum + value, 0) / (latencies.length || 1);

	return {
		name,
		requests: latencies.length,
		seconds,
		rps: latencies.length / seconds,
		mean,
		p50: percentile(sorted, 0.5),
		p95: percentile(sorted, 0.95),
		p99: percentile(sorted, 0.99),
		max: sorted.length ? (sorted[sorted.length - 1] as number) : 0,
		bytes,
	};
}

// --- targets ---------------------------------------------------------------

async function startNatsu(): Promise<{ origin: string; stop: () => Promise<void> }> {
	Router.clear();
	setConfig({
		General: { logFormat: "", logLevel: "silent", development: false },
		// Sessions off: they are benchmarked separately, and leaving them on
		// would measure sqlite rather than the request path.
		Session: { enabled: false, driver: "none" },
		Static: { enabled: true, root, maxAge: 0, index: "" },
	});

	const routes = new Router();
	routes.get("/plain", (ctx) => {
		ctx.response.body = PLAIN;
	});
	routes.get("/render", (ctx) => {
		ctx.response.body = render(TEMPLATE_DATA);
	});

	const app = new Application({ sessions: false });
	const server = await app.start({ port: 0, hostname: "127.0.0.1", quiet: true });
	return { origin: server.url.origin, stop: () => app.close(true) };
}

function startBare(): { origin: string; stop: () => Promise<void> } {
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		routes: {
			"/plain": () => new Response(PLAIN, { headers: { "Content-Type": "text/plain; charset=utf-8" } }),
			"/render": () =>
				new Response(render(TEMPLATE_DATA), { headers: { "Content-Type": "text/html; charset=utf-8" } }),
			"/asset.txt": () => new Response(Bun.file(join(root, "asset.txt"))),
		},
		fetch: () => new Response("Not Found", { status: 404 }),
	});
	return { origin: server.url.origin, stop: () => server.stop(true) };
}

const SCENARIOS: { key: string; label: string; path: string }[] = [
	{ key: "plain", label: "plain text", path: "/plain" },
	{ key: "static", label: "static file (8 KB)", path: "/asset.txt" },
	{ key: "render", label: "rendered template", path: "/render" },
];

// --- report ----------------------------------------------------------------

function pad(value: string, width: number, right = false): string {
	return right ? value.padStart(width) : value.padEnd(width);
}

function row(cells: [string, string, string, string, string, string, string]): string {
	const widths = [26, 10, 8, 8, 8, 8, 8];
	return cells.map((cell, index) => pad(cell, widths[index] as number, index > 0)).join("  ");
}

function format(result: Result): string {
	return row([
		result.name,
		result.rps.toFixed(0),
		result.mean.toFixed(2),
		result.p50.toFixed(2),
		result.p95.toFixed(2),
		result.p99.toFixed(2),
		result.max.toFixed(2),
	]);
}

async function main(): Promise<void> {
	const natsu = await startNatsu();
	const bare = startBare();

	const lines: string[] = [];
	const say = (line: string) => {
		lines.push(line);
		console.log(line);
	};

	say(`natsu v2 benchmark — Bun ${Bun.version}`);
	say(`${DURATION_MS / 1000}s per scenario, ${WARMUP_MS / 1000}s warm-up, in-process load`);

	for (const connections of CONNECTION_LEVELS) {
		say("");
		say(`## ${connections} connection${connections === 1 ? "" : "s"}`);
		say("");
		say(row(["scenario", "req/s", "mean", "p50", "p95", "p99", "max"]));
		say(row(["", "", "ms", "ms", "ms", "ms", "ms"]));
		say("-".repeat(86));

		for (const scenario of SCENARIOS) {
			// Warm up both sides so JIT and the file cache are not in the sample.
			await measure("warmup", natsu.origin + scenario.path, WARMUP_MS, connections);
			await measure("warmup", bare.origin + scenario.path, WARMUP_MS, connections);

			const bareResult = await measure(`bare   ${scenario.label}`, bare.origin + scenario.path, DURATION_MS, connections);
			const natsuResult = await measure(
				`natsu  ${scenario.label}`,
				natsu.origin + scenario.path,
				DURATION_MS,
				connections,
			);

			say(format(bareResult));
			say(format(natsuResult));
			const overhead = (1 - natsuResult.rps / bareResult.rps) * 100;
			const perRequestUs = (natsuResult.mean - bareResult.mean) * 1000;
			say(
				row([
					"  overhead",
					`${overhead.toFixed(1)}%`,
					`${perRequestUs >= 0 ? "+" : ""}${perRequestUs.toFixed(0)}µs`,
					"",
					"",
					"",
					"",
				]),
			);
			say("");
		}
	}

	await natsu.stop();
	await bare.stop();

	if (SAVE) {
		const report = [
			"# natsu v2 benchmark results",
			"",
			"Regenerate with `bun run bench` (add `--save` to rewrite this file).",
			"",
			"```",
			...lines,
			"```",
			"",
			`Recorded ${new Date().toISOString()} on Bun ${Bun.version}, ${process.platform}/${process.arch}.`,
			"",
			"## Reading this",
			"",
			"The load generator runs in the same process as the servers, so absolute",
			"throughput is lower than a dedicated client would report. Both targets pay",
			"that cost equally; the overhead column is the number to watch.",
			"",
			"At one connection the overhead is natsu's serial cost per request. At 32 the",
			"client and both servers contend for one event loop, so the figure is a",
			"pessimistic bound rather than a measurement of the framework alone.",
			"",
			"The baseline is the least Bun code that answers the same request. For the",
			"static scenario that means natsu is additionally doing path containment,",
			"a stat, ETag/Last-Modified generation, conditional-request handling and",
			"range parsing, none of which the baseline does.",
			"",
		].join("\n");
		writeFileSync(new URL("./RESULTS.md", import.meta.url), report);
		console.log("wrote bench/RESULTS.md");
	}
}

await main();
