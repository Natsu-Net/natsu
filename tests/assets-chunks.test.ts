import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { buildChunkGraph, chunkManifest, chunksMeta, staticClosure } from "../src/assets/chunks.ts";
import type { BundleMeta, ChunkGraph } from "../src/assets/contract.ts";

const dirs: string[] = [];
afterAll(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const META: BundleMeta = {
	inputs: {
		"src/a.ts": {
			imports: [
				{ path: "src/shared.ts", kind: "import-statement", original: "./shared.ts" },
				{ path: "src/widgets.ts", kind: "import-statement", original: "./widgets.ts" },
				{ path: "./chunk.x1.js", kind: "dynamic-import", original: "./x.ts", entryPoint: "src/x.ts" },
			],
		},
		"src/b.ts": { imports: [{ path: "src/shared.ts", kind: "import-statement", original: "./shared.ts" }] },
		"src/widgets.ts": { imports: [{ path: "./chunk.y1.js", kind: "dynamic-import", original: "./y.ts", entryPoint: "src/y.ts" }] },
		"src/shared.ts": { imports: [] },
		"src/x.ts": {
			imports: [
				{ path: "src/shared.ts", kind: "import-statement", original: "./shared.ts" },
				{ path: "src/deep.ts", kind: "import-statement", original: "./deep.ts" },
				{ path: "./chunk.z1.js", kind: "dynamic-import", original: "./z.ts", entryPoint: "src/z.ts" },
			],
		},
		"src/y.ts": { imports: [{ path: "src/deep.ts", kind: "import-statement", original: "./deep.ts" }] },
		"src/z.ts": { imports: [] },
		"src/deep.ts": { imports: [] },
	},
	outputs: {
		"./b.b1.js": { entryPoint: "src/b.ts", imports: [{ path: "./chunk.s1.js", kind: "import-statement" }] },
		"./a.a1.js": {
			entryPoint: "src/a.ts",
			imports: [
				{ path: "./chunk.x1.js", kind: "dynamic-import" },
				{ path: "./chunk.y1.js", kind: "dynamic-import" },
				{ path: "./chunk.s1.js", kind: "import-statement" },
			],
		},
		"./chunk.s1.js": { imports: [] },
		"./chunk.d1.js": { imports: [{ path: "./chunk.s1.js", kind: "import-statement" }] },
		"./chunk.x1.js": {
			entryPoint: "src/x.ts",
			imports: [
				{ path: "./chunk.s1.js", kind: "import-statement" },
				{ path: "./chunk.d1.js", kind: "import-statement" },
				{ path: "./chunk.z1.js", kind: "dynamic-import" },
			],
		},
		"./chunk.y1.js": { entryPoint: "src/y.ts", imports: [{ path: "./chunk.d1.js", kind: "import-statement" }] },
		"./chunk.z1.js": { entryPoint: "src/z.ts" },
		"./a.a1.js.map": { imports: [] },
	},
};

const SITES = [
	{ selector: "[data-x]", from: "src/a.ts", module: "src/x.ts" },
	{ selector: "[data-y]", from: "src/widgets.ts", module: "src/y.ts" },
	{ selector: "[data-y]", from: "src/widgets.ts", module: "src/y.ts" },
	{ selector: "[data-z]", from: "src/x.ts", module: "src/z.ts" },
	{ selector: "[data-gone]", from: "src/a.ts", module: "src/missing.ts" },
];

describe("buildChunkGraph", () => {
	const graph = buildChunkGraph({ meta: META, sites: SITES, publicPath: "/_a" });

	test("imports hold only static imports, as public URLs, sorted, with files that import nothing left out", () => {
		expect(graph.imports).toEqual({
			"/_a/a.a1.js": ["/_a/chunk.s1.js"],
			"/_a/b.b1.js": ["/_a/chunk.s1.js"],
			"/_a/chunk.d1.js": ["/_a/chunk.s1.js"],
			"/_a/chunk.x1.js": ["/_a/chunk.d1.js", "/_a/chunk.s1.js"],
			"/_a/chunk.y1.js": ["/_a/chunk.d1.js"],
		});
		expect(Object.keys(graph.imports)).toEqual(Object.keys(graph.imports).slice().sort());
	});

	test("mounts list the sites of an entry and of what it imports statically, once each, and not those behind an import()", () => {
		expect(graph.mounts).toEqual({
			"/_a/a.a1.js": [
				{ selector: "[data-x]", chunk: "/_a/chunk.x1.js" },
				{ selector: "[data-y]", chunk: "/_a/chunk.y1.js" },
			],
			"/_a/chunk.x1.js": [{ selector: "[data-z]", chunk: "/_a/chunk.z1.js" }],
		});
	});

	test("the same input in another key order gives the same graph, byte for byte", () => {
		const reversed: BundleMeta = {
			inputs: Object.fromEntries(Object.entries(META.inputs).reverse()),
			outputs: Object.fromEntries(Object.entries(META.outputs).reverse()),
		};
		const again = buildChunkGraph({ meta: reversed, sites: [...SITES].reverse(), publicPath: "/_a/" });
		expect(JSON.stringify(again)).toBe(JSON.stringify(graph));
	});

	test("an empty build gives an empty graph", () => {
		expect(buildChunkGraph({ meta: { inputs: {}, outputs: {} }, sites: [], publicPath: "/_a" })).toEqual({ imports: {}, mounts: {} });
	});

	test("a real split build: the entry's mount chunk and the chunk both share", async () => {
		const dir = mkdtempSync(join(tmpdir(), "natsu-chunks-"));
		dirs.push(dir);
		mkdirSync(join(dir, "src"));
		const write = (name: string, text: string) => writeFileSync(join(dir, "src", name), text);
		write("shared.ts", `export const shared = "a value both entries and the panel use";\n`);
		write("lib.ts", `export const mount = (selector: string, load: () => Promise<unknown>) => document.querySelector(selector) && load();\n`);
		write("panel.ts", `import { shared } from "./shared.ts";\nexport const mount = () => console.log(shared, "panel");\n`);
		write("one.ts", `import { shared } from "./shared.ts";\nimport { mount } from "./lib.ts";\nmount("[data-panel]", () => import("./panel.ts"));\nconsole.log(shared, "one");\n`);
		write("two.ts", `import { shared } from "./shared.ts";\nconsole.log(shared, "two");\n`);
		const built = await Bun.build({
			entrypoints: [join(dir, "src/one.ts"), join(dir, "src/two.ts")],
			outdir: join(dir, "out"),
			target: "browser",
			format: "esm",
			splitting: true,
			minify: true,
			metafile: true,
			naming: { entry: "[name].[hash].[ext]", chunk: "chunk.[hash].[ext]" },
		} as Parameters<typeof Bun.build>[0]);
		expect(built.success).toBe(true);
		const meta = (built as unknown as { metafile: BundleMeta }).metafile;
		const sourceOf = (name: string) => Object.keys(meta.inputs).find((input) => input.endsWith(name))!;
		const urlOf = (source: string) => "/_a/" + basename(Object.entries(meta.outputs).find(([, info]) => info.entryPoint === source)![0]);
		const real = buildChunkGraph({
			meta,
			sites: [{ selector: "[data-panel]", from: sourceOf("one.ts"), module: sourceOf("panel.ts") }],
			publicPath: "/_a",
		});
		const one = urlOf(sourceOf("one.ts"));
		const two = urlOf(sourceOf("two.ts"));
		const panel = urlOf(sourceOf("panel.ts"));
		expect(real.mounts).toEqual({ [one]: [{ selector: "[data-panel]", chunk: panel }] });
		expect(real.imports[one]).toHaveLength(1);
		expect(real.imports[two]).toEqual(real.imports[one]!);
		expect(real.imports[panel]).toEqual(real.imports[one]!);
		expect(real.imports[one]).not.toContain(panel);
		expect(staticClosure(real, [one, panel])).toEqual(real.imports[one]!);
	});
});

describe("chunkManifest", () => {
	test("the short form: imports under i, mounts under m as [selector, chunk] pairs", () => {
		const graph: ChunkGraph = {
			imports: { "/_a/a.js": ["/_a/s.js"] },
			mounts: { "/_a/a.js": [{ selector: "[data-x]", chunk: "/_a/x.js" }] },
		};
		const manifest = chunkManifest(graph);
		expect(manifest).toEqual({ i: { "/_a/a.js": ["/_a/s.js"] }, m: { "/_a/a.js": [["[data-x]", "/_a/x.js"]] } });
		manifest.i["/_a/a.js"]!.push("/_a/other.js");
		expect(graph.imports["/_a/a.js"]).toEqual(["/_a/s.js"]);
	});
});

describe("staticClosure", () => {
	const graph: ChunkGraph = {
		imports: {
			"/_a/a.js": ["/_a/s.js", "/_a/t.js"],
			"/_a/t.js": ["/_a/u.js"],
			"/_a/u.js": ["/_a/t.js", "/_a/a.js"],
			"/_a/b.js": ["/_a/s.js"],
		},
		mounts: {},
	};

	test("everything the given files import statically, at any depth, without the files themselves, sorted", () => {
		expect(staticClosure(graph, ["/_a/a.js"])).toEqual(["/_a/s.js", "/_a/t.js", "/_a/u.js"]);
		expect(staticClosure(graph, ["/_a/b.js", "/_a/a.js"])).toEqual(["/_a/s.js", "/_a/t.js", "/_a/u.js"]);
	});

	test("a cycle ends, and a file the graph does not know gives nothing", () => {
		expect(staticClosure(graph, ["/_a/u.js"])).toEqual(["/_a/a.js", "/_a/s.js", "/_a/t.js"]);
		expect(staticClosure(graph, ["/_a/none.js"])).toEqual([]);
		expect(staticClosure(graph, [])).toEqual([]);
	});
});

describe("chunksMeta", () => {
	test("one meta tag naming the manifest", () => {
		expect(chunksMeta("/_a/chunks.abc123.json")).toBe('<meta name="natsu-chunks" content="/_a/chunks.abc123.json">');
	});

	test("the URL cannot leave its attribute", () => {
		const tag = chunksMeta('/_a/x"><script>alert(1)</script>&y');
		expect(tag).toBe('<meta name="natsu-chunks" content="/_a/x&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;&amp;y">');
		expect(tag.match(/</g)).toHaveLength(1);
	});

	test("a limit goes in data-max only when it is a whole number from zero up", () => {
		expect(chunksMeta("/_a/c.json", 3)).toBe('<meta name="natsu-chunks" content="/_a/c.json" data-max="3">');
		expect(chunksMeta("/_a/c.json", 0)).toContain('data-max="0"');
		for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) expect(chunksMeta("/_a/c.json", bad)).toBe('<meta name="natsu-chunks" content="/_a/c.json">');
	});
});
