/**
 * The controller registry and the two ways to fill it.
 *
 *   const Home = new Controller("Home");
 *   Home.Add("Index", (ctx) => { ctx.response.body = "hi" });   // v1, unchanged
 *
 *   @Controller("/users")
 *   class Users { @Get("/:id") show(ctx) { … } }                // v2
 *
 * `Controller` is one callable that answers to both: with `new` it is v1's
 * namespace object, without it is a class decorator. Two names for the same
 * concept would have been worse than one function that checks `new.target`.
 */

import type { Context, Handler } from "./context.ts";
import { bindController, routeMetaOf, type DecoratorMetadata } from "./metadata.ts";
import { CLog, log } from "./logger.ts";

const registry = new Map<string, Handler>();
const missingReported = new Set<string>();

export interface ControllerOptions {
	/** Only answer requests whose Host header matches. */
	domain?: string;
	/** Registry namespace; defaults to the class name. */
	name?: string;
}

export interface ControllerNamespaceApi {
	readonly namespace: string;
	Add(name: string, handler: Handler): ControllerNamespaceApi;
}

class ControllerNamespace implements ControllerNamespaceApi {
	public readonly namespace: string;

	constructor(namespace: string) {
		this.namespace = namespace;
	}

	public Add(name: string, handler: Handler): this {
		const key = `${this.namespace}@${name}`;
		if (registry.has(key)) {
			log.warn(`[<magenta>Controller</magenta>] <yellow>overwriting</yellow> <cyan>${key}</cyan>`);
		}
		registry.set(key, handler);
		CLog(`[<magenta>Controller</magenta>] Register : <cyan>${key}</cyan>`);
		return this;
	}
}

export type ControllerClassDecorator = <T extends abstract new (...args: never[]) => object>(
	target: T,
	context: ClassDecoratorContext,
) => T;

export interface ControllerFactory {
	new (namespace: string): ControllerNamespaceApi;
	(prefix?: string, options?: ControllerOptions): ControllerClassDecorator;
}

function controllerImpl(prefix = "/", options: ControllerOptions = {}): unknown {
	if (new.target) return new ControllerNamespace(prefix);

	return function decorate<T extends abstract new (...args: never[]) => object>(
		target: T,
		context: ClassDecoratorContext,
	): T {
		const meta = routeMetaOf(context.metadata as DecoratorMetadata);
		const name = options.name ?? context.name ?? "Controller";

		// One instance per class, built on the first request that needs it —
		// a controller constructor may open a connection, and importing the
		// file should not.
		let instance: Record<string, unknown> | undefined;
		const resolve = (property: string): Handler => {
			return (ctx: Context) => {
				instance ??= new (target as unknown as new () => Record<string, unknown>)();
				const method = instance[property];
				if (typeof method !== "function") {
					throw new TypeError(`natsu: ${name}.${property} is not a method`);
				}
				return (method as (ctx: Context) => unknown).call(instance, ctx);
			};
		};

		for (const route of meta.routes) {
			registry.set(`${name}@${route.property}`, resolve(route.property));
		}

		bindController({ name, prefix, domain: options.domain, routes: meta.routes, resolve });
		return target;
	};
}

export const Controller = controllerImpl as unknown as ControllerFactory;

/**
 * Look a controller up by `"Namespace@method"`.
 *
 * Resolution stays late — routes are commonly registered before the controller
 * file is imported, and v1 depended on that ordering being irrelevant.
 */
export function GetController(name: string): Handler {
	return (ctx: Context) => {
		const handler = registry.get(name);
		if (!handler) {
			if (!missingReported.has(name)) {
				missingReported.add(name);
				log.error(`[<magenta>Controller</magenta>] missing handler <red>${name}</red>`);
			}
			return undefined;
		}
		return handler(ctx);
	};
}

export function hasController(name: string): boolean {
	return registry.has(name);
}

export function controllerNames(): string[] {
	return [...registry.keys()];
}

/** Drop every registration. Tests need a clean registry per case. */
export function clearControllers(): void {
	registry.clear();
	missingReported.clear();
}

export type { Context };
