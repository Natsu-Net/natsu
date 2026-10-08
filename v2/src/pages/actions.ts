/**
 * Actions: what a page's forms and buttons do, on the server.
 *
 *   action("todos.add", ({ input }) => {
 *     if (!input.title) throw new Invalid({ title: "Give it a title" });
 *     todos.push({ title: String(input.title) });
 *     return { flash: "Added" };
 *   }, { auth: "viewer", touches: ["todos"] });
 *
 * A page runs one through uwu's markup, which compiles to plain HTML that
 * works without script:
 *
 *   <form @submit="action:todos.add"> … </form>     a POST to the page itself,
 *                                                  `_action` in a hidden field
 *   <button @click="action:todos.done" data-id="{{id}}">Done</button>
 *
 * and, under a short name, through its `<page>` block:
 *
 *   <page><action add="todos.add" auth="viewer"></page>
 *
 * Only an action the page (or one of its layouts or partials) names, by
 * `<action>` or in its markup, runs from that page's URL; one registered
 * `{ public: true }` runs from any page. The rest is in mount.ts: the CSRF
 * check, `auth`, the 303 back with a flash, a refused form drawn again with
 * `form.errors` and `form.values`, and the runtime's swap of the regions.
 */

import type { Context } from "../context.ts";
import type { Session } from "../session/session.ts";

/** What an action is handed. */
export interface ActionInput {
	/** The registered name. */
	name: string;
	/** The name the page used (`<action add="todos.add">`: `add`). */
	short: string;
	/**
	 * The form's fields and the element's `data-*` (by their dataset names:
	 * `data-todo-id` is `todoId`), a field given twice as an array. Files
	 * are in `form`.
	 */
	input: Record<string, string | string[]>;
	form: FormData;
	params: Record<string, string>;
	query: Record<string, string>;
	session: Session | null;
	viewer: unknown;
	ctx: Context;
}

/**
 * What an action may answer (or nothing: back to the page, no message).
 * `errors` (or a thrown `Invalid`) draws the page again with them.
 */
export interface ActionResult {
	/** A message the page shows once, as `flash.message`. */
	flash?: string;
	/** Where to go instead of back to the page: a path on this site. */
	redirect?: string;
	/** Field messages: the form is refused and drawn again (status 422). */
	errors?: Record<string, string>;
	/** A message for the whole form, with `errors`. */
	message?: string;
}

export type ActionHandler = (input: ActionInput) => ActionResult | void | Promise<ActionResult | void>;

/** Who may run it: anyone signed in, a registered guard, or a check of its own. */
export type AuthRule = "viewer" | (string & {}) | ((input: GuardInput) => boolean | Promise<boolean>);

export interface ActionOptions {
	auth?: AuthRule;
	/** Check the CSRF token (default true). Off only for an action that changes nothing a visitor owns. */
	csrf?: boolean;
	/** Runs from any page's URL, listed or not. */
	public?: boolean;
	/**
	 * Live-data tags to invalidate once it succeeds: a source's name (every
	 * page that read it refreshes), a tag, or a function of the input for one.
	 */
	touches?: readonly (string | ((input: ActionInput) => string | readonly string[] | undefined))[];
}

export interface GuardInput {
	viewer: unknown;
	ctx: Context;
	params: Record<string, string>;
}

export type Guard = (input: GuardInput) => boolean | Promise<boolean>;

/** A refused form: field messages, and a message for the whole form. */
export class Invalid extends Error {
	public readonly errors: Record<string, string>;
	/** The message for the whole form ("" for none). */
	public readonly formMessage: string;

	constructor(errors: Record<string, string>, message = "") {
		super(message || "invalid input");
		this.name = "Invalid";
		this.errors = errors;
		this.formMessage = message;
	}
}

export interface RegisteredAction {
	name: string;
	fn: ActionHandler;
	options: ActionOptions;
}

const actions = new Map<string, RegisteredAction>();
const guards = new Map<string, Guard>();

const NAME = /^[A-Za-z_$][\w$-]*(?:\.[A-Za-z_$][\w$-]*)*$/;

/** Register an action under `name`. Before `mountPages`, which checks every name a page uses. */
export function action(name: string, fn: ActionHandler, options: ActionOptions = {}): void {
	if (!NAME.test(name)) throw new TypeError(`natsu/pages: '${name}' is not an action name`);
	actions.set(name, { name, fn, options });
}

/** A named rule for `auth`: `guard("admin", ({ viewer }) => viewer?.role === "admin")`. */
export function guard(name: string, fn: Guard): void {
	if (!/^[A-Za-z_][\w.:-]*$/.test(name) || name === "viewer") throw new TypeError(`natsu/pages: '${name}' cannot name a guard`);
	guards.set(name, fn);
}

export function registeredAction(name: string): RegisteredAction | undefined {
	return actions.get(name);
}

export function hasGuard(name: string): boolean {
	return name === "viewer" || guards.has(name);
}

/** Whether any action is public (then every page route takes a POST). */
export function anyPublicAction(): boolean {
	for (const entry of actions.values()) if (entry.options.public) return true;
	return false;
}

/** Forget every action and guard. Tests call this. */
export function clearActions(): void {
	actions.clear();
	guards.clear();
}

/** Whether `rule` lets this visitor through. */
export async function allowed(rule: AuthRule | undefined, input: GuardInput): Promise<boolean> {
	if (rule === undefined) return true;
	if (typeof rule === "function") return (await rule(input)) === true;
	if (rule === "viewer") return input.viewer !== null && input.viewer !== undefined;
	const check = guards.get(rule);
	if (!check) throw new Error(`natsu/pages: no guard("${rule}", …) is registered`);
	return (await check(input)) === true;
}

// --- input -------------------------------------------------------------------

/** Fields the runtime and the markup add, never input. */
export const ACTION_FIELD = "_action";
export const CSRF_FIELD = "_csrf";

/** The form, as an action's `input`: strings, a repeated field as an array, files left out. */
export function inputOf(form: FormData): Record<string, string | string[]> {
	const out: Record<string, string | string[]> = Object.create(null);
	for (const [key, value] of form) {
		if (key === ACTION_FIELD || key === CSRF_FIELD || typeof value !== "string") continue;
		const held = out[key];
		out[key] = held === undefined ? value : Array.isArray(held) ? [...held, value] : [held, value];
	}
	return out;
}

/** A field that may hold a secret is never drawn back into a refused form. */
const SECRET_FIELD = /pass|secret|token|csrf|code|card|cvc|cvv|otp/i;

/** What a refused form shows again: its text fields, less anything secret, each at most 4000 characters. */
export function valuesOf(input: Record<string, string | string[]>): Record<string, string | string[]> {
	const out: Record<string, string | string[]> = {};
	for (const [key, value] of Object.entries(input)) {
		if (SECRET_FIELD.test(key)) continue;
		out[key] = Array.isArray(value) ? value.map((v) => v.slice(0, 4000)) : value.slice(0, 4000);
	}
	return out;
}

/** What a page reads as `form` when no form was refused. */
export const EMPTY_FORM = Object.freeze({ action: null, errors: Object.freeze({}), values: Object.freeze({}), message: "" });

// --- CSRF and flash ----------------------------------------------------------

/** The double-submit cookie: readable by the runtime, which sends it back with a click. */
export const CSRF_COOKIE = "natsu_csrf";
export const FLASH_COOKIE = "natsu_flash";
const TOKEN = /^[A-Za-z0-9_-]{32,64}$/;

export function newToken(): string {
	return Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("base64url");
}

/** The visitor's CSRF token, if the cookie holds one. */
export function tokenOf(ctx: Context): string | undefined {
	const value = ctx.cookies.get(CSRF_COOKIE);
	return value !== undefined && TOKEN.test(value) ? value : undefined;
}

function same(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

/**
 * The post carries the cookie's token back (a field, or `Natsu-CSRF`) and,
 * when the browser says where it comes from, comes from this site.
 */
export function csrfOk(ctx: Context, form: FormData): boolean {
	const site = ctx.headers.get("sec-fetch-site");
	if (site !== null && site !== "same-origin" && site !== "none") return false;
	const origin = ctx.headers.get("origin");
	if (origin !== null && origin !== "null" && origin !== ctx.url.origin && origin !== publicOrigin()) return false;
	const cookie = tokenOf(ctx);
	const sent = form.get(CSRF_FIELD) ?? ctx.headers.get("natsu-csrf");
	return cookie !== undefined && typeof sent === "string" && same(cookie, sent);
}

let origin: (() => string) | undefined;
/** The public origin behind a proxy that ends TLS (set by mountPages from its baseUrl). */
export function setPublicOrigin(fn: () => string): void {
	origin = fn;
}
function publicOrigin(): string {
	try {
		return origin ? new URL(origin()).origin : "";
	} catch {
		return "";
	}
}

export interface Flash {
	message: string;
	ok: boolean;
}

export function encodeFlash(flash: Flash): string {
	return Buffer.from(JSON.stringify({ m: flash.message.slice(0, 500), ok: flash.ok }), "utf8").toString("base64url");
}

export function decodeFlash(raw: string | undefined): Flash | null {
	if (!raw || raw.length > 2048) return null;
	try {
		const value = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as { m?: unknown; ok?: unknown };
		return typeof value.m === "string" ? { message: value.m.slice(0, 500), ok: value.ok !== false } : null;
	} catch {
		return null;
	}
}

/** A redirect target an action may name: a path on this site, never `//host` or a scheme. */
export function sameSitePath(target: string): string | null {
	if (!target.startsWith("/") || /^\/[/\\]/.test(target) || /[\u0000-\u001f]/.test(target)) return null;
	return target;
}
