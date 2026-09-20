import { describe, expect, test, afterEach } from "bun:test";
import { unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ConfigError,
	config,
	defaultConfig,
	envOverlay,
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

describe("environment overlay", () => {
	test("a value lands at the path its name spells", () => {
		const config = loadConfig({
			cwd: "/nonexistent",
			env: { NATSU__General__logLevel: "debug", NATSU__Session__CookieName: "SID" },
		});
		expect(config.General.logLevel).toBe("debug");
		expect(config.Session.CookieName).toBe("SID");
	});

	test("values are coerced to the type of the default underneath", () => {
		const config = loadConfig({
			cwd: "/nonexistent",
			env: {
				NATSU__General__port: "9000",
				NATSU__General__proxy: "true",
				NATSU__Static__etag: "0",
				NATSU__General__logIgnore: '["/health"]',
			},
		});
		expect(config.General.port).toBe(9000);
		expect(config.General.proxy).toBe(true);
		expect(config.Static.etag).toBe(false);
		expect(config.General.logIgnore).toEqual(["/health"]);
	});

	test("a single underscore stays part of the name", () => {
		// `Discord.CLIENT_ID` is one key, not two levels.
		const overlay = envOverlay({ NATSU__Discord__CLIENT_ID: "123" }) as { Discord: Record<string, unknown> };
		expect(overlay.Discord).toEqual({ CLIENT_ID: "123" });
	});

	test("a section natsu knows nothing about comes through as typed", () => {
		const overlay = envOverlay({
			NATSU__Surreal__password: "12345",
			NATSU__Surreal__applySchema: "true",
			NATSU__Player__adsUrl: "",
		}) as { Surreal: Record<string, unknown>; Player: Record<string, unknown> };
		// A password that looks like a number is still a password.
		expect(overlay.Surreal.password).toBe("12345");
		// With no default to learn from, a bare word stays a string; the app's
		// own types say what it means.
		expect(overlay.Surreal.applySchema).toBe("true");
		expect(overlay.Player.adsUrl).toBe("");
	});

	test("_FILE reads the value out of a file, without its trailing newline", () => {
		const path = `${tmpdir()}/natsu-secret-${Math.random().toString(36).slice(2)}`;
		writeFileSync(path, "s3cret\n");
		try {
			const overlay = envOverlay({ NATSU__MySQL__password_FILE: path }) as { MySQL: Record<string, unknown> };
			expect(overlay.MySQL.password).toBe("s3cret");
		} finally {
			unlinkSync(path);
		}
	});

	test("_FILE pointing at nothing is an error, not an empty password", () => {
		expect(() => envOverlay({ NATSU__MySQL__password_FILE: "/nope/nothing" })).toThrow(ConfigError);
	});

	test("the environment beats config.json but code overrides beat both", () => {
		const config = loadConfig({
			cwd: "/nonexistent",
			env: { NATSU__General__port: "9000" },
			overrides: { General: { port: 7000 } },
		});
		expect(config.General.port).toBe(7000);
	});

	test("variables without the prefix are ignored", () => {
		expect(envOverlay({ PATH: "/usr/bin", HOME: "/root" })).toEqual({});
	});
});
