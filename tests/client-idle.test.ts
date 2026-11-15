import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";

let CODE = "";
beforeAll(async () => {
	const out = await Bun.build({ entrypoints: [new URL("../src/client/idle.ts", import.meta.url).pathname], format: "esm" });
	if (!out.success) throw new AggregateError(out.logs, "idle.ts did not build");
	CODE = (await out.outputs[0]!.text()).replace(/export\s*\{[^}]*\};?\s*$/, "window.__idle = idlePrefetch;");
});

type W = any;
const windows: W[] = [];
afterEach(async () => {
	for (const w of windows.splice(0)) await w.happyDOM.close();
});

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const ORIGIN = "https://shop.test";
const LIST = "/_a/chunks.h1.json";
const META = `<meta name="natsu-chunks" content="${LIST}">`;
const ENTRY = `<script type="module" src="/_a/app.e1.js"></script>`;

const MANIFEST = {
	i: {
		"/_a/app.e1.js": ["/_a/chunk.shared.js"],
		"/_a/chunk.editor.js": ["/_a/chunk.shared.js", "/_a/chunk.rich.js"],
		"/_a/chunk.rich.js": ["/_a/chunk.deep.js"],
		"/_a/chunk.chart.js": ["/_a/chunk.plot.js"],
		"/_a/other.e2.js": ["/_a/chunk.never.js"],
	},
	m: {
		"/_a/app.e1.js": [
			["[data-chart]", "/_a/chunk.chart.js"],
			["[data-editor]", "/_a/chunk.editor.js"],
			["[data-map]", "/_a/chunk.map.js"],
		],
		"/_a/other.e2.js": [["[data-other]", "/_a/chunk.other.js"]],
	},
};

interface Init {
	head?: string;
	body?: string;
	manifest?: unknown;
	status?: number;
	connection?: { saveData?: boolean; effectiveType?: string };
	resources?: string[];
	state?: "loading" | "complete";
	idle?: boolean;
}

interface Opened {
	window: W;
	fetched: string[];
	delays: number[];
	idles: Array<() => void>;
	hints(): string[];
	links(): W[];
	flush(): Promise<void>;
}

function open(init: Init = {}): Opened {
	const window: W = new Window({ url: `${ORIGIN}/a`, settings: { disableCSSFileLoading: true, disableJavaScriptFileLoading: true, handleDisabledFileLoadingAsSuccess: true } } as never);
	windows.push(window);
	for (const name of ["Map", "Set", "WeakMap", "Promise", "JSON", "Array", "Object", "Number", "String", "RegExp", "Error", "Math", "URL"]) if (window[name] === undefined) window[name] = (globalThis as W)[name];
	const fetched: string[] = [];
	const delays: number[] = [];
	const idles: Array<() => void> = [];
	window.fetch = async (url: string) => {
		fetched.push(String(url));
		const body = init.manifest === undefined ? MANIFEST : init.manifest;
		return new Response(typeof body == "string" ? body : JSON.stringify(body), { status: init.status ?? 200, headers: { "content-type": "application/json" } });
	};
	if (init.idle === false) {
		window.requestIdleCallback = undefined;
		window.setTimeout = (fn: () => void, ms: number) => (delays.push(ms), idles.push(fn), 0);
	} else window.requestIdleCallback = (fn: () => void) => (idles.push(fn), 0);
	if (init.connection) Object.defineProperty(window.navigator, "connection", { configurable: true, value: init.connection });
	Object.defineProperty(window.performance, "getEntriesByType", { configurable: true, value: () => (init.resources ?? []).map((name) => ({ name: ORIGIN + name })) });
	window.document.write(`<!doctype html><html><head>${init.head ?? META + ENTRY}</head><body>${init.body ?? ""}</body></html>`);
	Object.defineProperty(window.document, "readyState", { configurable: true, writable: true, value: init.state ?? "complete" });
	new Function("window", "document", `with (window) {${CODE}}`)(window, window.document);
	const links = () => [...window.document.querySelectorAll("link[data-natsu-prefetch]")];
	return {
		window,
		fetched,
		delays,
		idles,
		links,
		hints: () => links().map((link: W) => link.getAttribute("href")),
		flush: async () => {
			for (const fn of idles.splice(0)) fn();
			await tick(5);
		},
	};
}

describe("idlePrefetch", () => {
	test("without the meta tag nothing is asked for and nothing is added", async () => {
		const p = open({ head: ENTRY });
		p.window.__idle();
		await p.flush();
		expect(p.idles).toHaveLength(0);
		expect(p.fetched).toEqual([]);
		expect(p.hints()).toEqual([]);
	});

	test("mount chunks whose selector is on the page come first, each with what it imports, then the rest, six at most", async () => {
		const p = open({ body: "<div data-editor></div>" });
		p.window.__idle();
		expect(p.fetched).toEqual([]);
		await p.flush();
		expect(p.fetched).toEqual([ORIGIN + LIST]);
		expect(p.hints()).toEqual(["/_a/chunk.editor.js", "/_a/chunk.shared.js", "/_a/chunk.rich.js", "/_a/chunk.deep.js", "/_a/chunk.chart.js", "/_a/chunk.plot.js"]);
		for (const link of p.links()) {
			expect(link.getAttribute("rel")).toBe("prefetch");
			expect(link.getAttribute("as")).toBe("script");
			expect(link.hasAttribute("crossorigin")).toBe(false);
			expect(link.hasAttribute("nonce")).toBe(false);
			expect(link.parentNode).toBe(p.window.document.head);
		}
	});

	test("only the entries the document holds count, and their own static imports come last", async () => {
		const p = open({ head: META + `<script type="module" src="/_a/other.e2.js"></script>` });
		p.window.__idle();
		await p.flush();
		expect(p.hints()).toEqual(["/_a/chunk.other.js", "/_a/chunk.never.js"]);
	});

	test("a chunk the document already holds, was hinted or has fetched is left alone", async () => {
		const p = open({
			head: META + ENTRY + `<link rel="modulepreload" href="/_a/chunk.rich.js"><link rel="prefetch" href="${ORIGIN}/_a/chunk.plot.js"><script src="/_a/chunk.map.js"></script>`,
			resources: ["/_a/chunk.shared.js", "/_a/chunk.editor.js"],
		});
		p.window.__idle();
		await p.flush();
		expect(p.hints()).toEqual(["/_a/chunk.chart.js", "/_a/chunk.deep.js"]);
	});

	test("the limit comes from the call, else from the meta tag, and is capped", async () => {
		const called = open({ head: `<meta name="natsu-chunks" content="${LIST}" data-max="4">` + ENTRY });
		called.window.__idle({ max: 2 });
		await called.flush();
		expect(called.hints()).toEqual(["/_a/chunk.chart.js", "/_a/chunk.plot.js"]);

		const tagged = open({ head: `<meta name="natsu-chunks" content="${LIST}" data-max="4">` + ENTRY });
		tagged.window.__idle();
		await tagged.flush();
		expect(tagged.hints()).toHaveLength(4);

		const none = open({ head: `<meta name="natsu-chunks" content="${LIST}" data-max="0">` + ENTRY });
		none.window.__idle();
		await none.flush();
		expect(none.fetched).toEqual([]);
		expect(none.hints()).toEqual([]);

		const many: Record<string, string[]> = { "/_a/app.e1.js": Array.from({ length: 80 }, (_, n) => `/_a/chunk.n${n}.js`) };
		const capped = open({ manifest: { i: many, m: {} } });
		capped.window.__idle({ max: 1000 });
		await capped.flush();
		expect(capped.hints()).toHaveLength(32);
	});

	for (const connection of [{ saveData: true }, { effectiveType: "2g" }, { effectiveType: "slow-2g" }]) {
		test(`nothing with ${JSON.stringify(connection)}`, async () => {
			const p = open({ connection });
			p.window.__idle();
			await p.flush();
			expect(p.fetched).toEqual([]);
			expect(p.hints()).toEqual([]);
		});
	}

	test("a 3g or 4g connection without Save-Data is hinted", async () => {
		for (const effectiveType of ["3g", "4g"]) {
			const p = open({ connection: { saveData: false, effectiveType } });
			p.window.__idle();
			await p.flush();
			expect(p.hints()).toHaveLength(6);
		}
	});

	test("a manifest on another origin is never fetched", async () => {
		for (const content of ["https://cdn.test/_a/chunks.json", "//cdn.test/_a/chunks.json", "", "http://shop.test/_a/chunks.json"]) {
			const p = open({ head: `<meta name="natsu-chunks" content="${content}">` + ENTRY });
			p.window.__idle();
			await p.flush();
			expect(p.fetched).toEqual([]);
			expect(p.hints()).toEqual([]);
		}
	});

	test("a URL outside the manifest's own directory is dropped", async () => {
		const p = open({
			manifest: {
				i: { "/_a/app.e1.js": ["https://evil.test/_a/x.js", "//evil.test/_a/y.js", "/_a/../secret.js", "/other/z.js", "/_a/", "javascript:alert(1)", 7, "/_a/ok.js", "/_a/sub/fine.js"] },
				m: { "/_a/app.e1.js": [["[data-a]", "https://evil.test/_a/m.js"], ["[data-b]", "/api/logout"], "junk", ["((", "/_a/odd-selector.js"]] },
			},
		});
		p.window.__idle();
		await p.flush();
		expect(p.hints()).toEqual(["/_a/odd-selector.js", "/_a/ok.js", "/_a/sub/fine.js"]);
	});

	test("an unreadable manifest adds nothing and throws nothing", async () => {
		for (const init of [{ status: 404 }, { manifest: "not json" }, { manifest: [] }, { manifest: { i: [], m: {} } }, { manifest: { i: {}, m: null } }, { manifest: { i: { "/_a/app.e1.js": "x" }, m: { "/_a/app.e1.js": "y" } } }]) {
			const p = open(init);
			p.window.__idle();
			await p.flush();
			expect(p.hints()).toEqual([]);
		}
	});

	test("it waits for load, then for the browser to be idle", async () => {
		const p = open({ state: "loading" });
		p.window.__idle();
		expect(p.idles).toHaveLength(0);
		expect(p.fetched).toEqual([]);
		p.window.document.readyState = "complete";
		p.window.dispatchEvent(new p.window.Event("load"));
		p.window.dispatchEvent(new p.window.Event("load"));
		expect(p.idles).toHaveLength(1);
		expect(p.fetched).toEqual([]);
		await p.flush();
		expect(p.hints()).toHaveLength(6);
	});

	test("without requestIdleCallback it waits two seconds", async () => {
		const p = open({ idle: false });
		p.window.__idle();
		expect(p.delays).toEqual([2000]);
		expect(p.fetched).toEqual([]);
		for (const fn of p.idles.splice(0)) fn();
		await tick(5);
		expect(p.hints()).toHaveLength(6);
	});

	test("called again, or on the same page again, it adds nothing more; the manifest is fetched once", async () => {
		const p = open();
		p.window.__idle();
		p.window.__idle();
		expect(p.idles).toHaveLength(1);
		await p.flush();
		expect(p.hints()).toHaveLength(6);
		p.window.document.dispatchEvent(new p.window.Event("natsu:load"));
		await p.flush();
		expect(p.hints()).toHaveLength(6);
		expect(p.fetched).toHaveLength(1);
	});

	test("a page visited next gets its own bounded share, without a chunk hinted twice", async () => {
		const p = open({ body: "<div data-editor></div>" });
		p.window.__idle({ max: 3 });
		await p.flush();
		expect(p.hints()).toEqual(["/_a/chunk.editor.js", "/_a/chunk.shared.js", "/_a/chunk.rich.js"]);
		p.window.happyDOM.setURL(`${ORIGIN}/b`);
		p.window.document.body.innerHTML = "<div data-chart></div>";
		p.window.document.dispatchEvent(new p.window.Event("natsu:load"));
		await p.flush();
		expect(p.hints()).toEqual(["/_a/chunk.editor.js", "/_a/chunk.shared.js", "/_a/chunk.rich.js", "/_a/chunk.chart.js", "/_a/chunk.plot.js", "/_a/chunk.deep.js"]);
		expect(new Set(p.hints()).size).toBe(6);
		expect(p.fetched).toHaveLength(1);
		p.window.happyDOM.setURL(`${ORIGIN}/c`);
		p.window.document.dispatchEvent(new p.window.Event("natsu:load"));
		await p.flush();
		expect(p.hints()).toEqual(["/_a/chunk.editor.js", "/_a/chunk.shared.js", "/_a/chunk.rich.js", "/_a/chunk.chart.js", "/_a/chunk.plot.js", "/_a/chunk.deep.js", "/_a/chunk.map.js"]);
	});

	test("Save-Data turned on later stops further hints", async () => {
		const connection = { saveData: false };
		const p = open({ connection });
		p.window.__idle({ max: 2 });
		await p.flush();
		expect(p.hints()).toHaveLength(2);
		connection.saveData = true;
		p.window.happyDOM.setURL(`${ORIGIN}/b`);
		p.window.document.dispatchEvent(new p.window.Event("natsu:load"));
		await p.flush();
		expect(p.hints()).toHaveLength(2);
	});

	test("the runtime is small", () => {
		expect(Bun.gzipSync(Buffer.from(CODE)).length).toBeLessThan(2600);
	});
});
