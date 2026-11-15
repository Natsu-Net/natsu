interface Needs {
	c: string[];
	r?: Record<string, string[][]>;
}

interface Sheet {
	core: HTMLLinkElement;
	needs: Needs;
	index: Map<string, Array<[number, string[]]>>;
}

const D = document;
const CORE = "link[data-natsu-families]";
const SHEET = "link[rel=stylesheet]";
const fetched = new Map<string, Promise<Needs | undefined>>();
const indexes = new WeakMap<Needs, Map<string, Array<[number, string[]]>>>();

const needsAt = (url: string): Promise<Needs | undefined> => {
	let needs = fetched.get(url);
	if (!needs) {
		needs = fetch(url, { priority: "low" } as RequestInit)
			.then((answer) => (answer.ok ? (answer.json() as Promise<Needs>) : undefined))
			.catch(() => undefined);
		fetched.set(url, needs);
	}
	return needs;
};

const indexOf = (needs: Needs): Map<string, Array<[number, string[]]>> => {
	let index = indexes.get(needs);
	if (!index) {
		index = new Map();
		for (const [at, lists] of Object.entries(needs.r ?? {})) {
			for (const list of lists) {
				for (const name of list.length ? list : [""]) {
					let entries = index.get(name);
					if (!entries) index.set(name, (entries = []));
					entries.push([Number(at), list]);
				}
			}
		}
		indexes.set(needs, index);
	}
	return index;
};

const sheets = async (): Promise<Sheet[]> => {
	const out: Sheet[] = [];
	for (const core of D.querySelectorAll<HTMLLinkElement>(CORE)) {
		const needs = await needsAt(core.getAttribute("data-natsu-families")!);
		if (needs?.r) out.push({ core, needs, index: indexOf(needs) });
	}
	return out;
};

const present = (list: string[]) => list.every((name) => D.getElementsByClassName(name).length > 0);

const linked = (needs: Needs): Map<number, HTMLLinkElement> => {
	const out = new Map<number, HTMLLinkElement>();
	for (const link of D.querySelectorAll<HTMLLinkElement>(SHEET)) {
		const at = needs.c.indexOf(link.getAttribute("href")!);
		if (at >= 0 && !link.disabled) out.set(at, link);
	}
	return out;
};

const link = (sheet: Sheet, at: number, have: Map<number, HTMLLinkElement>): void => {
	let before: HTMLLinkElement | undefined;
	for (let k = at - 1; !before && k >= 0; k--) before = have.get(k);
	const tag = D.createElement("link");
	tag.rel = "stylesheet";
	tag.setAttribute("href", sheet.needs.c[at]!);
	const nonce = sheet.core.nonce || sheet.core.getAttribute("nonce");
	if (nonce) tag.setAttribute("nonce", nonce);
	(before ?? sheet.core).after(tag);
	have.set(at, tag);
};

const check = async (names?: Set<string>): Promise<void> => {
	for (const sheet of await sheets()) {
		const have = linked(sheet.needs);
		const candidates = new Map<number, string[][]>();
		const consider = (entries: Array<[number, string[]]> | undefined) => {
			for (const [at, list] of entries ?? []) {
				if (have.has(at)) continue;
				const lists = candidates.get(at) ?? [];
				lists.push(list);
				candidates.set(at, lists);
			}
		};
		if (names) for (const name of names) consider(sheet.index.get(name));
		else for (const entries of sheet.index.values()) consider(entries);
		for (const at of [...candidates.keys()].sort((a, b) => a - b)) {
			if (candidates.get(at)!.some(present)) link(sheet, at, have);
		}
	}
};

let pending: Set<string> | undefined;
const collect = (el: Element, into: Set<string>) => {
	for (const name of el.classList) into.add(name);
	for (const child of el.querySelectorAll("[class]")) for (const name of child.classList) into.add(name);
};

export function watchStyles(): void {
	const start = () => {
		void check();
		new MutationObserver((records) => {
			const names = (pending ??= new Set());
			for (const record of records) {
				if (record.type == "attributes") {
					for (const name of (record.target as Element).classList) names.add(name);
					continue;
				}
				for (const node of record.addedNodes) if (node.nodeType == 1) collect(node as Element, names);
			}
			if (names.size == 0) return;
			queueMicrotask(() => {
				const batch = pending;
				pending = undefined;
				if (batch?.size) void check(batch);
			});
		}).observe(D.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ["class"] });
		D.addEventListener("natsu:load", () => void check());
	};
	if (D.readyState == "loading") D.addEventListener("DOMContentLoaded", start, { once: true });
	else start();
}
