/**
 * `mount(selector, () => import("./module.ts"))`: run a module on the
 * elements that match a selector, loading it the first time one is in the
 * document. An app imports this into its own entry; it is not part of the
 * navigation runtime.
 *
 *   import { mount } from "natsu/src/client/mount.ts";
 *   mount("[data-editor]", () => import("./editor/main.ts"));
 *
 * The module exports `mount(el, signal)`, which may return a cleanup. It runs
 * once per matching element: at load, for each region a visit swaps in, an
 * island filled, a live redraw (through the runtime's `natsu.mount`, when it
 * is on the page) and for any element a script adds later. When the element
 * goes (its region replaced, it is removed) the signal aborts and the cleanup
 * runs. The module is imported once, however many elements it mounts on.
 *
 * With `"families"` chunking the stylesheet families the module can need are
 * linked, each at its place in the sheet's link order, and loaded before its
 * `mount` runs, so what it draws is never shown unstyled, even on a page the
 * server did not expect it on. Assets finds `mount` calls whose selector and
 * specifier are plain string literals at build and hands each core
 * stylesheet link the manifest (`data-natsu-families`): the sheet's chunks in
 * link order, and per selector the families its module can need. A new link
 * carries the core link's nonce, so it applies under a nonce `style-src` too.
 *
 * Because a family links after others in a fixed order (see uwu-template's
 * `partitionCSS`), this also keeps that order: whenever the head changes, if
 * the last copy of a family comes before the last copy of one that links
 * before it, the families from there on are linked again, in order, at the
 * end. A copy of a sheet the browser holds applies as it goes in.
 */

type Cleanup = (() => void) | void | undefined;
type Mounter<E extends Element> = (el: E, signal: AbortSignal) => Cleanup;
interface Runtime {
	mount(selector: string, fn: (el: Element, signal: AbortSignal) => Cleanup): void;
}
interface Manifest {
	c: string[];
	m: Record<string, number[]>;
}

const D = document;
const SHEET = "link[rel=stylesheet]";
const MANIFEST = "link[data-natsu-families]";
const COPY = "data-natsu-copy";
const read = new Map<string, Manifest>();

/** Every family sheet on the page that has a manifest: its core link and the manifest. */
const sheets = (): Array<[HTMLLinkElement, Manifest]> =>
	[...D.querySelectorAll<HTMLLinkElement>(MANIFEST)].map((link) => {
		const text = link.getAttribute("data-natsu-families")!;
		let manifest = read.get(text);
		if (!manifest) read.set(text, (manifest = JSON.parse(text) as Manifest));
		return [link, manifest];
	});

/** A stylesheet link that applies now: not inert while a visit loads it, not disabled. */
const live = (link: HTMLLinkElement) => link.media != "not all" && !link.disabled;

/** The last link that applies for each chunk of a sheet, by its place in link order. */
const lasts = (manifest: Manifest): Map<number, HTMLLinkElement> => {
	const out = new Map<number, HTMLLinkElement>();
	for (const link of D.querySelectorAll<HTMLLinkElement>(SHEET)) {
		const at = manifest.c.indexOf(link.getAttribute("href")!);
		if (at >= 0 && live(link)) out.set(at, link);
	}
	return out;
};

/** Link the chunks of every sheet the selector's module can need that the page does not have, and wait for them (four seconds at most). */
const styled = (selector: string): Promise<unknown> =>
	Promise.all(
		sheets().flatMap(([core, manifest]) =>
			(manifest.m[selector] ?? []).flatMap((n) => {
				const have = lasts(manifest);
				if (have.has(n)) return [];
				let before: HTMLLinkElement | undefined;
				for (let k = n - 1; !before && k >= 0; k--) before = have.get(k);
				const link = D.createElement("link");
				link.rel = "stylesheet";
				link.setAttribute("href", manifest.c[n]!);
				const nonce = core.nonce || core.getAttribute("nonce");
				if (nonce) link.setAttribute("nonce", nonce);
				const done = new Promise((resolve) => {
					link.onload = link.onerror = resolve;
					setTimeout(resolve, 4000);
				});
				(before ?? core).after(link);
				return [done];
			}),
		),
	);

/**
 * Put each sheet's chunks back in link order: from the first chunk whose last
 * copy comes after the last copy of a chunk that links later, link again each
 * chunk that applies, in order, after the last of them, and drop the copies
 * this made before that are no longer the last.
 */
const order = (): void => {
	for (const [, manifest] of sheets()) {
		const have = lasts(manifest);
		const ranks = [...have.keys()].sort((a, b) => a - b);
		const position = (link: Element) => [...D.querySelectorAll(SHEET)].indexOf(link);
		let from = -1;
		for (let i = 0; i < ranks.length && from < 0; i++) {
			for (let j = i + 1; j < ranks.length; j++) {
				if (position(have.get(ranks[i]!)!) > position(have.get(ranks[j]!)!)) {
					from = i;
					break;
				}
			}
		}
		if (from < 0) continue;
		let tail = [...have.values()].reduce((a, b) => (position(a) > position(b) ? a : b)) as Element;
		for (const rank of ranks.slice(from)) {
			const old = have.get(rank)!;
			const copy = old.cloneNode() as HTMLLinkElement;
			copy.setAttribute(COPY, "");
			copy.removeAttribute("data-natsu-families");
			tail.after(copy);
			tail = copy;
			if (old.hasAttribute(COPY)) old.remove();
		}
	}
};

let watching = false;
/** Keep the order whenever a stylesheet link comes, goes, or starts or stops applying. */
const watch = () => {
	if (watching) return;
	watching = true;
	const touches = (nodes: NodeList) => [...nodes].some((node) => node.nodeName == "LINK");
	new MutationObserver((records) => {
		if (records.some((record) => record.type == "attributes" || touches(record.addedNodes) || touches(record.removedNodes))) order();
	}).observe(D.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ["media", "disabled", "href"] });
};

/** Elements mounted, by this module, with what stops them. */
const mounted = new WeakMap<Element, Map<string, () => void>>();

export function mount<E extends Element = Element>(selector: string, load: () => Promise<{ mount: Mounter<E> }>): void {
	let module: Promise<{ mount: Mounter<E> }> | undefined;
	const start = (el: Element, signal: AbortSignal): (() => void) => {
		let stop: Cleanup;
		Promise.all([styled(selector), (module ??= load())])
			.then(([, loaded]) => {
				if (!signal.aborted) stop = loaded.mount(el as E, signal);
			})
			.catch((error) => console.error(`natsu: could not mount ${selector}`, error));
		return () => typeof stop == "function" && stop();
	};
	const own = (el: Element, signal: AbortSignal): Cleanup => {
		const mine = mounted.get(el) ?? new Map<string, () => void>();
		mounted.set(el, mine);
		if (mine.has(selector)) return;
		const stop = start(el, signal);
		mine.set(selector, stop);
		return () => {
			mine.delete(selector);
			stop();
		};
	};
	const scan = (root: Element) => {
		for (const el of [root, ...root.querySelectorAll(selector)]) {
			if (!el.matches(selector) || mounted.get(el)?.has(selector)) continue;
			const controller = new AbortController();
			const stop = own(el, controller.signal);
			if (!stop) continue;
			loose.add([el, () => (controller.abort(), stop())]);
		}
	};
	watch();
	const runtime = (window as { natsu?: Runtime }).natsu;
	const boot = () => {
		if (runtime) runtime.mount(selector, own);
		else scan(D.documentElement);
		new MutationObserver((records) => {
			for (const record of records) {
				for (const node of record.addedNodes) if (node.nodeType == 1) scan(node as Element);
				for (const node of record.removedNodes) if (node.nodeType == 1) sweep();
			}
		}).observe(D.documentElement, { subtree: true, childList: true });
	};
	if (runtime || D.readyState != "loading") boot();
	else D.addEventListener("DOMContentLoaded", boot, { once: true });
}

/** Mounts made outside the runtime: the element, and what ends the mount. */
const loose = new Set<[Element, () => void]>();

/** End the mounts made outside the runtime whose element left the document. */
const sweep = () => {
	for (const entry of loose) {
		if (entry[0].isConnected) continue;
		loose.delete(entry);
		entry[1]();
	}
};
