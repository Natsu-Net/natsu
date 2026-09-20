import { describe, expect, test, afterEach } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	ConfigError,
	config,
	defaultConfig,
	loadConfig,
	mergeConfig,
	resetConfig,
	setConfig,
	staticRoot,
} from "../src/config.ts";
import { tempDir } from "./helpers.ts";

afterEach(() => {
	resetConfig();
});

describe("defaults", () => {
	test("every documented section is present", () => {
		const defaults = defaultConfig();
		expect(Object.keys(defaults).sort()).toEqual(["Cache", "General", "MySQL", "Session", "Static"]);
		expect(defaults.General.port).toBe(8083);
		expect(defaults.Session.driver).toBe("sqlite");
	});

	test("defaultConfig() hands back a fresh object each time", () => {
		const a = defaultConfig();
		a.General.port = 1;
		expect(defaultConfig().General.port).toBe(8083);
	});
});

describe("merge", () => {
	test("a partial section keeps its siblings", () => {
		const merged = mergeConfig(defaultConfig(), { General: { port: 9000 } });
		expect(merged.General.port).toBe(9000);
		expect(merged.General.listenOn).toBe("0.0.0.0");
	});

	test("arrays replace rather than concatenate", () => {
		const merged = mergeConfig(defaultConfig(), { General: { logIgnore: ["/x"] } });
		expect(merged.General.logIgnore).toEqual(["/x"]);
	});

	test("undefined does not erase a default", () => {
		const merged = mergeConfig(defaultConfig(), { General: { port: undefined } });
		expect(merged.General.port).toBe(8083);
	});

	test("a non-object patch is ignored", () => {
		expect(mergeConfig(defaultConfig(), null).General.port).toBe(8083);
		expect(mergeConfig(defaultConfig(), "nope").General.port).toBe(8083);
	});
});

describe("loadConfig", () => {
	test("a missing file is not an error", () => {
		const dir = tempDir();
		try {
			expect(loadConfig({ cwd: dir.path }).General.port).toBe(8083);
		} finally {
			dir.cleanup();
		}
	});

	test("reads config.json and keeps unknown sections", () => {
		const dir = tempDir();
		try {
			writeFileSync(join(dir.path, "config.json"), JSON.stringify({ General: { port: 1234 }, Discord: { token: "t" } }));
			const loaded = loadConfig({ cwd: dir.path });
			expect(loaded.General.port).toBe(1234);
			expect(loaded.General.url).toBe("http://127.0.0.1:8083");
			expect(loaded.Discord).toEqual({ token: "t" });
		} finally {
			dir.cleanup();
		}
	});

	test("malformed JSON throws instead of booting a half-config", () => {
		const dir = tempDir();
		try {
			writeFileSync(join(dir.path, "config.json"), "{ nope");
			expect(() => loadConfig({ cwd: dir.path })).toThrow(ConfigError);
		} finally {
			dir.cleanup();
		}
	});

	test("overrides win over the file", () => {
		const dir = tempDir();
		try {
			writeFileSync(join(dir.path, "config.json"), JSON.stringify({ General: { port: 1234 } }));
			expect(loadConfig({ cwd: dir.path, overrides: { General: { port: 4321 } } }).General.port).toBe(4321);
		} finally {
			dir.cleanup();
		}
	});
});

describe("validation", () => {
	test("rejects an out-of-range port", () => {
		expect(() => setConfig({ General: { port: 70000 } })).toThrow(ConfigError);
		expect(() => setConfig({ General: { port: -1 } })).toThrow(ConfigError);
	});

	test("accepts port 0, which means 'pick one'", () => {
		expect(setConfig({ General: { port: 0 } }).General.port).toBe(0);
	});

	test("rejects a non-positive session ttl and an unknown driver", () => {
		expect(() => setConfig({ Session: { ttl: 0 } })).toThrow(ConfigError);
		expect(() => setConfig({ Session: { driver: "postgres" as "sqlite" } })).toThrow(ConfigError);
	});

	test("a rejected change leaves the live config untouched", () => {
		const before = config.General.port;
		expect(() => setConfig({ General: { port: 999999 } })).toThrow(ConfigError);
		expect(config.General.port).toBe(before);
	});
});

describe("live config", () => {
	test("setConfig mutates the same object everything else holds", () => {
		const reference = config;
		setConfig({ General: { port: 4567 } });
		expect(reference.General.port).toBe(4567);
		expect(config).toBe(reference);
	});

	test("resetConfig restores the defaults in place", () => {
		setConfig({ General: { port: 4567 } });
		const reference = config;
		resetConfig();
		expect(reference.General.port).toBe(8083);
	});
});

describe("staticRoot", () => {
	test("resolves a relative root against the given cwd", () => {
		expect(staticRoot(defaultConfig(), "/srv/app")).toBe("/srv/app/public");
	});

	test("leaves an absolute root alone", () => {
		const cfg = defaultConfig();
		cfg.Static.root = "/var/www";
		expect(staticRoot(cfg, "/srv/app")).toBe("/var/www");
	});
});
