/**
 * Configuration: typed defaults, a `config.json` overlay, and nothing else.
 *
 * v1 read `config.json` at import time and shipped a half-empty object when the
 * file was missing, so a typo in a key surfaced as `undefined` deep inside a
 * request. Here every key has a default, unknown sections are preserved (apps
 * keep their own), and the merge is explicit per section so a partial file
 * cannot delete a default.
 */

import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { LogLevel } from "./logger.ts";

export interface GeneralConfig {
	/** Public base URL, used for redirects and the boot banner. */
	url: string;
	port: number;
	listenOn: string;
	/** Trust `X-Forwarded-For` when resolving `ctx.ip`. */
	proxy: boolean;
	bantime: number;
	/** `{method} {path} {status} {ms}` — see `formatLine`. */
	logFormat: string;
	logLevel: LogLevel;
	/** Include stack traces in 500 bodies. Never turn this on in production. */
	development: boolean;
	/** Paths the request logger stays quiet about. */
	logIgnore: string[];
}

/**
 * v1 cached static file *bytes* on the heap because `Deno.readFile` was the
 * only way to serve one. `Bun.file()` hands the descriptor to the kernel, so
 * there are no bytes to cache; what is cached now is path resolution, which is
 * what actually costs something per request.
 *
 * `enablePublicCache` and `publicCacheTTL` still govern that cache. The other
 * two keys are accepted so a v1 `config.json` loads unchanged, and have no
 * effect: nothing is read into memory, so there is nothing to auto-update, and
 * a resolution hit is not worth a log line.
 */
export interface CacheConfig {
	enablePublicCache: boolean;
	publicCacheTTL: number;
	/** @deprecated v1 compatibility only — no bytes are cached in v2. */
	autoUpdatePublicCache: boolean;
	/** @deprecated v1 compatibility only. */
	logPublicHit: boolean;
}

export interface StaticConfig {
	enabled: boolean;
	/** Document root, relative to cwd unless absolute. */
	root: string;
	/** `Cache-Control: max-age`, in seconds. */
	maxAge: number;
	etag: boolean;
	lastModified: boolean;
	/** File served for a directory request; empty string disables. */
	index: string;
	/** `.git`, `.env` and friends are refused unless this is on. */
	dotfiles: boolean;
	/** Resolve symlinks and re-check containment before serving. */
	followSymlinks: boolean;
	/** v1 order: public files shadow registered routes. Off by default. */
	beforeRoutes: boolean;
}

export interface SessionCookieConfig {
	path: string;
	sameSite: "strict" | "lax" | "none";
	secure: boolean;
	httpOnly: boolean;
	domain?: string;
}

export interface SessionConfig {
	enabled: boolean;
	/** Cookie name; kept in v1's spelling so existing cookies keep working. */
	CookieName: string;
	driver: "sqlite" | "memory" | "none";
	/** Lifetime in seconds. */
	ttl: number;
	/** Expiry sweep interval in seconds; 0 disables the timer. */
	sweepInterval: number;
	/** sqlite driver only. `:memory:` keeps it in-process. */
	path: string;
	cookie: SessionCookieConfig;
}

export interface MySQLConfig {
	host: string;
	database: string;
	username: string;
	password: string;
	charset: string;
}

export interface NatsuConfig {
	General: GeneralConfig;
	Cache: CacheConfig;
	Static: StaticConfig;
	Session: SessionConfig;
	MySQL: MySQLConfig;
	/** Apps put their own sections here; the loader passes them through. */
	[section: string]: unknown;
}

export type DeepPartial<T> = {
	[K in keyof T]?: T[K] extends object ? (T[K] extends unknown[] ? T[K] : DeepPartial<T[K]>) : T[K];
};

export type NatsuConfigInput = DeepPartial<NatsuConfig>;

export function defaultConfig(): NatsuConfig {
	return {
		General: {
			url: "http://127.0.0.1:8083",
			port: 8083,
			listenOn: "0.0.0.0",
			proxy: false,
			bantime: 300,
			logFormat: "[<yellow>{method}</yellow>] {ip} - <magenta>{path}</magenta> <{color}>{status}</{color}> in <{color}>{ms}ms</{color}>",
			logLevel: "info",
			development: false,
			logIgnore: ["/favicon.ico", "/assets"],
		},
		Cache: {
			enablePublicCache: true,
			publicCacheTTL: 900,
			autoUpdatePublicCache: true,
			logPublicHit: false,
		},
		Static: {
			enabled: true,
			root: "public",
			maxAge: 18000,
			etag: true,
			lastModified: true,
			index: "index.html",
			dotfiles: false,
			followSymlinks: false,
			beforeRoutes: false,
		},
		Session: {
			enabled: true,
			CookieName: "NATSU_SESSION",
			driver: "sqlite",
			ttl: 60 * 60 * 24 * 7,
			sweepInterval: 300,
			path: ".natsu/sessions.sqlite",
			cookie: {
				path: "/",
				sameSite: "lax",
				secure: false,
				httpOnly: true,
			},
		},
		MySQL: { host: "", database: "", username: "", password: "", charset: "" },
	};
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Overlay `patch` onto `base`. Arrays replace rather than concatenate: a config
 * that lists `logIgnore` means *those* paths, not those plus the defaults.
 */
export function mergeConfig<T extends Record<string, unknown>>(base: T, patch: unknown): T {
	if (!isPlainObject(patch)) return base;
	const out = { ...base } as Record<string, unknown>;
	for (const [key, value] of Object.entries(patch)) {
		if (value === undefined) continue;
		const current = out[key];
		out[key] = isPlainObject(current) && isPlainObject(value) ? mergeConfig(current, value) : value;
	}
	return out as T;
}

export class ConfigError extends Error {
	override name = "ConfigError";
}

function validate(config: NatsuConfig): NatsuConfig {
	const { port } = config.General;
	// Port 0 is legitimate (bind an ephemeral port) — tests rely on it.
	if (!Number.isInteger(port) || port < 0 || port > 65535) {
		throw new ConfigError(`General.port must be an integer in 0..65535, got ${String(port)}`);
	}
	if (config.Session.ttl <= 0) {
		throw new ConfigError(`Session.ttl must be positive, got ${String(config.Session.ttl)}`);
	}
	if (!["sqlite", "memory", "none"].includes(config.Session.driver)) {
		throw new ConfigError(`Session.driver must be one of sqlite|memory|none, got ${config.Session.driver}`);
	}
	return config;
}

/** Absolute path of the static document root for a given cwd. */
export function staticRoot(config: NatsuConfig, cwd: string = process.cwd()): string {
	const root = config.Static.root;
	return isAbsolute(root) ? resolve(root) : resolve(cwd, root);
}

// --- environment overlay ---------------------------------------------------

/** Prefix that marks an environment variable as configuration. */
const ENV_PREFIX = "NATSU__";
/** Separator between path segments, so a key may contain a single underscore. */
const ENV_SEPARATOR = "__";
/** Suffix naming a file to read the value from, for Docker and systemd secrets. */
const ENV_FILE_SUFFIX = "_FILE";

/**
 * Turn `NATSU__Section__key=value` environment variables into a config patch.
 *
 * This exists so a deployment can supply secrets without writing them to disk:
 * a container gets `NATSU__Surreal__password` from its orchestrator, or
 * `NATSU__Surreal__password_FILE=/run/secrets/db` pointing at a mounted secret,
 * and `config.json` never has to hold anything sensitive.
 *
 * Section and key names are **case-sensitive and spelled as they are in the
 * config**, because that is what makes the mapping obvious in both directions:
 * `NATSU__General__logLevel` is `General.logLevel`. The separator is a double
 * underscore so that a single one stays part of a name — `Discord.CLIENT_ID`
 * is `NATSU__Discord__CLIENT_ID`, not three levels of nesting.
 *
 * Values are strings. Each is coerced to the type of the default sitting at
 * that path: a number stays a number, `"true"`/`"1"`/`"yes"`/`"on"` become
 * booleans, arrays and objects are parsed as JSON. A path with no default —
 * an application's own section — is parsed as JSON when it looks like JSON and
 * left as a string otherwise, which is what a password wants.
 */
export function envOverlay(
	env: Record<string, string | undefined> = process.env,
	base: NatsuConfig = defaultConfig(),
): NatsuConfigInput {
	const patch: Record<string, unknown> = {};

	for (const [name, raw] of Object.entries(env)) {
		if (raw === undefined || !name.startsWith(ENV_PREFIX)) continue;

		let key = name.slice(ENV_PREFIX.length);
		let value = raw;
		if (key.endsWith(ENV_FILE_SUFFIX)) {
			key = key.slice(0, -ENV_FILE_SUFFIX.length);
			try {
				// Trailing newline: every tool that writes a secret file adds one.
				value = readFileSync(raw, "utf8").replace(/\r?\n$/, "");
			} catch (error) {
				throw new ConfigError(`${name} points at ${raw}, which cannot be read: ${(error as Error).message}`);
			}
		}

		const path = key.split(ENV_SEPARATOR).filter(Boolean);
		if (path.length === 0) continue;

		let cursor = patch;
		let defaults: unknown = base;
		for (const segment of path.slice(0, -1)) {
			const next = cursor[segment];
			cursor = isPlainObject(next) ? (next as Record<string, unknown>) : (cursor[segment] = {});
			defaults = isPlainObject(defaults) ? (defaults as Record<string, unknown>)[segment] : undefined;
		}
		const last = path[path.length - 1];
		if (last === undefined) continue;
		const fallback = isPlainObject(defaults) ? (defaults as Record<string, unknown>)[last] : undefined;
		cursor[last] = coerceEnvValue(value, fallback);
	}

	return patch as NatsuConfigInput;
}

function coerceEnvValue(value: string, fallback: unknown): unknown {
	if (typeof fallback === "number") {
		const n = Number(value);
		if (Number.isNaN(n)) throw new ConfigError(`${JSON.stringify(value)} is not a number`);
		return n;
	}
	if (typeof fallback === "boolean") return /^(1|true|yes|on)$/i.test(value);
	if (Array.isArray(fallback) || isPlainObject(fallback)) return parseJson(value);
	if (typeof fallback === "string") return value;

	// No default to learn from: this is an application's own section. Parse it
	// as JSON only when it unambiguously is, so a password of "null" or "12"
	// stays the string the operator typed.
	const trimmed = value.trim();
	return trimmed.startsWith("{") || trimmed.startsWith("[") ? parseJson(trimmed) : value;
}

function parseJson(value: string): unknown {
	try {
		return JSON.parse(value);
	} catch (error) {
		throw new ConfigError(`${JSON.stringify(value)} is not valid JSON: ${(error as Error).message}`);
	}
}

export interface LoadOptions {
	cwd?: string;
	/** Config file name, relative to cwd. */
	file?: string;
	/** Applied after the file, so code can pin values a file cannot override. */
	overrides?: NatsuConfigInput;
	/** Defaults to `process.env`. Tests pass their own. */
	env?: Record<string, string | undefined>;
}

/**
 * Read `config.json` if present. A missing file is normal (defaults win); a
 * malformed one is not, and throws rather than silently booting a half-config.
 */
export function loadConfig(options: LoadOptions = {}): NatsuConfig {
	const cwd = options.cwd ?? process.cwd();
	const file = resolve(cwd, options.file ?? "config.json");
	let merged = defaultConfig();

	let raw: string | undefined;
	try {
		raw = readFileSync(file, "utf8");
	} catch {
		raw = undefined;
	}

	if (raw !== undefined) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch (error) {
			throw new ConfigError(`${file} is not valid JSON: ${(error as Error).message}`);
		}
		merged = mergeConfig(merged, parsed);
	}

	// After the file, before code overrides: an operator's environment beats a
	// file that was baked into an image, and code still has the last word.
	merged = mergeConfig(merged, envOverlay(options.env ?? process.env, merged));

	if (options.overrides) merged = mergeConfig(merged, options.overrides);
	return validate(merged);
}

/** The process-wide config, also published as `globalThis.Config`. */
export const config: NatsuConfig = loadConfig();

/**
 * Replace the live config in place. Everything that reads config holds this one
 * object reference, so mutation — not reassignment — is what makes a change
 * visible to an already-running server.
 */
export function setConfig(patch: NatsuConfigInput): NatsuConfig {
	const next = validate(mergeConfig(config, patch));
	for (const key of Object.keys(config)) delete config[key];
	Object.assign(config, next);
	return config;
}

/** Restore the shipped defaults. Tests call this between cases. */
export function resetConfig(): NatsuConfig {
	const fresh = defaultConfig();
	for (const key of Object.keys(config)) delete config[key];
	Object.assign(config, fresh);
	return config;
}
