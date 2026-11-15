import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/assets/cli.ts";
import type { CliDeps, PrebuildResult } from "../src/assets/contract.ts";

let dir: string;
let outLines: string[];
let errLines: string[];
let calls: Array<{ options: unknown; pin: boolean | undefined }>;
let loaded: string[];

function manifest(files: Record<string, string>): string {
	return JSON.stringify({
		version: 1,
		natsu: "1",
		fingerprint: "f",
		buildId: "b",
		entries: {},
		files: Object.entries(files).map(([file, sha256]) => ({ file, sha256, bytes: 1, type: "text/css" })),
		state: null,
	});
}

function deps(result: Partial<PrebuildResult> | (() => Promise<PrebuildResult>) = {}, extra: Partial<CliDeps> = {}): CliDeps {
	return {
		cwd: dir,
		out: (line) => outLines.push(line),
		err: (line) => errLines.push(line),
		create: (options) => ({
			prebuild: async (run) => {
				calls.push({ options, pin: run?.pin });
				if (typeof result === "function") return result();
				return { manifest: join(dir, "out", "natsu-assets.json"), files: 3, bytes: 1234, ...result };
			},
		}),
		...extra,
	};
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "natsu-cli-"));
	outLines = [];
	errLines = [];
	calls = [];
	loaded = [];
	writeFileSync(join(dir, "assets.config.ts"), `export default { outDir: "out", marker: "default" };\n`);
	mkdirSync(join(dir, "libs"));
	writeFileSync(
		join(dir, "libs", "assets.ts"),
		`export const ASSET_CONFIG = { outDir: "out", marker: "named" };\nexport const lazy = async () => ({ outDir: "out", marker: "lazy" });\nexport const wrong = 5;\n`,
	);
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("runCli", () => {
	test("build loads the default config and reports the result", async () => {
		const code = await runCli(
			["build"],
			deps({
				remote: { fetched: 2, pinned: [] },
				skipped: [{ ref: "/js/{{x}}.js", outcome: "dynamic", tag: "script", templates: ["a.html"], reason: "expression" }],
			}),
		);
		expect(code).toBe(0);
		expect(calls).toEqual([{ options: { outDir: "out", marker: "default" }, pin: undefined }]);
		expect(outLines[0]).toContain("3 files");
		expect(outLines[0]).toContain("1234 bytes");
		expect(outLines.join("\n")).toContain("2 fetched");
		expect(outLines.join("\n")).toContain("skipped /js/{{x}}.js (dynamic: expression)");
		expect(errLines).toEqual([]);
	});

	test("pin passes pin and lists what it pinned", async () => {
		const code = await runCli(
			["pin", "--config", "libs/assets.ts", "--export", "ASSET_CONFIG"],
			deps({ remote: { fetched: 1, pinned: ["https://cdn.example/lib.js"] } }),
		);
		expect(code).toBe(0);
		expect(calls).toEqual([{ options: { outDir: "out", marker: "named" }, pin: true }]);
		expect(outLines).toContain("pinned https://cdn.example/lib.js");
	});

	test("accepts --name=value and an export that is a function", async () => {
		const code = await runCli(["--config=libs/assets.ts", "--export=lazy", "build"], deps());
		expect(code).toBe(0);
		expect(calls[0]!.options).toEqual({ outDir: "out", marker: "lazy" });
	});

	test("usage problems exit 2 and build nothing", async () => {
		for (const argv of [[], ["deploy"], ["build", "extra"], ["build", "--config"], ["build", "--watch"], ["--help"], ["build", "--export="]]) {
			errLines = [];
			expect(await runCli(argv, deps())).toBe(2);
			expect(errLines.join("\n")).toContain("usage:");
		}
		expect(calls).toEqual([]);
	});

	test("a config outside the working directory is never imported", async () => {
		const outside = mkdtempSync(join(tmpdir(), "natsu-cli-outside-"));
		try {
			writeFileSync(join(outside, "evil.ts"), `export default { outDir: "out" };\n`);
			symlinkSync(join(outside, "evil.ts"), join(dir, "linked.ts"));
			const load = async (path: string) => {
				loaded.push(path);
				return { default: {} };
			};
			expect(await runCli(["build", "--config", join(outside, "evil.ts")], deps({}, { load }))).toBe(2);
			expect(await runCli(["build", "--config", "../evil.ts"], deps({}, { load }))).toBe(2);
			expect(await runCli(["build", "--config", "linked.ts"], deps({}, { load }))).toBe(2);
			expect(await runCli(["build", "--config", "absent.ts"], deps({}, { load }))).toBe(2);
			expect(loaded).toEqual([]);
			expect(calls).toEqual([]);
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});

	test("a missing or wrong export and a failed build exit 1 with the message", async () => {
		expect(await runCli(["build", "--config", "libs/assets.ts"], deps())).toBe(1);
		expect(errLines.join("\n")).toContain("no export named default");
		expect(await runCli(["build", "--config", "libs/assets.ts", "--export", "wrong"], deps())).toBe(1);
		expect(calls).toEqual([]);
		errLines = [];
		const code = await runCli(
			["build"],
			deps(async () => {
				throw new Error("remote asset changed: https://cdn.example/lib.js pinned sha384-a got sha384-b");
			}),
		);
		expect(code).toBe(1);
		expect(errLines.join("\n")).toContain("remote asset changed: https://cdn.example/lib.js");
	});

	test("check passes when the manifest is unchanged and fails on any change", async () => {
		mkdirSync(join(dir, "out"));
		const path = join(dir, "out", "natsu-assets.json");
		writeFileSync(path, manifest({ "a.css": "1", "b.js": "2" }));
		expect(await runCli(["check"], deps())).toBe(0);
		expect(calls[0]!.pin).toBeUndefined();

		const rebuild = (files: Record<string, string>) =>
			deps(async () => {
				writeFileSync(path, manifest(files));
				return { manifest: path, files: 2, bytes: 2 };
			});
		errLines = [];
		expect(await runCli(["check"], rebuild({ "a.css": "1", "b.js": "9", "c.js": "3" }))).toBe(1);
		expect(errLines.join("\n")).toContain("changed file b.js");
		expect(errLines.join("\n")).toContain("added file c.js");

		rmSync(path);
		errLines = [];
		expect(await runCli(["check"], rebuild({ "a.css": "1" }))).toBe(1);
		expect(errLines.join("\n")).toContain("no readable manifest before");
	});

	test("the default loader imports the real config module", async () => {
		const code = await runCli(["build", "--config", "libs/assets.ts", "--export", "ASSET_CONFIG"], {
			...deps(),
			load: undefined,
		});
		expect(code).toBe(0);
		expect(calls[0]!.options).toEqual({ outDir: "out", marker: "named" });
	});
});
