/**
 * The handshake between `@Controller` (controller.ts) and `@Get`/`@Post`
 * (router.ts).
 *
 * Both halves need one shared symbol, and the router needs to hear about a
 * decorated class the moment it is defined. Putting the symbol and the
 * notification hook in a module that imports neither keeps controller.ts and
 * router.ts pointing one way (router → controller) instead of at each other.
 */

import type { Handler } from "./context.ts";

export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "OPTIONS" | "HEAD";
export type RouteMethod = HttpMethod | "ALL";

export interface DecoratedRoute {
	method: RouteMethod;
	path: string;
	property: string;
}

export interface ControllerMeta {
	routes: DecoratedRoute[];
}

export const ROUTE_META = Symbol.for("natsu.router.routes");

/** TC39 decorator contexts share one metadata object per class. */
export type DecoratorMetadata = Record<PropertyKey, unknown>;

export function routeMetaOf(metadata: DecoratorMetadata): ControllerMeta {
	let meta = metadata[ROUTE_META] as ControllerMeta | undefined;
	if (!meta) {
		meta = { routes: [] };
		metadata[ROUTE_META] = meta;
	}
	return meta;
}

export interface ControllerBinding {
	/** Registry namespace, i.e. the class name. */
	name: string;
	prefix: string;
	domain: string | undefined;
	routes: DecoratedRoute[];
	/** Late-bound so the class is only instantiated when a request arrives. */
	resolve: (property: string) => Handler;
}

type Binder = (binding: ControllerBinding) => void;

let binder: Binder | undefined;
const pending: ControllerBinding[] = [];

/** router.ts installs the real binder at import time. */
export function setRouteBinder(fn: Binder): void {
	binder = fn;
	while (pending.length) {
		const next = pending.shift();
		if (next) fn(next);
	}
}

/**
 * Classes decorated before router.ts loaded are queued, not dropped: module
 * evaluation order is the app's business, not ours.
 */
export function bindController(binding: ControllerBinding): void {
	if (binder) binder(binding);
	else pending.push(binding);
}

export function clearPendingBindings(): void {
	pending.length = 0;
}
