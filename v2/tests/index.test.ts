import { afterEach, describe, expect, test } from "bun:test";
import * as natsu from "../index.ts";
import { installGlobals, uninstallGlobals } from "../index.ts";
import { setLogLevel, setLogSink } from "../src/logger.ts";

const globals = globalThis as Record<string, unknown>;

afterEach(() => {
	uninstallGlobals();
	setLogLevel("silent");
	setLogSink(() => {});
});

describe("public surface", () => {
	test("the pieces an app imports are all exported", () => {
		for (const name of ["Application", "Router", "Controller", "Context", "Session", "SessionManager", "StaticFiles", "config", "CLog", "installGlobals"]) {
			expect(natsu).toHaveProperty(name);
		}
	});

	test("importing natsu does not touch globalThis", () => {
		// The import already happened at the top of this file.
		expect(globals.Router).toBeUndefined();
		expect(globals.Config).toBeUndefined();
	});
});

describe("installGlobals", () => {
	test("publishes the v1 globals", () => {
		installGlobals();
		expect(globals.Router).toBe(natsu.Router as unknown);
		expect(globals.Controller).toBe(natsu.Controller as unknown);
		expect(globals.GetController).toBe(natsu.GetController as unknown);
		expect(globals.Config).toBe(natsu.config as unknown);
		expect(globals.CLog).toBe(natsu.CLog as unknown);
	});

	test("publishes the lifecycle globals v1's mod.ts defined, unless asked not to", () => {
		installGlobals();
		expect(typeof globals.web_start).toBe("function");
		uninstallGlobals();
		installGlobals({ lifecycle: false });
		expect(globals.web_start).toBeUndefined();
	});

	test("is idempotent", () => {
		installGlobals();
		installGlobals();
		expect(globals.Router).toBe(natsu.Router as unknown);
	});

	test("refuses to clobber a global an app already owns", () => {
		const lines: string[] = [];
		setLogLevel("warn");
		setLogSink((line) => lines.push(line));

		const sentinel = { mine: true };
		globals.Router = sentinel;
		installGlobals();
		expect(globals.Router).toBe(sentinel);
		expect(lines.join("\n")).toContain("Router");
	});

	test("BigInt survives JSON.stringify afterwards", () => {
		installGlobals();
		expect(JSON.stringify({ n: 10n })).toBe('{"n":"10"}');
	});

	test("uninstallGlobals removes them again", () => {
		installGlobals();
		uninstallGlobals();
		expect(globals.Router).toBeUndefined();
		expect(globals.Config).toBeUndefined();
	});
});
