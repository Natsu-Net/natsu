/// <reference lib="dom" />
/**
 * The page-switching runtime's types, apart from it: a type-only export in
 * the runtime's own entry would make the bundler wrap its IIFE in a module
 * shim. Importing this file declares the `natsu` global and the three
 * `natsu:` events on document.
 */

/** How `natsu.visit` goes. */
export interface NatsuVisitOptions {
	/** "push" (default), "replace" this entry, or "none" (back/forward). */
	history?: "push" | "replace" | "none";
	/** "top", "keep" (no scroll, no focus move), or a y to scroll to. By default: the hash target, else the top. */
	scroll?: "top" | "keep" | number;
}

/** `detail` of `natsu:visit` (cancelable: the visit does not happen) and of `natsu:before-swap`. */
export interface NatsuVisitDetail {
	url: string;
}

/** `detail` of `natsu:load`: once at boot and once per page swapped in. */
export interface NatsuLoadDetail {
	url: string;
	/** The regions now on screen (at boot, all of them). */
	regions: Element[];
}

/** `window.natsu`, or `natsu` from any script. */
export interface NatsuClient {
	/**
	 * Run `fn` on every element matching `selector`, now and on each one a
	 * swap brings in. The signal aborts, and the returned function runs, when
	 * the element is swapped out.
	 */
	mount<E extends Element = HTMLElement>(selector: string, fn: (el: E, signal: AbortSignal) => void | (() => void)): void;
	visit(url: string | URL, options?: NatsuVisitOptions): Promise<void>;
	refresh(): Promise<void>;
	prefetch(url: string | URL): void;
	island(el: Element): Promise<void>;
}

declare global {
	var natsu: NatsuClient;
	interface DocumentEventMap {
		"natsu:visit": CustomEvent<NatsuVisitDetail>;
		"natsu:before-swap": CustomEvent<NatsuVisitDetail>;
		"natsu:load": CustomEvent<NatsuLoadDetail>;
	}
}
