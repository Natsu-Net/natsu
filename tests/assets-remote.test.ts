import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blockMatcher } from "../src/assets/blocklist.ts";
import { contentHash } from "../src/assets/binary.ts";
import type { RemotePolicy, RemoteRef } from "../src/assets/contract.ts";
import { fetchRemote, isPublicAddress, readLock, resolveRemote, withoutIntegrity, writeLock } from "../src/assets/remote.ts";

const SCRIPT = `window.lib=function(){return 1};\n//# sourceMappingURL=lib.js.map\n`;
const STYLE = `@import "base.css";\n.a{background:url(../img/a.png?v=2#x)}\n.b{background:url("data:image/png;base64,AAAA")}\n.c{src:url(/fonts/f.woff2)}\n.d{filter:url(#blur)}\n/*# sourceMappingURL=lib.css.map */\n`;

function sri(algorithm: "sha256" | "sha384" | "sha512", body: string | Uint8Array): string {
	return `${algorithm}-${new Bun.CryptoHasher(algorithm).update(body).digest("base64")}`;
}

let server: ReturnType<typeof Bun.serve>;
let base: string;
let hits: Record<string, number>;
let seenHeaders: Headers | undefined;
let scriptBody = SCRIPT;
let dir: string;

const loopback: RemotePolicy = { allowLoopbackHttp: true, timeoutMs: 5000 };

beforeAll(() => {
	server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(request) {
			const path = new URL(request.url).pathname;
			hits[path] = (hits[path] ?? 0) + 1;
			seenHeaders = request.headers;
			const js = { "content-type": "text/javascript; charset=utf-8" };
			if (path === "/lib.js") return new Response(scriptBody, { headers: js });
			if (path === "/other.js") return new Response("window.other=2;", { headers: { "content-type": "application/javascript" } });
			if (path === "/css/lib.css") return new Response(STYLE, { headers: { "content-type": "text/css" } });
			if (path === "/html.js") return new Response("<html></html>", { headers: { "content-type": "text/html" } });
			if (path === "/untyped.js") return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "" } });
			if (path === "/missing.js") return new Response("no", { status: 404, headers: js });
			if (path === "/big.js") return new Response("x".repeat(4096), { headers: js });
			if (path === "/big-stream.js") {
				const stream = new ReadableStream<Uint8Array>({
					start(controller) {
						for (let n = 0; n < 64; n++) controller.enqueue(new TextEncoder().encode("y".repeat(1024)));
						controller.close();
					},
				});
				return new Response(stream, { headers: js });
			}
			if (path === "/slow.js") {
				await Bun.sleep(1500);
				return new Response("late", { headers: js });
			}
			if (path === "/hop1") return new Response(null, { status: 302, headers: { location: "/hop2" } });
			if (path === "/hop2") return new Response(null, { status: 307, headers: { location: `${base}/v2/lib.js` } });
			if (path === "/v2/lib.js") return new Response(scriptBody, { headers: js });
			if (path === "/css-moved") return new Response(null, { status: 301, headers: { location: "/css/lib.css" } });
			if (path === "/loop") return new Response(null, { status: 302, headers: { location: "/loop" } });
			if (path === "/to-private") return new Response(null, { status: 302, headers: { location: "https://internal.test/secret.js" } });
			if (path === "/to-metadata") return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" } });
			if (path === "/to-file") return new Response(null, { status: 302, headers: { location: "file:///etc/passwd" } });
			if (path === "/to-credentials") return new Response(null, { status: 302, headers: { location: `http://user:pw@127.0.0.1:${server.port}/lib.js` } });
			if (path === "/no-location") return new Response(null, { status: 302 });
			return new Response("?", { status: 500 });
		},
	});
	base = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
	await server.stop(true);
});

beforeEach(() => {
	hits = {};
	seenHeaders = undefined;
	scriptBody = SCRIPT;
	dir = mkdtempSync(join(tmpdir(), "natsu-remote-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function totalHits(): number {
	return Object.values(hits).reduce((sum, n) => sum + n, 0);
}

async function failure(work: Promise<unknown>): Promise<string> {
	try {
		await work;
	} catch (error) {
		return (error as Error).message;
	}
	throw new Error("expected a rejection");
}

function policy(extra: Partial<RemotePolicy> = {}): RemotePolicy & { outDir: string; cwd: string } {
	return { ...loopback, outDir: "out", cwd: dir, now: () => new Date("2026-01-02T03:04:05.000Z"), ...extra };
}

function scriptRef(path = "/lib.js", integrity?: string): RemoteRef {
	return { ref: `${base}${path}`, url: `${base}${path}`, kind: "script", integrity };
}

describe("isPublicAddress", () => {
	test("public addresses pass", () => {
		for (const address of ["93.184.216.34", "1.1.1.1", "8.8.8.8", "172.15.0.1", "172.32.0.1", "100.63.0.1", "100.128.0.1", "198.17.0.1", "198.20.0.1", "192.0.1.1", "223.255.255.255", "2606:4700::1111", "2001:4860:4860::8888", "[2606:4700::1111]", "::ffff:8.8.8.8", "64:ff9b::808:808"]) {
			expect(isPublicAddress(address)).toBe(true);
		}
	});

	test("private, loopback, link-local, metadata and reserved addresses are refused", () => {
		for (const address of [
			"0.0.0.0",
			"0.1.2.3",
			"10.0.0.1",
			"10.255.255.255",
			"100.64.0.1",
			"100.127.255.255",
			"127.0.0.1",
			"127.9.9.9",
			"169.254.169.254",
			"169.254.0.1",
			"172.16.0.1",
			"172.31.255.255",
			"192.0.0.1",
			"192.168.1.1",
			"198.18.0.1",
			"198.19.255.255",
			"224.0.0.1",
			"239.1.1.1",
			"240.0.0.1",
			"255.255.255.255",
			"::",
			"::1",
			"[::1]",
			"fc00::1",
			"fd00:ec2::254",
			"fe80::1",
			"fe80::1%eth0",
			"febf::1",
			"fec0::1",
			"ff02::1",
			"::ffff:127.0.0.1",
			"::ffff:7f00:1",
			"::ffff:10.0.0.1",
			"::ffff:169.254.169.254",
			"::ffff:a9fe:a9fe",
			"::127.0.0.1",
			"64:ff9b::7f00:1",
			"64:ff9b::10.0.0.1",
			"64:ff9b::a9fe:a9fe",
			"64:ff9b:1::1",
			"2002:7f00:1::1",
			"2002:a00:1::1",
		]) {
			expect(isPublicAddress(address)).toBe(false);
		}
	});

	test("anything that is not an address is refused", () => {
		for (const address of ["", "localhost", "example.com", "1.2.3", "1.2.3.4.5", "256.1.1.1", "0x7f.0.0.1", "127.1", ":::", "1::2::3", "gggg::1"]) {
			expect(isPublicAddress(address)).toBe(false);
		}
	});
});

describe("fetchRemote", () => {
	test("fetches a script from an allowed loopback and hashes it", async () => {
		const got = await fetchRemote(`${base}/lib.js`, "script", loopback);
		expect(new TextDecoder().decode(got.body)).toBe(SCRIPT);
		expect(got.type).toBe("text/javascript");
		expect(got.url).toBe(`${base}/lib.js`);
		expect(got.finalUrl).toBe(`${base}/lib.js`);
		expect(`sha384-${got.sha384}`).toBe(sri("sha384", SCRIPT));
		expect(seenHeaders?.get("cookie")).toBeNull();
		expect(seenHeaders?.get("authorization")).toBeNull();
		expect(seenHeaders?.get("accept")).toContain("text/javascript");
	});

	test("plain http is refused, loopback included, unless the test option is set", async () => {
		expect(await failure(fetchRemote(`${base}/lib.js`, "script", {}))).toContain(`remote asset refused: ${base}/lib.js: http: is not allowed`);
		expect(await failure(fetchRemote("http://cdn.example/lib.js", "script", { lookup: async () => ["93.184.216.34"] }))).toContain("http: is not allowed");
		expect(totalHits()).toBe(0);
	});

	test("with the loopback option, http to anything but loopback is still refused", async () => {
		let asked = 0;
		const lookup = async (): Promise<string[]> => {
			asked++;
			return ["93.184.216.34"];
		};
		expect(await failure(fetchRemote("http://cdn.example/lib.js", "script", { allowLoopbackHttp: true, lookup }))).toContain("http: is only allowed for loopback");
		expect(asked).toBe(1);
		expect(await failure(fetchRemote("http://10.0.0.1/lib.js", "script", { allowLoopbackHttp: true }))).toContain("http: is only allowed for loopback");
	});

	test("other schemes are refused", async () => {
		for (const url of ["file:///etc/passwd", "ftp://cdn.example/a.js", "data:text/javascript,1", "javascript:1", "not a url"]) {
			expect(await failure(fetchRemote(url, "script", loopback))).toContain("remote asset refused: ");
		}
	});

	test("credentials in the URL are refused", async () => {
		expect(await failure(fetchRemote(`http://user:pw@127.0.0.1:${server.port}/lib.js`, "script", loopback))).toContain("credentials in the URL are not allowed");
		expect(await failure(fetchRemote("https://user@cdn.example/lib.js", "script", { lookup: async () => ["93.184.216.34"] }))).toContain("credentials");
		expect(totalHits()).toBe(0);
	});

	test("a port other than the default is refused away from loopback", async () => {
		expect(await failure(fetchRemote("https://cdn.example:8443/lib.js", "script", { lookup: async () => ["93.184.216.34"] }))).toContain("port 8443 is not allowed");
	});

	test("a private, loopback, link-local or metadata address is refused before any request", async () => {
		for (const url of ["https://10.0.0.1/a.js", "https://127.0.0.1/a.js", "https://169.254.169.254/a.js", "https://[::1]/a.js", "https://[fd00::1]/a.js", "https://[::ffff:10.0.0.1]/a.js", "https://0x7f.1/a.js", "https://2130706433/a.js"]) {
			expect(await failure(fetchRemote(url, "script", {}))).toContain("non-public address");
		}
	});

	test("the resolved address is checked, not the name", async () => {
		const message = await failure(fetchRemote("https://cdn.example/lib.js", "script", { lookup: async () => ["127.0.0.1"] }));
		expect(message).toBe("remote asset refused: https://cdn.example/lib.js: cdn.example resolves to a non-public address 127.0.0.1");
	});

	test("one private address among public ones refuses the host", async () => {
		const message = await failure(fetchRemote("https://cdn.example/lib.js", "script", { lookup: async () => ["93.184.216.34", "10.0.0.7", "1.1.1.1"] }));
		expect(message).toContain("cdn.example resolves to a non-public address 10.0.0.7");
		const mixed = await failure(fetchRemote("http://mixed.test/lib.js", "script", { allowLoopbackHttp: true, lookup: async () => ["127.0.0.1", "10.0.0.7"] }));
		expect(mixed).toContain("remote asset refused: ");
	});

	test("a name that does not resolve is refused", async () => {
		expect(await failure(fetchRemote("https://cdn.example/lib.js", "script", { lookup: async () => [] }))).toContain("could not resolve cdn.example");
		expect(
			await failure(
				fetchRemote("https://cdn.example/lib.js", "script", {
					lookup: async () => {
						throw new Error("ENOTFOUND");
					},
				}),
			),
		).toContain("could not resolve cdn.example");
	});

	test("the hosts allow-list is applied before the lookup", async () => {
		let asked = 0;
		const lookup = async (): Promise<string[]> => {
			asked++;
			return ["93.184.216.34"];
		};
		expect(await failure(fetchRemote("https://evil.example/lib.js", "script", { hosts: ["cdn.example", "*.fonts.example", /^static\d\.example$/], lookup }))).toContain("host evil.example is not in remote.hosts");
		expect(await failure(fetchRemote("https://fonts.example/lib.js", "script", { hosts: ["*.fonts.example"], lookup }))).toContain("not in remote.hosts");
		expect(asked).toBe(0);
		expect(await failure(fetchRemote(`${base}/lib.js`, "script", { ...loopback, hosts: ["cdn.example"] }))).toContain("host 127.0.0.1 is not in remote.hosts");
		const got = await fetchRemote(`${base}/lib.js`, "script", { ...loopback, hosts: ["127.0.0.1"] });
		expect(got.body.byteLength).toBe(SCRIPT.length);
	});

	test("redirects are followed, each hop validated, final URL reported", async () => {
		const got = await fetchRemote(`${base}/hop1`, "script", loopback);
		expect(got.finalUrl).toBe(`${base}/v2/lib.js`);
		expect(got.url).toBe(`${base}/hop1`);
		expect(hits["/hop1"]).toBe(1);
		expect(hits["/hop2"]).toBe(1);
		expect(hits["/v2/lib.js"]).toBe(1);
	});

	test("redirects are capped", async () => {
		expect(await failure(fetchRemote(`${base}/loop`, "script", loopback))).toContain("more than 3 redirects");
		expect(hits["/loop"]).toBe(4);
		hits = {};
		expect(await failure(fetchRemote(`${base}/hop1`, "script", { ...loopback, maxRedirects: 1 }))).toContain("more than 1 redirects");
		expect(hits["/v2/lib.js"]).toBeUndefined();
		expect(await failure(fetchRemote(`${base}/hop1`, "script", { ...loopback, maxRedirects: 0 }))).toContain("more than 0 redirects");
	});

	test("a redirect to a private address is refused and never followed", async () => {
		let asked: string[] = [];
		const lookup = async (host: string): Promise<string[]> => {
			asked.push(host);
			return ["10.0.0.8"];
		};
		const message = await failure(fetchRemote(`${base}/to-private`, "script", { ...loopback, lookup }));
		expect(message).toBe(`remote asset refused: ${base}/to-private: internal.test resolves to a non-public address 10.0.0.8`);
		expect(asked).toEqual(["internal.test"]);
		asked = [];
		expect(await failure(fetchRemote(`${base}/to-metadata`, "script", loopback))).toContain("http: is only allowed for loopback");
		expect(await failure(fetchRemote(`${base}/to-file`, "script", loopback))).toContain("file: is not allowed");
		expect(await failure(fetchRemote(`${base}/to-credentials`, "script", loopback))).toContain("credentials");
		expect(await failure(fetchRemote(`${base}/no-location`, "script", loopback))).toContain("redirect without a location");
		expect(hits["/lib.js"]).toBeUndefined();
	});

	test("the wrong content type is refused per kind", async () => {
		expect(await failure(fetchRemote(`${base}/html.js`, "script", loopback))).toContain("content type text/html is not allowed for a script");
		expect(await failure(fetchRemote(`${base}/css/lib.css`, "script", loopback))).toContain("content type text/css is not allowed for a script");
		expect(await failure(fetchRemote(`${base}/lib.js`, "style", loopback))).toContain("content type text/javascript is not allowed for a style");
		expect(await failure(fetchRemote(`${base}/untyped.js`, "script", loopback))).toContain("is not allowed for a script");
		expect((await fetchRemote(`${base}/other.js`, "script", loopback)).type).toBe("application/javascript");
		expect((await fetchRemote(`${base}/css/lib.css`, "style", loopback)).type).toBe("text/css");
	});

	test("a status other than 200 is refused", async () => {
		expect(await failure(fetchRemote(`${base}/missing.js`, "script", loopback))).toContain("status 404");
	});

	test("an oversize body is refused, declared or streamed", async () => {
		expect(await failure(fetchRemote(`${base}/big.js`, "script", { ...loopback, maxBytes: 1000 }))).toContain("body is larger than 1000 bytes");
		expect(await failure(fetchRemote(`${base}/big-stream.js`, "script", { ...loopback, maxBytes: 3000 }))).toContain("body is larger than 3000 bytes");
		expect((await fetchRemote(`${base}/big.js`, "script", { ...loopback, maxBytes: 4096 })).body.byteLength).toBe(4096);
	});

	test("the timeout covers the whole exchange", async () => {
		const started = performance.now();
		expect(await failure(fetchRemote(`${base}/slow.js`, "script", { ...loopback, timeoutMs: 100 }))).toContain("timed out after 100 ms");
		expect(performance.now() - started).toBeLessThan(1200);
		const stalled = await failure(fetchRemote("https://cdn.example/lib.js", "script", { timeoutMs: 80, lookup: () => new Promise<string[]>(() => undefined) }));
		expect(stalled).toContain("timed out after 80 ms");
	});
});

describe("lockfile", () => {
	test("a missing lockfile reads as empty", async () => {
		expect(await readLock(join(dir, "none.json"))).toEqual({ version: 1, pins: {} });
	});

	test("it is written sorted, two-space, with a final newline, and reads back", async () => {
		const path = join(dir, "lock.json");
		const a = { sha384: "A".repeat(64), size: 3, type: "text/css", pinned: "2026-01-02T03:04:05.000Z" };
		const b = { type: "text/javascript", pinned: "2026-01-01T00:00:00.000Z", size: 9, sha384: "B".repeat(64) };
		await writeLock(path, { version: 1, pins: { "https://z.example/b.js": b, "https://a.example/a.css": a } });
		const text = readFileSync(path, "utf8");
		expect(text).toBe(
			`{\n  "version": 1,\n  "pins": {\n    "https://a.example/a.css": {\n      "sha384": "${"A".repeat(64)}",\n      "size": 3,\n      "type": "text/css",\n      "pinned": "2026-01-02T03:04:05.000Z"\n    },\n    "https://z.example/b.js": {\n      "sha384": "${"B".repeat(64)}",\n      "size": 9,\n      "type": "text/javascript",\n      "pinned": "2026-01-01T00:00:00.000Z"\n    }\n  }\n}\n`,
		);
		const lock = await readLock(path);
		expect(Object.keys(lock.pins)).toEqual(["https://a.example/a.css", "https://z.example/b.js"]);
		await writeLock(path, lock);
		expect(readFileSync(path, "utf8")).toBe(text);
		expect(readdirSync(dir)).toEqual(["lock.json"]);
	});

	test("a damaged lockfile throws and names the file", async () => {
		const path = join(dir, "lock.json");
		for (const text of ["{", "[]", `{"version":2,"pins":{}}`, `{"version":1}`, `{"version":1,"pins":{"https://a.example/a.js":{"sha384":"short","size":1,"type":"text/javascript","pinned":"x"}}}`, `{"version":1,"pins":{"https://a.example/a.js":{"sha384":"${"A".repeat(64)}","size":-1,"type":"text/javascript","pinned":"x"}}}`]) {
			writeFileSync(path, text);
			expect(await failure(readLock(path))).toContain(path);
		}
	});
});

describe("resolveRemote", () => {
	test("an unpinned URL is refused without pin and nothing is written", async () => {
		const message = await failure(resolveRemote([scriptRef()], policy()));
		expect(message).toBe(`remote asset not pinned: ${base}/lib.js`);
		expect(existsSync(join(dir, "natsu-assets.lock.json"))).toBe(false);
		expect(existsSync(join(dir, "out", ".remote"))).toBe(false);
	});

	test("pin writes the lockfile, then a warm build does no network at all", async () => {
		const pinnedRun = await resolveRemote([scriptRef()], policy({ pin: true }));
		expect(pinnedRun.pinned).toEqual([`${base}/lib.js`]);
		expect(pinnedRun.fetched).toBe(1);
		const lockText = readFileSync(join(dir, "natsu-assets.lock.json"), "utf8");
		const lock = JSON.parse(lockText) as { version: number; pins: Record<string, { sha384: string; size: number; type: string; pinned: string }> };
		expect(lock.version).toBe(1);
		expect(lock.pins[`${base}/lib.js`]).toEqual({
			sha384: sri("sha384", SCRIPT).slice(7),
			size: SCRIPT.length,
			type: "text/javascript",
			pinned: "2026-01-02T03:04:05.000Z",
		});
		expect(lockText.endsWith("}\n")).toBe(true);

		hits = {};
		const warm = await resolveRemote([scriptRef()], policy());
		expect(totalHits()).toBe(0);
		expect(warm.fetched).toBe(0);
		expect(warm.pinned).toEqual([]);
		expect(warm.assets).toHaveLength(1);
		expect(warm.assets[0]?.fromCache).toBe(true);
		expect(warm.assets[0]?.body).toBe(pinnedRun.assets[0]?.body as string);
		expect(warm.assets[0]?.file).toBe(pinnedRun.assets[0]?.file as string);
		expect(readFileSync(join(dir, "natsu-assets.lock.json"), "utf8")).toBe(lockText);
	});

	test("with pins and a cold cache the body is fetched once and checked", async () => {
		await resolveRemote([scriptRef()], policy({ pin: true }));
		rmSync(join(dir, "out"), { recursive: true, force: true });
		hits = {};
		const cold = await resolveRemote([scriptRef()], policy());
		expect(hits["/lib.js"]).toBe(1);
		expect(cold.fetched).toBe(1);
		expect(cold.assets[0]?.fromCache).toBe(false);
		hits = {};
		await resolveRemote([scriptRef()], policy());
		expect(totalHits()).toBe(0);
	});

	test("a changed remote fails the build and names the URL and both hashes", async () => {
		await resolveRemote([scriptRef()], policy({ pin: true }));
		const lockText = readFileSync(join(dir, "natsu-assets.lock.json"), "utf8");
		rmSync(join(dir, "out"), { recursive: true, force: true });
		scriptBody = "window.lib=function(){return 'tampered'};";
		const message = await failure(resolveRemote([scriptRef()], policy()));
		expect(message).toBe(`remote asset changed: ${base}/lib.js pinned ${sri("sha384", SCRIPT)} got ${sri("sha384", scriptBody)}; run the pin command to accept`);
		expect(readFileSync(join(dir, "natsu-assets.lock.json"), "utf8")).toBe(lockText);
		expect(existsSync(join(dir, "out", ".remote"))).toBe(false);
	});

	test("pin accepts a changed remote on purpose, even with a warm cache", async () => {
		await resolveRemote([scriptRef()], policy({ pin: true }));
		scriptBody = "window.lib=function(){return 2};";
		const still = await resolveRemote([scriptRef()], policy());
		expect(still.assets[0]?.body).toBe("window.lib=function(){return 1};\n");
		const again = await resolveRemote([scriptRef()], policy({ pin: true, now: () => new Date("2026-02-02T00:00:00.000Z") }));
		expect(again.pinned).toEqual([`${base}/lib.js`]);
		expect(again.lock.pins[`${base}/lib.js`]?.sha384).toBe(sri("sha384", scriptBody).slice(7));
		expect(again.lock.pins[`${base}/lib.js`]?.pinned).toBe("2026-02-02T00:00:00.000Z");
		expect(again.assets[0]?.body).toBe(scriptBody);
		const after = await resolveRemote([scriptRef()], policy());
		expect(after.assets[0]?.body).toBe(scriptBody);
	});

	test("pin with nothing changed leaves the lockfile alone", async () => {
		await resolveRemote([scriptRef()], policy({ pin: true }));
		const path = join(dir, "natsu-assets.lock.json");
		const before = readFileSync(path, "utf8");
		const again = await resolveRemote([scriptRef()], policy({ pin: true, now: () => new Date("2027-01-01T00:00:00.000Z") }));
		expect(again.pinned).toEqual([]);
		expect(readFileSync(path, "utf8")).toBe(before);
	});

	test("a damaged cache entry is not trusted", async () => {
		await resolveRemote([scriptRef()], policy({ pin: true }));
		const cache = join(dir, "out", ".remote");
		const bodyFile = readdirSync(cache).find((name) => !name.endsWith(".json")) as string;
		writeFileSync(join(cache, bodyFile), "window.evil=1;//////////////////////////////////////////////////////");
		hits = {};
		const result = await resolveRemote([scriptRef()], policy());
		expect(hits["/lib.js"]).toBe(1);
		expect(result.assets[0]?.body).toBe("window.lib=function(){return 1};\n");
		expect(readFileSync(join(cache, bodyFile), "utf8")).toBe(SCRIPT);
	});

	test("the cache is private and its files are named by hash", async () => {
		await resolveRemote([scriptRef()], policy({ pin: true }));
		const cache = join(dir, "out", ".remote");
		expect(statSync(cache).mode & 0o777).toBe(0o700);
		const hex = Buffer.from(sri("sha384", SCRIPT).slice(7), "base64").toString("hex");
		expect(readdirSync(cache).sort()).toEqual([hex, `${hex}.json`]);
		expect(statSync(join(cache, hex)).mode & 0o777).toBe(0o600);
	});

	test("lockfile and cache locations follow the options", async () => {
		await resolveRemote([scriptRef()], policy({ pin: true, lockfile: "locks/remote.json", cacheDir: "tmp/cache" }));
		expect(existsSync(join(dir, "locks", "remote.json"))).toBe(true);
		expect(readdirSync(join(dir, "tmp", "cache"))).toHaveLength(2);
		expect(existsSync(join(dir, "out"))).toBe(false);
	});

	test("the served script drops its source map line and gets a hashed first-party name", async () => {
		const result = await resolveRemote([scriptRef()], policy({ pin: true }));
		const asset = result.assets[0];
		expect(asset?.body).toBe("window.lib=function(){return 1};\n");
		expect(asset?.type).toBe("text/javascript; charset=utf-8");
		expect(asset?.kind).toBe("script");
		expect(asset?.file).toBe(`r-127-0-0-1-lib.${contentHash(asset?.body as string)}.js`);
		expect(asset?.file).toMatch(/^[\w.-]+$/);
		expect(asset?.integrity).toBe(sri("sha384", asset?.body as string));
		expect(asset?.sha384).toBe(sri("sha384", SCRIPT).slice(7));
		expect(asset?.ref).toBe(`${base}/lib.js`);
	});

	test("a remote stylesheet has relative url() and @import made absolute against the final URL", async () => {
		const ref: RemoteRef = { ref: `${base}/css-moved`, url: `${base}/css-moved`, kind: "style" };
		const result = await resolveRemote([ref], policy({ pin: true }));
		const expected = `@import "${base}/css/base.css";\n.a{background:url(${base}/img/a.png?v=2#x)}\n.b{background:url("data:image/png;base64,AAAA")}\n.c{src:url(${base}/fonts/f.woff2)}\n.d{filter:url(#blur)}\n`;
		expect(result.assets[0]?.body).toBe(expected);
		expect(result.assets[0]?.type).toBe("text/css; charset=utf-8");
		expect(result.assets[0]?.file).toBe(`r-127-0-0-1-css-moved.${contentHash(expected)}.css`);
		hits = {};
		const warm = await resolveRemote([ref], policy());
		expect(totalHits()).toBe(0);
		expect(warm.assets[0]?.body).toBe(expected);
		expect(warm.assets[0]?.file).toBe(result.assets[0]?.file as string);
	});

	test("a tag's own integrity that disagrees always throws, pin or not", async () => {
		const wrong = sri("sha384", "something else");
		const message = await failure(resolveRemote([scriptRef("/lib.js", wrong)], policy({ pin: true })));
		expect(message).toBe(`remote asset integrity mismatch: ${base}/lib.js tag ${wrong} got ${sri("sha384", SCRIPT)}`);
		expect(existsSync(join(dir, "natsu-assets.lock.json"))).toBe(false);

		await resolveRemote([scriptRef()], policy({ pin: true }));
		hits = {};
		expect(await failure(resolveRemote([scriptRef("/lib.js", wrong)], policy()))).toContain("remote asset integrity mismatch");
		expect(totalHits()).toBe(0);
	});

	test("a tag's integrity that agrees passes, strongest algorithm deciding", async () => {
		const good = await resolveRemote([scriptRef("/lib.js", sri("sha384", SCRIPT))], policy({ pin: true }));
		expect(good.assets).toHaveLength(1);
		const mixed = `${sri("sha256", "weak and wrong")} ${sri("sha512", SCRIPT)} unknown-abc`;
		expect((await resolveRemote([scriptRef("/lib.js", mixed)], policy())).assets).toHaveLength(1);
		const weakOnly = `${sri("sha256", SCRIPT)} ${sri("sha512", "strong and wrong")}`;
		expect(await failure(resolveRemote([scriptRef("/lib.js", weakOnly)], policy()))).toContain("integrity mismatch");
	});

	test("every ref is checked and the error lists every failing URL", async () => {
		const refs: RemoteRef[] = [scriptRef("/other.js"), scriptRef("/lib.js"), scriptRef("/html.js"), { ref: "https://cdn.example/x.js", url: "https://cdn.example/x.js", kind: "script" }];
		const message = await failure(resolveRemote(refs, policy({ lookup: async () => ["192.168.0.4"] })));
		expect(message.split("\n")).toEqual([
			`remote asset refused: ${base}/html.js: content type text/html is not allowed for a script`,
			`remote asset not pinned: ${base}/lib.js`,
			`remote asset not pinned: ${base}/other.js`,
			"remote asset refused: https://cdn.example/x.js: cdn.example resolves to a non-public address 192.168.0.4",
		]);
	});

	test("assets come back in sorted URL order and one URL is fetched once", async () => {
		const refs: RemoteRef[] = [scriptRef("/other.js"), { ref: `//127.0.0.1:${server.port}/lib.js`, url: `${base}/lib.js`, kind: "script" }, scriptRef("/lib.js")];
		const result = await resolveRemote(refs, policy({ pin: true }));
		expect(result.assets.map((asset) => asset.url)).toEqual([`${base}/lib.js`, `${base}/lib.js`, `${base}/other.js`]);
		expect(result.assets.map((asset) => asset.ref)).toEqual([`//127.0.0.1:${server.port}/lib.js`, `${base}/lib.js`, `${base}/other.js`]);
		expect(hits["/lib.js"]).toBe(1);
		expect(result.fetched).toBe(2);
		expect(result.pinned).toEqual([`${base}/lib.js`, `${base}/other.js`]);
		expect(Object.keys(result.lock.pins)).toEqual([`${base}/lib.js`, `${base}/other.js`]);
	});

	test("a pinned script cannot be reused as a stylesheet", async () => {
		await resolveRemote([scriptRef()], policy({ pin: true }));
		const message = await failure(resolveRemote([{ ref: `${base}/lib.js`, url: `${base}/lib.js`, kind: "style" }], policy()));
		expect(message).toContain("content type text/javascript is not allowed for a style");
	});

	test("a blocked URL is never requested", async () => {
		const isBlocked = blockMatcher([`${base}/other.js`]);
		const refs = [scriptRef("/lib.js"), scriptRef("/other.js")].filter((ref) => !isBlocked(ref.ref));
		const result = await resolveRemote(refs, policy({ pin: true }));
		expect(result.assets.map((asset) => asset.url)).toEqual([`${base}/lib.js`]);
		expect(hits["/other.js"]).toBeUndefined();
		expect(hits["/lib.js"]).toBe(1);
	});

	test("no refs means no lockfile, no cache and no network", async () => {
		const result = await resolveRemote([], policy({ pin: true }));
		expect(result).toEqual({ assets: [], lock: { version: 1, pins: {} }, pinned: [], fetched: 0 });
		expect(readdirSync(dir)).toEqual([]);
		expect(totalHits()).toBe(0);
	});
});

describe("withoutIntegrity", () => {
	test("removes integrity and crossorigin and nothing else", () => {
		expect(withoutIntegrity(`<script src="https://cdn.example/a.js" integrity="sha384-abc" crossorigin="anonymous" defer></script>`)).toBe(`<script src="https://cdn.example/a.js" defer></script>`);
		expect(withoutIntegrity(`<link rel="stylesheet" href="/x.css" crossorigin integrity='sha384-abc'>`)).toBe(`<link rel="stylesheet" href="/x.css">`);
		expect(withoutIntegrity(`<script\n\tINTEGRITY = "sha384-abc"\n\tsrc=a.js crossorigin=anonymous></script>`)).toBe(`<script\n\tsrc=a.js></script>`);
		expect(withoutIntegrity(`<link integrity=sha384-abc href=/x.css />`)).toBe(`<link href=/x.css />`);
	});

	test("a tag without them is returned as it came", () => {
		for (const tag of [`<script src="/a.js" data-integrity="x" defer></script>`, `<script src="/a.js?integrity=1&crossorigin=2"></script>`, `<link rel="stylesheet" href="/x.css" title="integrity crossorigin">`, `<script>`, `<script src="unterminated integrity="x">`, "not a tag", ""]) {
			expect(withoutIntegrity(tag)).toBe(tag);
		}
	});

	test("only the start tag is read", () => {
		expect(withoutIntegrity(`<script src="/a.js" integrity="x">var crossorigin = "integrity=1";</script>`)).toBe(`<script src="/a.js">var crossorigin = "integrity=1";</script>`);
	});
});
