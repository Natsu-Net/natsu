import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliCompressSync, gzipSync } from "node:zlib";
import type { PrebuiltExpect, PrebuiltInput, PrebuiltManifest } from "../src/assets/contract.ts";
import { loadPrebuilt, optionsFingerprint, writePrebuilt } from "../src/assets/prebuilt.ts";

const TYPES: Record<string, string> = {
	css: "text/css; charset=utf-8",
	js: "text/javascript; charset=utf-8",
	json: "application/json; charset=utf-8",
	woff2: "font/woff2",
};

function typeOf(file: string): string | undefined {
	return TYPES[file.slice(file.lastIndexOf(".") + 1)];
}

const CSS = ".card{border:1px solid}".repeat(20);
const JS = "export const answer=42;";
const FONT = new Uint8Array([0x77, 0x4f, 0x46, 0x32, 0, 1, 2, 3, 0xff, 0xfe]);

let dir: string;
let out: string;
let expectation: PrebuiltExpect;

function input(): PrebuiltInput {
	return {
		natsu: "9.9.9",
		fingerprint: "print",
		buildId: "build-1",
		entries: { site: "site.aaaaaaaaaa.css", app: "app.bbbbbbbbbb.js" },
		files: [
			{ file: "site.aaaaaaaaaa.css", body: CSS, type: TYPES.css!, br: brotliCompressSync(CSS), gzip: gzipSync(CSS) },
			{ file: "font.cccccccccc.woff2", body: FONT, type: TYPES.woff2! },
			{ file: "app.bbbbbbbbbb.js", body: JS, type: TYPES.js! },
		],
		state: { rename: { card: "a" }, chunks: ["site.aaaaaaaaaa.css"] },
	};
}

function writeFiles(): void {
	mkdirSync(out, { recursive: true });
	for (const file of input().files) {
		writeFileSync(join(out, file.file), file.body);
		if (file.br) writeFileSync(join(out, `${file.file}.br`), file.br);
		if (file.gzip) writeFileSync(join(out, `${file.file}.gz`), file.gzip);
	}
}

function manifestPath(): string {
	return join(out, "natsu-assets.json");
}

function edit(change: (manifest: PrebuiltManifest & Record<string, unknown>) => void): void {
	const manifest = JSON.parse(readFileSync(manifestPath(), "utf8"));
	change(manifest);
	writeFileSync(manifestPath(), JSON.stringify(manifest));
}

async function failure(): Promise<string> {
	const loaded = await loadPrebuilt(out, expectation);
	if (loaded.ok) return "ok";
	expect(typeof loaded.detail).toBe("string");
	return loaded.reason;
}

beforeEach(async () => {
	dir = mkdtempSync(join(tmpdir(), "natsu-prebuilt-"));
	out = join(dir, "out");
	expectation = { natsu: "9.9.9", fingerprint: "print", typeOf };
	writeFiles();
	await writePrebuilt(out, input());
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("writePrebuilt", () => {
	test("writes one sorted manifest and leaves no temporary file", async () => {
		const manifest = await writePrebuilt(out, input());
		expect(manifest.files.map((file) => file.file)).toEqual([
			"app.bbbbbbbbbb.js",
			"font.cccccccccc.woff2",
			"site.aaaaaaaaaa.css",
		]);
		expect(Object.keys(manifest.entries)).toEqual(["app", "site"]);
		expect(manifest.files[0]).toEqual({
			file: "app.bbbbbbbbbb.js",
			type: TYPES.js!,
			bytes: JS.length,
			sha256: new Bun.CryptoHasher("sha256").update(JS).digest("hex"),
		});
		expect(manifest.files[2]!.br).toBe(brotliCompressSync(CSS).byteLength);
		expect(manifest.files[2]!.gzip).toBe(gzipSync(CSS).byteLength);
		expect(JSON.parse(readFileSync(manifestPath(), "utf8"))).toEqual(manifest);
		expect(readdirSync(out).filter((name) => name.endsWith(".tmp"))).toEqual([]);
		const first = readFileSync(manifestPath(), "utf8");
		await writePrebuilt(out, { ...input(), files: [...input().files].reverse() });
		expect(readFileSync(manifestPath(), "utf8")).toBe(first);
	});

	test("refuses names that could leave outDir and honours a manifest path", async () => {
		await expect(
			writePrebuilt(out, { ...input(), files: [{ file: "../x.js", body: "1", type: TYPES.js! }] }),
		).rejects.toThrow(/\.\.\/x\.js/);
		const elsewhere = join(dir, "meta", "m.json");
		await writePrebuilt(out, { ...input(), manifest: elsewhere });
		expect(existsSync(elsewhere)).toBe(true);
		const loaded = await loadPrebuilt(out, { ...expectation, manifest: elsewhere });
		expect(loaded.ok).toBe(true);
	});
});

describe("loadPrebuilt", () => {
	test("brings back every file with its type, text as string and bytes as bytes", async () => {
		const loaded = await loadPrebuilt(out, expectation);
		if (!loaded.ok) throw new Error(loaded.detail);
		expect(loaded.manifest.buildId).toBe("build-1");
		expect(loaded.manifest.state).toEqual({ rename: { card: "a" }, chunks: ["site.aaaaaaaaaa.css"] });
		expect([...loaded.files.keys()]).toEqual(["app.bbbbbbbbbb.js", "font.cccccccccc.woff2", "site.aaaaaaaaaa.css"]);
		const css = loaded.files.get("site.aaaaaaaaaa.css")!;
		expect(css.body).toBe(CSS);
		expect(css.type).toBe(TYPES.css!);
		expect(Buffer.from(css.br!).equals(brotliCompressSync(CSS))).toBe(true);
		expect(Buffer.from(css.gzip!).equals(gzipSync(CSS))).toBe(true);
		const font = loaded.files.get("font.cccccccccc.woff2")!;
		expect(font.body).toBeInstanceOf(Uint8Array);
		expect([...(font.body as Uint8Array)]).toEqual([...FONT]);
		expect(font.br).toBeUndefined();
	});

	test("carries discovery through", async () => {
		const discovery = {
			scripts: { "js-a": "a.ts" },
			classicScripts: {},
			files: {},
			styles: { "css-a": ["a.css"] },
			rewrite: { "/a.js": "js-a" },
			remote: [],
			refs: [{ ref: "/a.js", outcome: "module" as const, tag: "script" as const, templates: ["v.html"], name: "js-a" }],
			skipped: [],
		};
		await writePrebuilt(out, { ...input(), discovery });
		const loaded = await loadPrebuilt(out, expectation);
		if (!loaded.ok) throw new Error(loaded.detail);
		expect(loaded.manifest.discovery).toEqual(discovery);
		edit((manifest) => {
			(manifest.discovery as unknown as Record<string, unknown>).rewrite = { "/a.js": 5 };
		});
		expect(await failure()).toBe("shape");
	});

	test("a missing or unreadable manifest is reported, never thrown", async () => {
		rmSync(manifestPath());
		expect(await failure()).toBe("missing");
		writeFileSync(manifestPath(), "{not json");
		expect(await failure()).toBe("unreadable");
		writeFileSync(manifestPath(), "[]");
		expect(await failure()).toBe("unreadable");
		rmSync(manifestPath());
		mkdirSync(manifestPath());
		expect(await failure()).toBe("unreadable");
		const absent = await loadPrebuilt(join(dir, "nowhere"), expectation);
		expect(absent.ok).toBe(false);
	});

	test("a stale manifest fails on version or fingerprint", async () => {
		expectation = { ...expectation, natsu: "10.0.0" };
		expect(await failure()).toBe("version");
		expectation = { ...expectation, natsu: "9.9.9", fingerprint: "other" };
		expect(await failure()).toBe("fingerprint");
		expectation = { ...expectation, fingerprint: "print" };
		edit((manifest) => {
			(manifest as Record<string, unknown>).version = 2;
		});
		expect(await failure()).toBe("version");
	});

	test("wrong shapes and limits are refused", async () => {
		const cases: Array<[(manifest: PrebuiltManifest & Record<string, unknown>) => void, string]> = [
			[(manifest) => void ((manifest as Record<string, unknown>).files = {}), "shape"],
			[(manifest) => void ((manifest as Record<string, unknown>).entries = { a: 1 }), "shape"],
			[(manifest) => void ((manifest as Record<string, unknown>).buildId = 7), "shape"],
			[(manifest) => void delete (manifest as Record<string, unknown>).state, "shape"],
			[(manifest) => void ((manifest.files[0] as unknown as Record<string, unknown>).bytes = -1), "shape"],
			[(manifest) => void ((manifest.files[0] as unknown as Record<string, unknown>).bytes = "12"), "shape"],
			[(manifest) => void (manifest.files[0]!.sha256 = "abc"), "shape"],
			[(manifest) => void ((manifest.files[0] as unknown as Record<string, unknown>).br = 1.5), "shape"],
			[(manifest) => void manifest.files.push(manifest.files[0]!), "shape"],
			[(manifest) => void (manifest.files[0] = null as never), "shape"],
		];
		for (const [change, reason] of cases) {
			await writePrebuilt(out, input());
			edit(change);
			expect(await failure()).toBe(reason);
		}
		await writePrebuilt(out, input());
		expectation = { ...expectation, maxFiles: 2 };
		expect(await failure()).toBe("limit");
		expectation = { ...expectation, maxFiles: undefined, maxBytes: 100 };
		expect(await failure()).toBe("limit");
	});

	test("no path may leave outDir", async () => {
		writeFileSync(join(dir, "secret.js"), JS);
		for (const name of ["../secret.js", "sub/app.js", "..", ".", "a\\b.js", "", "/etc/passwd"]) {
			await writePrebuilt(out, input());
			edit((manifest) => {
				manifest.files[0]!.file = name;
			});
			expect(await failure()).toBe("path");
		}
		await writePrebuilt(out, input());
		symlinkSync(join(dir, "secret.js"), join(out, "link.dddddddddd.js"));
		edit((manifest) => {
			manifest.files[0]!.file = "link.dddddddddd.js";
		});
		expect(await failure()).toBe("path");
	});

	test("types come from the allow-list, not from the manifest", async () => {
		edit((manifest) => {
			manifest.files[0]!.type = "text/html";
		});
		expect(await failure()).toBe("type");
		await writePrebuilt(out, input());
		writeFileSync(join(out, "page.eeeeeeeeee.html"), "<p>");
		edit((manifest) => {
			manifest.files.push({ file: "page.eeeeeeeeee.html", type: "text/html", bytes: 3, sha256: "0".repeat(64) });
		});
		expect(await failure()).toBe("type");
	});

	test("sizes and hashes are checked against the files on disk", async () => {
		writeFileSync(join(out, "app.bbbbbbbbbb.js"), `${JS} `);
		expect(await failure()).toBe("size");
		writeFileSync(join(out, "app.bbbbbbbbbb.js"), JS.replace("42", "43"));
		expect(await failure()).toBe("hash");
		rmSync(join(out, "app.bbbbbbbbbb.js"));
		expect(await failure()).toBe("size");
	});

	test("compressed copies that do not match are dropped, not failed", async () => {
		const tampered = new Uint8Array(brotliCompressSync(CSS.replaceAll("solid", "dashe")));
		writeFileSync(join(out, "site.aaaaaaaaaa.css.br"), tampered);
		edit((manifest) => {
			manifest.files.find((file) => file.file === "site.aaaaaaaaaa.css")!.br = tampered.byteLength;
		});
		writeFileSync(join(out, "site.aaaaaaaaaa.css.gz"), "short");
		const loaded = await loadPrebuilt(out, expectation);
		if (!loaded.ok) throw new Error(loaded.detail);
		const css = loaded.files.get("site.aaaaaaaaaa.css")!;
		expect(css.body).toBe(CSS);
		expect(css.br).toBeUndefined();
		expect(css.gzip).toBeUndefined();
		rmSync(join(out, "site.aaaaaaaaaa.css.br"));
		const again = await loadPrebuilt(out, expectation);
		expect(again.ok).toBe(true);
	});

	test("a throwing typeOf is a type failure, not a crash", async () => {
		expectation = {
			...expectation,
			typeOf: () => {
				throw new Error("boom");
			},
		};
		expect(await failure()).toBe("type");
	});
});

describe("optionsFingerprint", () => {
	test("is stable across key order and blind to prebuilt and remote.pin", () => {
		const base = optionsFingerprint({ outDir: "o", safelist: [/^is-/, "a"], remote: { maxBytes: 5 }, minify: true });
		expect(base).toMatch(/^[0-9a-f]{64}$/);
		expect(optionsFingerprint({ minify: true, remote: { maxBytes: 5 }, safelist: [/^is-/, "a"], outDir: "o" })).toBe(base);
		expect(
			optionsFingerprint({ outDir: "o", safelist: [/^is-/, "a"], remote: { maxBytes: 5, pin: true }, minify: true, prebuilt: { strict: true } }),
		).toBe(base);
		expect(optionsFingerprint({ outDir: "o", safelist: [/^is-/, "a"], remote: { maxBytes: 5 }, minify: true, later: undefined })).toBe(base);
	});

	test("changes with any option that shapes the build", () => {
		const base = optionsFingerprint({ outDir: "o", safelist: [/^is-/] });
		expect(optionsFingerprint({ outDir: "p", safelist: [/^is-/] })).not.toBe(base);
		expect(optionsFingerprint({ outDir: "o", safelist: [/^is-/i] })).not.toBe(base);
		expect(optionsFingerprint({ outDir: "o", safelist: ["/^is-/"] })).toBe(base);
		expect(optionsFingerprint({ outDir: "o", safelist: [/^is-/], block: ["x"] })).not.toBe(base);
		expect(optionsFingerprint({ outDir: "o", safelist: [/^is-/], hook: () => 1 })).toBe(
			optionsFingerprint({ outDir: "o", safelist: [/^is-/], hook: () => 2 }),
		);
	});

	test("survives cycles and odd values", () => {
		const loop: Record<string, unknown> = { a: 1 };
		loop.self = loop;
		expect(optionsFingerprint(loop)).toMatch(/^[0-9a-f]{64}$/);
		expect(optionsFingerprint(undefined)).toMatch(/^[0-9a-f]{64}$/);
		expect(optionsFingerprint({ set: new Set(["b", "a"]) })).toBe(optionsFingerprint({ set: new Set(["a", "b"]) }));
	});
});
