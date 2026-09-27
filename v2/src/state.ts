/**
 * Networkable state.
 *
 * A plain class, plain fields, plain assignment — and every browser holding
 * that state sees the change:
 *
 *   @State("room", { scope: "global" })
 *   class Room {
 *     @Networked() online = 0;                     // server writes stream out
 *     @Networked({ writable: true }) topic = "hi"; // a client may write this
 *     @Action() bump(by = 1) { this.online += by } // a client may call this
 *   }
 *
 *   Home.Add("Index", (ctx) => {
 *     const room = ctx.state(Room);
 *     room.online++;                               // every client updates
 *   });
 *
 * The template is ordinary uwu-template — `{{room.online}}` — and a template
 * rendered with plain data is byte-identical to what it was before. Liveness
 * is a property of the data, never of the markup.
 *
 * Both directions are closed by default: a field is read-only to the client
 * and a method is un-callable until the author says otherwise, and both are
 * re-checked on the server when a frame arrives (see `live.ts`). The manifest
 * the browser holds is a hint for the UI, never the authority.
 */

import { type Patch, type Store, isWritable, onPatch, reactive, snapshot } from "uwu-template/reactive/store";

// --- the registry ----------------------------------------------------------

/**
 * Live instances, by class and by scope id.
 *
 * `global` uses one shared id; `session` uses the session's own id; `request`
 * is never stored at all, because a per-request instance has no second reader
 * and nothing to fan out to.
 */
const GLOBAL_SCOPE = "";

const registry = {
	/** Wire key -> class, so a socket frame can name a store. */
	classes: new Map<string, StateClass>(),
	/** class -> scope id -> instance. */
	instances: new WeakMap<StateClass, Map<string, object>>(),
};

/** The class registered under a wire key, if any. */
export function stateClass(key: string): StateClass | undefined {
	return registry.classes.get(key);
}

/** Every registered wire key. */
export function stateKeys(): string[] {
	return [...registry.classes.keys()];
}

/**
 * The instance of `Class` for a scope id.
 *
 * `scopeId` is the session id for a session-scoped class and ignored for a
 * global one. A request-scoped class is constructed fresh every time and never
 * kept, which is what makes it the escape hatch for state that must not be
 * shared or socketed.
 */
export function resolveState<T extends object>(Class: StateClass<T>, scopeId: string): T {
	if (Class.scope === "request") return new Class();

	const id = Class.scope === "global" ? GLOBAL_SCOPE : scopeId;
	if (Class.scope === "session" && id === GLOBAL_SCOPE) {
		throw new Error(`natsu/state: ${Class.stateKey} is session-scoped and needs a session`);
	}

	let byScope = registry.instances.get(Class as unknown as StateClass);
	if (!byScope) {
		byScope = new Map();
		registry.instances.set(Class as unknown as StateClass, byScope);
	}

	let instance = byScope.get(id) as T | undefined;
	if (!instance) {
		instance = new Class();
		byScope.set(id, instance);
	}
	return instance;
}

/**
 * The pub/sub topic an instance's patches go to.
 *
 * A session-scoped store is namespaced by session id, so two people's rooms
 * are two topics. Nothing derives the topic from anything a client sent — the
 * connection decides the scope, which is what stops a client subscribing to
 * somebody else's state.
 */
export function topicFor(Class: StateClass, scopeId: string): string {
	return Class.scope === "global" ? `uwu:${Class.stateKey}` : `uwu:${Class.stateKey}:${scopeId}`;
}

/** Forget every instance. Only tests and a hot reload should need this. */
export function resetState(): void {
	registry.instances = new WeakMap();
}

/** Forget one scope's instances — call when a session ends. */
export function dropScope(scopeId: string): void {
	for (const Class of registry.classes.values()) {
		registry.instances.get(Class)?.delete(scopeId);
	}
}

const META = Symbol.for("natsu.state.meta");

/** The reactive store behind a state instance. Not part of the author's API. */
export const STORE_REF = Symbol.for("natsu.state.store");

/**
 * Where an instance lives, and therefore who shares it.
 *
 * `session` is the default because it is the safe one: a field marked
 * networkable by accident reaches one person's own tabs rather than everybody.
 */
export type Scope = "session" | "global" | "request";

interface FieldMeta {
	writable: boolean;
}

interface ClassMeta {
	fields: Map<string, FieldMeta>;
	actions: Set<string>;
}

type DecoratorMetadata = Record<PropertyKey, unknown>;

/** A class the decorators have processed. */
export interface StateClass<T extends object = object> {
	// deno-lint-ignore no-explicit-any
	new (...args: any[]): T;
	stateKey: string;
	scope: Scope;
	meta: ClassMeta;
}

function metaOf(context: { metadata: DecoratorMetadata }): ClassMeta {
	let meta = context.metadata[META] as ClassMeta | undefined;
	if (!meta) {
		meta = { fields: new Map(), actions: new Set() };
		context.metadata[META] = meta;
	}
	return meta;
}

/**
 * Mark a field networkable. Server writes stream to every client in scope;
 * `writable: true` also lets a client write it back.
 */
export function Networked(options: { writable?: boolean } = {}) {
	return function (_value: undefined, context: ClassFieldDecoratorContext) {
		metaOf(context as unknown as { metadata: DecoratorMetadata }).fields.set(String(context.name), {
			writable: options.writable ?? false,
		});
		return undefined;
	};
}

/** Mark a method callable from the client. It always executes on the server. */
export function Action() {
	return function (value: (...args: never[]) => unknown, context: ClassMethodDecoratorContext) {
		metaOf(context as unknown as { metadata: DecoratorMetadata }).actions.add(String(context.name));
		return value;
	};
}

export interface StateOptions {
	scope?: Scope;
}

/**
 * Turn a class into a state container.
 *
 * Every `@Networked` field is redefined on the instance as an accessor over a
 * uwu-template reactive store, which is why ordinary assignment is what
 * produces a patch — no `.set()`, no proxy the author has to remember.
 *
 * These are TC39 standard decorators, which Bun runs natively: a field
 * decorator threads its metadata to the class decorator through
 * `context.metadata`, so `@Networked() online = 0` needs neither the
 * `accessor` keyword nor `experimentalDecorators`.
 */
export function State(key: string, options: StateOptions = {}) {
	// deno-lint-ignore no-explicit-any -- a mixin base must take `any[]`.
	return function <T extends new (...args: any[]) => object>(Base: T, context: ClassDecoratorContext) {
		const meta = ((context.metadata as DecoratorMetadata)[META] as ClassMeta | undefined) ?? {
			fields: new Map(),
			actions: new Set(),
		};

		const wrapped = class extends Base {
			static stateKey = key;
			static scope: Scope = options.scope ?? "session";
			static meta = meta;

			declare [STORE_REF]: Store & Record<string, unknown>;

			// deno-lint-ignore no-explicit-any
			constructor(...args: any[]) {
				super(...args);

				// Seed the store from whatever the field initialisers just ran.
				const seed: Record<string, unknown> = {};
				const writable: string[] = [];
				for (const [name, field] of meta.fields) {
					seed[name] = (this as Record<string, unknown>)[name];
					if (field.writable) writable.push(name);
				}

				const store = reactive(seed, { key, writable });
				Object.defineProperty(this, STORE_REF, { value: store, enumerable: false });

				for (const name of meta.fields.keys()) {
					Object.defineProperty(this, name, {
						get: () => store[name],
						set: (value: unknown) => {
							store[name] = value;
						},
						enumerable: true,
						configurable: true,
					});
				}
			}
		};

		registry.classes.set(key, wrapped as unknown as StateClass);
		return wrapped;
	};
}

/** The reactive store behind a state instance — what a template renders. */
export function storeOf(instance: object): Store & Record<string, unknown> {
	const store = (instance as Record<symbol, unknown>)[STORE_REF];
	if (!store) throw new Error("natsu/state: not a @State class (no store) — is the class missing its @State decorator?");
	return store as Store & Record<string, unknown>;
}

/** Subscribe to an instance's patches. Returns an unsubscribe function. */
export function watch(instance: object, listener: (patches: Patch[]) => void): () => void {
	return onPatch(storeOf(instance), listener);
}

/** A plain-object copy of an instance's current values, for a `sync` frame. */
export function snapshotOf(instance: object): Record<string, unknown> {
	return snapshot(storeOf(instance)) as Record<string, unknown>;
}

/**
 * Apply a client write, refusing any path the class did not mark writable.
 *
 * Returns whether the write was accepted, so the caller can log a refusal
 * rather than failing silently.
 */
export function applyWrite(instance: object, path: string, value: unknown): boolean {
	const store = storeOf(instance);
	if (!isWritable(store, path)) return false;
	// Only a top-level field can be written from outside. A dotted path would
	// let a client reach into a nested object whose shape the author never
	// declared writable, and `isWritable` answers about the path it is given,
	// not about everything under it.
	if (path.includes(".")) return false;
	store[path] = value;
	return true;
}

/** Invoke a client-requested action, refusing anything not marked `@Action`. */
export function callAction(instance: object, method: string, args: unknown[]): unknown {
	const constructor = instance.constructor as unknown as StateClass;
	if (!constructor.meta?.actions.has(method)) {
		throw new Error(`natsu/state: "${method}" is not an @Action`);
	}
	const fn = (instance as Record<string, unknown>)[method];
	if (typeof fn !== "function") {
		throw new Error(`natsu/state: "${method}" is not a method`);
	}
	return (fn as (...a: unknown[]) => unknown).call(instance, ...args);
}

export type { Patch };
