import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { ConfigError, envOverlay, loadConfig, resetConfig, setConfig } from "../src/config.ts";
import { tempDir } from "./helpers.ts";

afterEach(() => {
	resetConfig();
});

describe("configuration that fails closed", () => {
	test("a boolean from the environment is true or false, never a guess", () => {
		const key = "NATSU__General__socketRequireOrigin";
		for (const yes of ["1", "true", "TRUE", "yes", "on"]) expect(envOverlay({ [key]: yes })).toEqual({ General: { socketRequireOrigin: true } });
		for (const no of ["0", "false", "False", "no", "off"]) expect(envOverlay({ [key]: no })).toEqual({ General: { socketRequireOrigin: false } });
		for (const typo of ["ture", "flase", "", "2", "enabled"]) expect(() => envOverlay({ [key]: typo })).toThrow(ConfigError);
	});

	test("the cookie's SameSite is one of the three", () => {
		expect(() => setConfig({ Session: { cookie: { sameSite: "Lax" as never } } })).toThrow(ConfigError);
		expect(() => setConfig({ Session: { cookie: { sameSite: "" as never } } })).toThrow(ConfigError);
		expect(() => setConfig({ Session: { cookie: { sameSite: "none" } } })).not.toThrow();
	});

	test("the allowed socket origins are a list of strings", () => {
		expect(() => setConfig({ General: { socketAllowedOrigins: "https://a.test" as never } })).toThrow(ConfigError);
		expect(() => setConfig({ General: { socketAllowedOrigins: [1] as never } })).toThrow(ConfigError);
	});

	test("the live tag lifetime is a positive integer", () => {
		expect(() => setConfig({ General: { liveTagTtl: 0 } })).toThrow(ConfigError);
		expect(() => setConfig({ General: { liveTagTtl: 1.5 } })).toThrow(ConfigError);
	});

	test("a malformed config file is an error, not defaults", () => {
		const dir = tempDir("natsu-config-");
		try {
			writeFileSync(`${dir.path}/config.json`, "{ not json");
			expect(() => loadConfig({ cwd: dir.path, env: {} })).toThrow(ConfigError);
		} finally {
			dir.cleanup();
		}
	});
});

describe("NATSU_LIVE_SECRET", () => {
	async function load(secret: string): Promise<number> {
		const script = `import("/home/aiko/Documents/GitHub/natsu/src/invalidate.ts").then(() => process.exit(0), () => process.exit(7));`;
		const child = Bun.spawn(["bun", "-e", script], { env: { ...process.env, NATSU_LIVE_SECRET: secret }, stdout: "ignore", stderr: "ignore" });
		return await child.exited;
	}

	test("a short one stops the process instead of signing with a weak key", async () => {
		expect(await load("short")).toBe(7);
		expect(await load("x".repeat(16))).toBe(0);
	});
});
