interface ChunkList {
	i: Record<string, string[]>;
	m: Record<string, Array<[string, string]>>;
}

interface Watch {
	page: string;
	left: number;
	waiting: boolean;
}

const META = 'meta[name="natsu-chunks"]';
const MARK = "data-natsu-prefetch";
const DEFAULT_MAX = 6;
const HARD_MAX = 32;

const lists = new Map<string, Promise<ChunkList | undefined>>();
const watched = new WeakMap<Document, Watch>();

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value == "object" && value !== null && !Array.isArray(value);

const listAt = (view: Window, url: string): Promise<ChunkList | undefined> => {
	let list = lists.get(url);
	if (!list) {
		list = view
			.fetch(url)
			.then((answer) => (answer.ok ? answer.json() : undefined))
			.then((value: unknown) => (isRecord(value) && isRecord(value.i) && isRecord(value.m) ? (value as unknown as ChunkList) : undefined))
			.catch(() => undefined);
		lists.set(url, list);
	}
	return list;
};

const slow = (view: Window): boolean => {
	const connection = (view.navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
	return !!connection && (connection.saveData === true || /(^|-)2g$/.test(connection.effectiveType ?? ""));
};

const limitOf = (value: unknown): number | undefined => {
	const n = typeof value == "string" && value.trim() != "" ? Number(value) : value;
	return typeof n == "number" && Number.isInteger(n) && n >= 0 ? Math.min(n, HARD_MAX) : undefined;
};

export function idlePrefetch(options: { max?: number; root?: Document } = {}): void {
	const root = options.root ?? document;
	const view = root.defaultView;
	const meta = root.querySelector(META);
	if (!view || !meta || watched.has(root)) return;
	let manifest: URL;
	try {
		manifest = new URL(meta.getAttribute("content") ?? "", view.location.href);
	} catch {
		return;
	}
	if (!meta.getAttribute("content") || manifest.origin != view.location.origin) return;
	const max = limitOf(options.max) ?? limitOf(meta.getAttribute("data-max")) ?? DEFAULT_MAX;
	const directory = manifest.origin + manifest.pathname.slice(0, manifest.pathname.lastIndexOf("/") + 1);
	const pageOf = () => view.location.origin + view.location.pathname + view.location.search;
	const watch: Watch = { page: pageOf(), left: max, waiting: false };
	watched.set(root, watch);

	const within = (ref: unknown): string | undefined => {
		if (typeof ref != "string") return undefined;
		try {
			const url = new URL(ref, manifest);
			return url.href.startsWith(directory) && url.href != directory ? url.href : undefined;
		} catch {
			return undefined;
		}
	};

	const held = (): Set<string> => {
		const out = new Set<string>();
		const note = (ref: string | null | undefined) => {
			if (!ref) return;
			try {
				out.add(new URL(ref, view.location.href).href);
			} catch {}
		};
		for (const script of root.querySelectorAll("script[src]")) note(script.getAttribute("src"));
		for (const link of root.querySelectorAll("link[href]")) {
			if (/(^|\s)(modulepreload|prefetch|preload)(\s|$)/i.test(link.getAttribute("rel") ?? "")) note(link.getAttribute("href"));
		}
		try {
			for (const entry of view.performance.getEntriesByType("resource")) note(entry.name);
		} catch {}
		return out;
	};

	const matches = (selector: unknown): boolean => {
		try {
			return typeof selector == "string" && !!root.querySelector(selector);
		} catch {
			return false;
		}
	};

	const hint = (list: ChunkList): void => {
		const imports = new Map<string, string[]>();
		for (const [from, to] of Object.entries(list.i)) {
			const url = within(from);
			if (url && Array.isArray(to)) imports.set(url, to.flatMap((ref) => within(ref) ?? []));
		}
		const have = held();
		const here: string[] = [];
		const next: string[] = [];
		const entries: string[] = [];
		for (const [entry, sites] of Object.entries(list.m)) {
			const url = within(entry);
			if (!url || !have.has(url) || !Array.isArray(sites)) continue;
			entries.push(url);
			for (const site of sites) {
				const chunk = Array.isArray(site) ? within(site[1]) : undefined;
				if (chunk) (matches((site as unknown[])[0]) ? here : next).push(chunk);
			}
		}
		for (const url of imports.keys()) if (have.has(url) && !entries.includes(url)) entries.push(url);
		const wanted: string[] = [];
		const seen = new Set<string>();
		const take = (url: string, self: boolean) => {
			const queue = [url];
			for (let at = 0; at < queue.length; at++) {
				const chunk = queue[at]!;
				if (at > 0 || self) {
					if (seen.has(chunk)) continue;
					seen.add(chunk);
					wanted.push(chunk);
				}
				queue.push(...(imports.get(chunk) ?? []));
				if (queue.length > 4096) break;
			}
		};
		for (const chunk of here) take(chunk, true);
		for (const chunk of next) take(chunk, true);
		for (const entry of entries) take(entry, false);
		for (const url of wanted) {
			if (watch.left <= 0) break;
			if (have.has(url)) continue;
			const link = root.createElement("link");
			link.setAttribute("rel", "prefetch");
			link.setAttribute("as", "script");
			link.setAttribute("href", url.slice(manifest.origin.length));
			link.setAttribute(MARK, "");
			root.head.append(link);
			have.add(url);
			watch.left--;
		}
	};

	const run = (): void => {
		watch.waiting = false;
		if (watch.left <= 0 || slow(view) || !root.head) return;
		void listAt(view, manifest.href).then((list) => {
			if (list && !slow(view)) hint(list);
		});
	};

	const idle = (): void => {
		const request = (view as Window & { requestIdleCallback?: (fn: () => void) => number }).requestIdleCallback;
		if (typeof request == "function") request.call(view, run);
		else view.setTimeout(run, 2000);
	};

	const schedule = (): void => {
		if (watch.waiting) return;
		watch.waiting = true;
		if (root.readyState == "complete") idle();
		else view.addEventListener("load", idle, { once: true });
	};

	root.addEventListener("natsu:load", () => {
		const page = pageOf();
		if (page != watch.page) {
			watch.page = page;
			watch.left = max;
		}
		schedule();
	});
	schedule();
}
