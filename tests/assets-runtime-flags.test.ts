import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Assets, type AssetsOptions } from "../src/assets.ts";
import { setConfig } from "../src/config.ts";
import { reset } from "./helpers.ts";

const MOUNT = resolve(import.meta.dir, "../src/client/mount.ts");
const FIRST_LOAD = ["data-natsu-critical", "data-natsu-warm"];
const CHUNKS = ["natsu-chunks", "link[data-natsu-prefetch]"];

let dir: string;

async function scripts(extra: Partial<AssetsOptions>): Promise<string> {
	reset();
	setConfig({ General: { development: false } });
	const out = join(dir, "out");
	const pipeline = new Assets({
		outDir: out,
		minify: true,
		navigate: true,
		scripts: { app: join(dir, "app.js") },
		...extra,
	});
	await pipeline.build();
	const held = (pipeline as unknown as { files: Map<string, { body: unknown }> }).files;
	return [...held]
		.filter(([file, kept]) => file.endsWith(".js") && typeof kept.body === "string")
		.map(([, kept]) => kept.body)
		.join("\n");
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "natsu-flags-"));
	writeFileSync(join(dir, "widget.js"), `export default function widget(el) { el.dataset.ready = "1"; }\n`);
	writeFileSync(join(dir, "app.js"), `import { mount } from ${JSON.stringify(MOUNT)};\nmount("#widget", () => import("./widget.js"));\n`);
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("client runtime carries only the code of the options that are on", () => {
	test("no first-load or chunk-prefetch code without those options", async () => {
		const code = await scripts({});
		expect([...FIRST_LOAD, ...CHUNKS].filter((word) => code.includes(word))).toEqual([]);
	});

	test("first-load code with firstLoad on", async () => {
		const code = await scripts({ firstLoad: { inline: true } });
		expect(FIRST_LOAD.filter((word) => code.includes(word))).toEqual(FIRST_LOAD);
		expect(CHUNKS.filter((word) => code.includes(word))).toEqual([]);
	});

	test("chunk-prefetch code with prefetchChunks on", async () => {
		const code = await scripts({ prefetchChunks: true });
		expect(CHUNKS.filter((word) => code.includes(word))).toEqual(CHUNKS);
		expect(FIRST_LOAD.filter((word) => code.includes(word))).toEqual([]);
	});
});
