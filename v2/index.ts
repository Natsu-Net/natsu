/**
 * natsu v2 — public surface.
 *
 * Everything is a real typed export. The `globalThis` spellings v1 apps are
 * written against (`Router`, `Controller`, `Config`, `CLog`) still exist, but
 * behind `installGlobals()`: an import should not quietly rewrite the global
 * object, and a library that natsu is embedded in should not inherit four
 * globals it never asked for.
 */

import { Cache, defaultCache } from "./src/cache.ts";
import { config, envOverlay, loadConfig, resetConfig, setConfig } from "./src/config.ts";
import { Context, NatsuResponse } from "./src/context.ts";
import { Controller, GetController, clearControllers, controllerNames, hasController } from "./src/controller.ts";
import { CLog, colorize, log, setColorEnabled, setLogLevel, setLogSink, stripTags } from "./src/logger.ts";
import { All, Delete, Get, Head, Island, Navigable, Options, Patch, Post, Put, Router } from "./src/router.ts";
import { Application, compose, getApp, loadDirectory, resetApp, restart, start, stop } from "./src/server.ts";
import { Session, SessionManager, sessionMiddleware } from "./src/session/session.ts";
import { MemoryAdapter } from "./src/session/adapter.ts";
import { SqliteAdapter } from "./src/session/sqlite.ts";
import { StaticFiles, parseRange } from "./src/static.ts";
import { Assets } from "./src/assets.ts";
import { addVary, compress, negotiate } from "./src/compress.ts";
import { PageCache } from "./src/page-cache.ts";
import { island, navigable } from "./src/navigate.ts";
import { Action, Networked, State, caller, callAction, dropScope, grantRoom, hasRoom, resolveState, resetState, revokeRoom, revokeSession, snapshotOf, stateClass, stateKeys, storeOf, topicFor, watch, wireKeyFor } from "./src/state.ts";
import { SOCKET_PATH, endSession, liveWebSocketHandler, resetLive, setLiveHooks, setLiveServer, stopPublishing, upgradeLive } from "./src/live.ts";

export { Application, compose, getApp, loadDirectory, resetApp, restart, start, stop };
export { Router, All, Delete, Get, Head, Island, Navigable, Options, Patch, Post, Put };
export { Controller, GetController, clearControllers, controllerNames, hasController };
export { Context, NatsuResponse };
export { Cache, defaultCache };
export { config, loadConfig, setConfig, resetConfig, envOverlay };
export { CLog, colorize, log, setColorEnabled, setLogLevel, setLogSink, stripTags };
export { StaticFiles, parseRange };
export { Assets };
export { addVary, compress, negotiate };
export { PageCache };
export { island, navigable };
export { Session, SessionManager, sessionMiddleware, MemoryAdapter, SqliteAdapter };
export { Action, Networked, State };
export { caller, callAction, dropScope, resolveState, resetState, snapshotOf, stateClass, stateKeys, storeOf, topicFor, watch, wireKeyFor };
export { grantRoom, hasRoom, revokeRoom, revokeSession };
export { SOCKET_PATH, endSession, liveWebSocketHandler, resetLive, setLiveHooks, setLiveServer, stopPublishing, upgradeLive };
export { registerController } from "./src/router.ts";
export { parseCookies, serializeCookie } from "./src/context.ts";
export { Forbidden, HttpError, Invalid, NotFound, PageCompileError, action, compilePages, evaluateServer, guard, mountPages, registerModelResolver, source } from "./src/pages/index.ts";
export type {
	ActionHandler,
	ActionInput,
	ActionOptions,
	ActionResult,
	AuthRule,
	Guard,
	GuardInput,
	ModelResolver,
	PageMeta,
	PageSite,
	PagesOptions,
	Render as TemplateRender,
	ServiceConfig,
	SourceFn,
	SourceInput,
	SourceOptions,
} from "./src/pages/index.ts";
export { invalidate, onInvalidate, setLiveSecret } from "./src/invalidate.ts";
export type { InvalidateListener } from "./src/invalidate.ts";

export type { ApplicationOptions, ErrorHandler, StartOptions } from "./src/server.ts";
export type { CookieOptions, Handler, Middleware, NatsuSocketData, ResponseBody } from "./src/context.ts";
export type { CompiledRoutes, PrefixMiddleware, RouteEntry, RouteMethod, RouteRecord } from "./src/router.ts";
export type { ControllerFactory, ControllerNamespaceApi, ControllerOptions } from "./src/controller.ts";
export type { RejectReason, StaticOptions } from "./src/static.ts";
export type { AssetReport, AssetsOptions } from "./src/assets.ts";
export type { CompressOptions } from "./src/compress.ts";
export type { CachedPage, PageCacheOptions, PageRender } from "./src/page-cache.ts";
export type { Nav, NavigateOptions } from "./src/navigate.ts";
export type { SessionAdapter, SessionRecord, MaybePromise } from "./src/session/adapter.ts";
export type { SessionHook, SessionManagerOptions } from "./src/session/session.ts";
export type {
	CacheConfig,
	DeepPartial,
	GeneralConfig,
	LoadOptions,
	MySQLConfig,
	NatsuConfig,
	NatsuConfigInput,
	SessionConfig,
	SessionCookieConfig,
	StaticConfig,
} from "./src/config.ts";
export type { ControllerBinding, DecoratedRoute, HttpMethod } from "./src/metadata.ts";
export type { Caller, CallerSession, Patch as StatePatch, Scope, StateClass, StateOptions } from "./src/state.ts";
export type { LiveHooks, LiveServer, LiveSocketData } from "./src/live.ts";
export type { LogLevel } from "./src/logger.ts";

declare global {
	// eslint-disable-next-line no-var
	var Router: typeof import("./src/router.ts").Router;
	var Controller: typeof import("./src/controller.ts").Controller;
	var GetController: typeof import("./src/controller.ts").GetController;
	var Config: import("./src/config.ts").NatsuConfig;
	var CLog: typeof import("./src/logger.ts").CLog;
	var web_start: typeof start;
	var web_stop: typeof stop;
	var web_restart: typeof restart;

	// v1 put this on BigInt so a session holding one serialises instead of
	// throwing; installGlobals() defines it.
	interface BigInt {
		toJSON(): string;
	}
}

export interface GlobalsOptions {
	/** Also publish `web_start`/`web_stop`/`web_restart`, as v1's `mod.ts` did. */
	lifecycle?: boolean;
}

/**
 * Publish the v1 globals. Idempotent, and it never clobbers a global an app has
 * already defined itself.
 */
export function installGlobals(options: GlobalsOptions = {}): void {
	const target = globalThis as Record<string, unknown>;
	define(target, "Router", Router);
	define(target, "Controller", Controller);
	define(target, "GetController", GetController);
	define(target, "Config", config);
	define(target, "CLog", CLog);

	if (options.lifecycle !== false) {
		define(target, "web_start", start);
		define(target, "web_stop", stop);
		define(target, "web_restart", restart);
	}

	// v1 put this on BigInt so a session or JSON body holding one would
	// serialise instead of throwing. Apps depend on it; keep it.
	if (typeof BigInt.prototype.toJSON !== "function") {
		Object.defineProperty(BigInt.prototype, "toJSON", {
			value: function toJSON(this: bigint): string {
				return this.toString();
			},
			configurable: true,
			writable: true,
		});
	}
}

function define(target: Record<string, unknown>, name: string, value: unknown): void {
	if (target[name] === value) return;
	if (target[name] !== undefined) {
		log.warn(`[<yellow>globals</yellow>] <cyan>${name}</cyan> already defined — leaving it alone`);
		return;
	}
	Object.defineProperty(target, name, { value, writable: true, configurable: true, enumerable: false });
}

/** Remove the globals again. Only tests should need this. */
export function uninstallGlobals(): void {
	const target = globalThis as Record<string, unknown>;
	for (const name of ["Router", "Controller", "GetController", "Config", "CLog", "web_start", "web_stop", "web_restart"]) {
		delete target[name];
	}
}
