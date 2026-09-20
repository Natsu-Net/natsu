/**
 * Prototype of natsu's networkable-state decorators.
 *
 * Proves the ergonomics the rework is aiming for: a plain class, plain fields,
 * plain assignment — and every connected client sees the change. Uses TC39
 * standard decorators (the ones Bun runs natively), not the legacy
 * `experimentalDecorators` flavour, so no build step or tsconfig flag is needed.
 *
 *   @State("room")
 *   class Room {
 *     @Networked() online = 0;
 *     @Networked({ writable: true }) topic = "hello";
 *     @Action() bump() { this.online++ }
 *   }
 */

import {
	onPatch,
	type Patch,
	reactive,
	type Store,
} from "uwu-template/reactive/store";

const META = Symbol.for("natsu.state.meta");

export type Scope = "session" | "global" | "request";

interface FieldMeta {
	writable: boolean;
}

interface ClassMeta {
	fields: Map<string, FieldMeta>;
	actions: Set<string>;
}

type DecoratorMetadata = Record<PropertyKey, unknown>;

function metaOf(context: { metadata: DecoratorMetadata }): ClassMeta {
	let meta = context.metadata[META] as ClassMeta | undefined;
	if (!meta) {
		meta = { fields: new Map(), actions: new Set() };
		context.metadata[META] = meta;
	}
	return meta;
}

/** Mark a field as networkable: server writes stream to every client in scope. */
export function Networked(options: { writable?: boolean } = {}) {
	return function (_value: undefined, context: ClassFieldDecoratorContext) {
		metaOf(context as unknown as { metadata: DecoratorMetadata }).fields.set(
			String(context.name),
			{ writable: options.writable ?? false },
		);
		return undefined;
	};
}

/** Mark a method as callable from the client. Always executes on the server. */
export function Action() {
	return function (
		value: (...args: unknown[]) => unknown,
		context: ClassMethodDecoratorContext,
	) {
		metaOf(context as unknown as { metadata: DecoratorMetadata }).actions
			.add(String(context.name));
		return value;
	};
}

export interface StateOptions {
	scope?: Scope;
}

export interface StateClass {
	stateKey: string;
	scope: Scope;
	meta: ClassMeta;
}

/**
 * Turn a class into a networkable state container. Every `@Networked` field is
 * redefined on the instance as an accessor over a reactive store, so ordinary
 * assignment (`this.online++`) is what produces a patch.
 */
export function State(key: string, options: StateOptions = {}) {
	return function <T extends new (...args: never[]) => object>(
		Base: T,
		context: ClassDecoratorContext,
	) {
		const meta = (context.metadata as DecoratorMetadata)[META] as
			| ClassMeta
			| undefined ?? { fields: new Map(), actions: new Set() };

		const wrapped = class extends Base {
			static stateKey = key;
			static scope: Scope = options.scope ?? "session";
			static meta = meta;

			declare [STORE_REF]: Store & Record<string, unknown>;

			constructor(...args: never[]) {
				super(...args);

				// Seed the store from the field initialisers the class body ran.
				const seed: Record<string, unknown> = {};
				const writable: string[] = [];
				for (const [name, field] of meta.fields) {
					seed[name] = (this as Record<string, unknown>)[name];
					if (field.writable) writable.push(name);
				}

				const store = reactive(seed, { key, writable });
				Object.defineProperty(this, STORE_REF, {
					value: store,
					enumerable: false,
				});

				// Redirect the fields at the store so plain assignment patches.
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

		return wrapped;
	};
}

export const STORE_REF = Symbol.for("natsu.state.store");

/** The reactive store behind a state instance — what the template renders. */
export function storeOf(instance: object): Store & Record<string, unknown> {
	const store = (instance as Record<symbol, unknown>)[STORE_REF];
	if (!store) {
		throw new Error(
			"natsu/state: instance is not a @State class (missing store)",
		);
	}
	return store as Store & Record<string, unknown>;
}

/** Subscribe to this instance's patches. */
export function watch(
	instance: object,
	listener: (patches: Patch[]) => void,
): () => void {
	return onPatch(storeOf(instance), listener);
}

/** Invoke a client-requested action, refusing anything not marked @Action. */
export function callAction(
	instance: object,
	method: string,
	args: unknown[],
): unknown {
	const constructor = instance.constructor as unknown as StateClass;
	if (!constructor.meta?.actions.has(method)) {
		throw new Error(`natsu/state: "${method}" is not an @Action`);
	}
	return (instance as Record<string, (...a: unknown[]) => unknown>)[method](
		...args,
	);
}
