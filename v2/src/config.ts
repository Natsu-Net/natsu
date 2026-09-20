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

export interface LoadOptions {
	cwd?: string;
	/** Config file name, relative to cwd. */
	file?: string;
	/** Applied after the file, so code can pin values a file cannot override. */
	overrides?: NatsuConfigInput;
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
