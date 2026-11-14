import { lookup as dnsLookup } from "node:dns/promises";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { dirname, join, resolve } from "node:path";
import { hashedName, rewriteCssUrls } from "./binary.ts";
import type { AssetRule, RemoteAsset, RemoteFetched, RemoteKind, RemoteLock, RemotePin, RemotePolicy, RemoteRef, RemoteResult } from "./contract.ts";

const DEFAULT_LOCKFILE = "natsu-assets.lock.json";
const DEFAULT_MAX_BYTES = 5_000_000;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_REDIRECTS = 3;

const CONTENT_TYPES: Record<RemoteKind, readonly string[]> = {
	script: ["text/javascript", "application/javascript", "application/x-javascript", "text/ecmascript"],
	style: ["text/css"],
};

const ACCEPT: Record<RemoteKind, string> = {
	script: "text/javascript, application/javascript;q=0.9, */*;q=0.1",
	style: "text/css, */*;q=0.1",
};

const SERVED: Record<RemoteKind, { type: string; extension: string }> = {
	script: { type: "text/javascript; charset=utf-8", extension: ".js" },
	style: { type: "text/css; charset=utf-8", extension: ".css" },
};

const SHA384 = /^[A-Za-z0-9+/]{64}$/;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

let writeCount = 0;

export function isPublicAddress(address: string): boolean {
	const bytes = addressBytes(address);
	if (bytes === undefined) return false;
	if (bytes.length === 4) return isPublicV4(bytes[0] as number, bytes[1] as number, bytes[2] as number);
	return isPublicV6(bytes);
}

function isLoopbackAddress(address: string): boolean {
	const bytes = addressBytes(address);
	if (bytes === undefined) return false;
	if (bytes.length === 4) return bytes[0] === 127;
	if (allZero(bytes, 0, 15)) return bytes[15] === 1;
	if (allZero(bytes, 0, 10) && bytes[10] === 0xff && bytes[11] === 0xff) return bytes[12] === 127;
	return false;
}

function addressBytes(address: string): Uint8Array | undefined {
	if (typeof address !== "string") return undefined;
	let text = address.trim();
	if (text.startsWith("[") && text.endsWith("]")) text = text.slice(1, -1);
	const zone = text.indexOf("%");
	if (zone >= 0) text = text.slice(0, zone);
	const family = isIP(text);
	if (family === 4) return parseV4(text);
	if (family === 6) return parseV6(text);
	return undefined;
}

function parseV4(text: string): Uint8Array | undefined {
	const parts = text.split(".");
	if (parts.length !== 4) return undefined;
	const bytes = new Uint8Array(4);
	for (let n = 0; n < 4; n++) {
		const part = parts[n] as string;
		if (!/^\d{1,3}$/.test(part)) return undefined;
		const value = Number(part);
		if (value > 255) return undefined;
		bytes[n] = value;
	}
	return bytes;
}

function parseV6(text: string): Uint8Array | undefined {
	let head = text;
	let tail: Uint8Array | undefined;
	if (text.includes(".")) {
		const cut = text.lastIndexOf(":");
		if (cut < 0) return undefined;
		tail = parseV4(text.slice(cut + 1));
		if (tail === undefined) return undefined;
		head = text.slice(0, cut);
		if (head.endsWith(":")) head += ":";
		if (head === "") return undefined;
	}
	const groupCount = tail === undefined ? 8 : 6;
	const gap = head.indexOf("::");
	let groups: string[];
	if (gap < 0) {
		groups = head.split(":");
		if (groups.length !== groupCount) return undefined;
	} else {
		if (head.indexOf("::", gap + 1) >= 0) return undefined;
		const left = head.slice(0, gap) === "" ? [] : head.slice(0, gap).split(":");
		const right = head.slice(gap + 2) === "" ? [] : head.slice(gap + 2).split(":");
		const missing = groupCount - left.length - right.length;
		if (missing < 0) return undefined;
		groups = [...left, ...new Array<string>(missing).fill("0"), ...right];
	}
	const bytes = new Uint8Array(16);
	for (let n = 0; n < groups.length; n++) {
		const group = groups[n] as string;
		if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return undefined;
		const value = Number.parseInt(group, 16);
		bytes[n * 2] = value >> 8;
		bytes[n * 2 + 1] = value & 0xff;
	}
	if (tail !== undefined) bytes.set(tail, 12);
	return bytes;
}

function isPublicV4(a: number, b: number, c: number): boolean {
	if (a === 0 || a === 10 || a === 127) return false;
	if (a === 100 && b >= 64 && b <= 127) return false;
	if (a === 169 && b === 254) return false;
	if (a === 172 && b >= 16 && b <= 31) return false;
	if (a === 192 && b === 0 && c === 0) return false;
	if (a === 192 && b === 168) return false;
	if (a === 198 && (b === 18 || b === 19)) return false;
	if (a >= 224) return false;
	return true;
}

function isPublicV6(bytes: Uint8Array): boolean {
	const first = bytes[0] as number;
	const second = bytes[1] as number;
	if (allZero(bytes, 0, 12)) return false;
	if (allZero(bytes, 0, 10) && bytes[10] === 0xff && bytes[11] === 0xff) return embeddedV4(bytes, 12);
	if (first === 0x00 && second === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b) {
		if (allZero(bytes, 4, 12)) return embeddedV4(bytes, 12);
		return false;
	}
	if (first === 0x20 && second === 0x02) return embeddedV4(bytes, 2);
	if ((first & 0xfe) === 0xfc) return false;
	if (first === 0xfe && (second & 0x80) === 0x80) return false;
	if (first === 0xff) return false;
	return true;
}

function embeddedV4(bytes: Uint8Array, at: number): boolean {
	return isPublicV4(bytes[at] as number, bytes[at + 1] as number, bytes[at + 2] as number);
}

function allZero(bytes: Uint8Array, from: number, to: number): boolean {
	for (let n = from; n < to; n++) if (bytes[n] !== 0) return false;
	return true;
}

function refused(url: string, reason: string): Error {
	return new Error(`remote asset refused: ${url}: ${reason}`);
}

function hostAllowed(host: string, rules: AssetRule[]): boolean {
	const name = host.toLowerCase();
	for (const rule of rules) {
		if (typeof rule === "string") {
			const want = rule.toLowerCase();
			if (want.startsWith("*.")) {
				if (name.endsWith(want.slice(1)) && name.length > want.length - 1) return true;
			} else if (name === want) {
				return true;
			}
		} else {
			rule.lastIndex = 0;
			const hit = rule.test(name);
			rule.lastIndex = 0;
			if (hit) return true;
		}
	}
	return false;
}

async function defaultLookup(host: string): Promise<string[]> {
	const found = await dnsLookup(host, { all: true, verbatim: true });
	return found.map((entry) => entry.address);
}

function racing<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) return Promise.reject(signal.reason);
	return new Promise<T>((done, fail) => {
		const onAbort = (): void => fail(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
		work.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				done(value);
			},
			(error) => {
				signal.removeEventListener("abort", onAbort);
				fail(error);
			},
		);
	});
}

async function validateHop(origin: string, target: URL, policy: RemotePolicy, signal: AbortSignal): Promise<void> {
	const loopbackAllowed = policy.allowLoopbackHttp === true;
	if (target.protocol !== "https:" && !(target.protocol === "http:" && loopbackAllowed)) {
		throw refused(origin, `${target.protocol} is not allowed (${target.href})`);
	}
	if (target.username !== "" || target.password !== "") throw refused(origin, "credentials in the URL are not allowed");
	let host = target.hostname;
	if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
	if (host === "") throw refused(origin, "no host");
	if (policy.hosts !== undefined && !hostAllowed(host, policy.hosts)) throw refused(origin, `host ${host} is not in remote.hosts`);
	let addresses: string[];
	if (isIP(host) !== 0) {
		addresses = [host];
	} else {
		try {
			addresses = await racing((policy.lookup ?? defaultLookup)(host), signal);
		} catch (error) {
			if (signal.aborted) throw error;
			throw refused(origin, `could not resolve ${host}`);
		}
	}
	if (!Array.isArray(addresses) || addresses.length === 0) throw refused(origin, `could not resolve ${host}`);
	const loopback = loopbackAllowed && addresses.every(isLoopbackAddress);
	if (target.protocol === "http:" && !loopback) throw refused(origin, `http: is only allowed for loopback (${target.href})`);
	if (loopback) return;
	if (target.port !== "") throw refused(origin, `port ${target.port} is not allowed (${target.href})`);
	if (policy.allowPrivate === true) return;
	for (const address of addresses) {
		if (!isPublicAddress(address)) throw refused(origin, `${host} resolves to a non-public address ${address}`);
	}
}

function parseUrl(origin: string, text: string, base?: URL): URL {
	let parsed: URL;
	try {
		parsed = new URL(text, base);
	} catch {
		throw refused(origin, `not a URL (${text})`);
	}
	parsed.hash = "";
	return parsed;
}

function essence(header: string | null): string {
	if (header === null) return "";
	const cut = header.indexOf(";");
	return (cut < 0 ? header : header.slice(0, cut)).trim().toLowerCase();
}

function sha384Of(body: Uint8Array | string): string {
	return new Bun.CryptoHasher("sha384").update(body).digest("base64");
}

async function readCapped(origin: string, response: Response, maxBytes: number, signal: AbortSignal): Promise<Uint8Array> {
	if (response.body === null) return new Uint8Array(0);
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await racing(reader.read(), signal);
		if (done) break;
		total += value.byteLength;
		if (total > maxBytes) {
			await reader.cancel().catch(() => undefined);
			throw refused(origin, `body is larger than ${maxBytes} bytes`);
		}
		chunks.push(value);
	}
	const body = new Uint8Array(total);
	let at = 0;
	for (const chunk of chunks) {
		body.set(chunk, at);
		at += chunk.byteLength;
	}
	return body;
}

export async function fetchRemote(url: string, kind: RemoteKind, policy: RemotePolicy): Promise<RemoteFetched> {
	const allowed = CONTENT_TYPES[kind];
	if (allowed === undefined) throw refused(url, `unknown kind ${String(kind)}`);
	const maxBytes = policy.maxBytes ?? DEFAULT_MAX_BYTES;
	const timeoutMs = policy.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const maxRedirects = policy.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
	const signal = AbortSignal.timeout(timeoutMs);
	let current = parseUrl(url, url);
	try {
		for (let hop = 0; ; hop++) {
			await validateHop(url, current, policy, signal);
			const response = await fetch(current.href, {
				redirect: "manual",
				credentials: "omit",
				signal,
				headers: { accept: ACCEPT[kind] },
			});
			if (REDIRECTS.has(response.status)) {
				const location = response.headers.get("location");
				await response.body?.cancel().catch(() => undefined);
				if (location === null || location === "") throw refused(url, `redirect without a location (${current.href})`);
				if (hop >= maxRedirects) throw refused(url, `more than ${maxRedirects} redirects`);
				current = parseUrl(url, location, current);
				continue;
			}
			if (response.status !== 200) {
				await response.body?.cancel().catch(() => undefined);
				throw refused(url, `status ${response.status} (${current.href})`);
			}
			const type = essence(response.headers.get("content-type"));
			if (!allowed.includes(type)) {
				await response.body?.cancel().catch(() => undefined);
				throw refused(url, `content type ${type === "" ? "(none)" : type} is not allowed for a ${kind}`);
			}
			const declared = Number(response.headers.get("content-length"));
			if (Number.isFinite(declared) && declared > maxBytes) {
				await response.body?.cancel().catch(() => undefined);
				throw refused(url, `body is larger than ${maxBytes} bytes`);
			}
			const body = await readCapped(url, response, maxBytes, signal);
			return { url, finalUrl: current.href, body, type, sha384: sha384Of(body) };
		}
	} catch (error) {
		if (error instanceof Error && error.message.startsWith("remote asset refused: ")) throw error;
		if (signal.aborted) throw refused(url, `timed out after ${timeoutMs} ms`);
		throw refused(url, error instanceof Error ? error.message : String(error));
	}
}

function isPin(value: unknown): value is RemotePin {
	if (typeof value !== "object" || value === null) return false;
	const pin = value as Record<string, unknown>;
	return (
		typeof pin.sha384 === "string" &&
		SHA384.test(pin.sha384) &&
		typeof pin.size === "number" &&
		Number.isInteger(pin.size) &&
		pin.size >= 0 &&
		typeof pin.type === "string" &&
		typeof pin.pinned === "string"
	);
}

export async function readLock(path: string): Promise<RemoteLock> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, pins: {} };
		throw new Error(`remote lockfile unreadable: ${path}`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new Error(`remote lockfile is not JSON: ${path}`);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error(`remote lockfile has the wrong shape: ${path}`);
	const raw = parsed as Record<string, unknown>;
	if (raw.version !== 1) throw new Error(`remote lockfile has an unknown version: ${path}`);
	if (typeof raw.pins !== "object" || raw.pins === null || Array.isArray(raw.pins)) throw new Error(`remote lockfile has the wrong shape: ${path}`);
	const pins: Record<string, RemotePin> = {};
	for (const url of Object.keys(raw.pins).sort()) {
		const pin = (raw.pins as Record<string, unknown>)[url];
		if (url === "__proto__" || !isPin(pin)) throw new Error(`remote lockfile has a bad pin for ${url}: ${path}`);
		pins[url] = { sha384: pin.sha384, size: pin.size, type: pin.type, pinned: pin.pinned };
	}
	return { version: 1, pins };
}

export async function writeLock(path: string, lock: RemoteLock): Promise<void> {
	const pins: Record<string, RemotePin> = {};
	for (const url of Object.keys(lock.pins).sort()) {
		const pin = lock.pins[url] as RemotePin;
		if (url === "__proto__" || !isPin(pin)) throw new Error(`remote lockfile has a bad pin for ${url}: ${path}`);
		pins[url] = { sha384: pin.sha384, size: pin.size, type: pin.type, pinned: pin.pinned };
	}
	const text = `${JSON.stringify({ version: 1, pins }, null, 2)}\n`;
	await mkdir(dirname(path), { recursive: true });
	await writeAtomic(path, text, 0o644);
}

async function writeAtomic(path: string, body: string | Uint8Array, mode: number): Promise<void> {
	const tmp = `${path}.${process.pid}.${++writeCount}.tmp`;
	try {
		await writeFile(tmp, body, { mode });
		await rename(tmp, path);
	} catch (error) {
		await rm(tmp, { force: true }).catch(() => undefined);
		throw error;
	}
}

function hexOf(sha384: string): string {
	return Buffer.from(sha384, "base64").toString("hex");
}

interface CachedBody {
	body: Uint8Array;
	finalUrl: string;
}

async function readCache(cacheDir: string, url: string, pin: RemotePin): Promise<CachedBody | undefined> {
	const file = join(cacheDir, hexOf(pin.sha384));
	let body: Uint8Array;
	let finalUrl: unknown;
	try {
		body = new Uint8Array(await readFile(file));
		const meta = JSON.parse(await readFile(`${file}.json`, "utf8")) as { urls?: Record<string, unknown> };
		finalUrl = typeof meta === "object" && meta !== null && typeof meta.urls === "object" && meta.urls !== null && Object.hasOwn(meta.urls, url) ? meta.urls[url] : undefined;
	} catch {
		return undefined;
	}
	if (typeof finalUrl !== "string" || !/^https?:\/\//.test(finalUrl) || !URL.canParse(finalUrl)) return undefined;
	if (body.byteLength !== pin.size || sha384Of(body) !== pin.sha384) return undefined;
	return { body, finalUrl };
}

async function writeCache(cacheDir: string, got: RemoteFetched): Promise<void> {
	await mkdir(cacheDir, { recursive: true, mode: 0o700 });
	await chmod(cacheDir, 0o700).catch(() => undefined);
	const file = join(cacheDir, hexOf(got.sha384));
	const urls: Record<string, string> = {};
	try {
		const meta = JSON.parse(await readFile(`${file}.json`, "utf8")) as { urls?: Record<string, unknown> };
		if (typeof meta === "object" && meta !== null && typeof meta.urls === "object" && meta.urls !== null) {
			for (const key of Object.keys(meta.urls)) {
				const value = meta.urls[key];
				if (key !== "__proto__" && typeof value === "string") urls[key] = value;
			}
		}
	} catch {}
	urls[got.url] = got.finalUrl;
	const sorted: Record<string, string> = {};
	for (const key of Object.keys(urls).sort()) sorted[key] = urls[key] as string;
	await writeAtomic(file, got.body, 0o600);
	await writeAtomic(`${file}.json`, `${JSON.stringify({ urls: sorted }, null, 2)}\n`, 0o600);
}

const INTEGRITY_ALGORITHMS = ["sha256", "sha384", "sha512"] as const;

function integrityHolds(integrity: string, body: Uint8Array): boolean {
	let strongest = -1;
	let wanted: string[] = [];
	for (const token of integrity.split(/\s+/)) {
		const dash = token.indexOf("-");
		if (dash < 0) continue;
		const rank = INTEGRITY_ALGORITHMS.indexOf(token.slice(0, dash).toLowerCase() as (typeof INTEGRITY_ALGORITHMS)[number]);
		if (rank < 0) continue;
		const mark = token.indexOf("?", dash);
		const digest = token.slice(dash + 1, mark < 0 ? undefined : mark);
		if (rank > strongest) {
			strongest = rank;
			wanted = [digest];
		} else if (rank === strongest) {
			wanted.push(digest);
		}
	}
	if (strongest < 0) return true;
	const algorithm = INTEGRITY_ALGORITHMS[strongest] as (typeof INTEGRITY_ALGORITHMS)[number];
	const actual = new Bun.CryptoHasher(algorithm).update(body).digest("base64");
	const plain = actual.replace(/=+$/, "");
	return wanted.some((digest) => digest.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "") === plain);
}

function withoutSourceMap(text: string): string {
	const trimmed = text.trimEnd();
	if (trimmed.endsWith("*/")) {
		const open = trimmed.lastIndexOf("/*");
		if (open >= 0 && /^\/\*[#@]\s*sourceMappingURL=/.test(trimmed.slice(open, open + 64))) {
			const head = trimmed.slice(0, open).trimEnd();
			return head === "" ? "" : `${head}\n`;
		}
		return text;
	}
	const line = Math.max(trimmed.lastIndexOf("\n"), trimmed.lastIndexOf("\r")) + 1;
	if (/^[ \t]*\/\/[#@]\s*sourceMappingURL=/.test(trimmed.slice(line, line + 256))) {
		const head = trimmed.slice(0, line).trimEnd();
		return head === "" ? "" : `${head}\n`;
	}
	return text;
}

function absoluteCss(css: string, finalUrl: string): string {
	return rewriteCssUrls(css, {
		resolve: (target) => {
			if (target.startsWith("#") || /^data:/i.test(target)) return undefined;
			let made: URL;
			try {
				made = new URL(target, finalUrl);
			} catch {
				return undefined;
			}
			if (made.protocol !== "https:" && made.protocol !== "http:") return undefined;
			return made.href;
		},
	});
}

function slugOf(url: string): string {
	let host = "";
	let stem = "";
	try {
		const parsed = new URL(url);
		host = parsed.hostname;
		const path = parsed.pathname;
		const base = path.slice(path.lastIndexOf("/") + 1);
		const dot = base.lastIndexOf(".");
		stem = dot > 0 ? base.slice(0, dot) : base;
	} catch {}
	const slug = `${host}-${stem}`
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 60)
		.replace(/-+$/, "");
	return slug === "" ? "remote" : slug;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export async function resolveRemote(refs: RemoteRef[], policy: RemotePolicy & { outDir: string; cwd?: string }): Promise<RemoteResult> {
	const cwd = policy.cwd ?? process.cwd();
	const lockPath = resolve(cwd, policy.lockfile ?? DEFAULT_LOCKFILE);
	const cacheDir = policy.cacheDir === undefined ? join(resolve(cwd, policy.outDir), ".remote") : resolve(cwd, policy.cacheDir);
	const pinning = policy.pin === true;
	const now = (policy.now?.() ?? new Date()).toISOString();
	const lock = await readLock(lockPath);
	const pins: Record<string, RemotePin> = { ...lock.pins };
	const ordered = [...refs].sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
	const bodies = new Map<string, { body: Uint8Array; finalUrl: string; sha384: string; fromCache: boolean } | { error: string }>();
	const failures: string[] = [];
	const pinned = new Set<string>();
	const assets: RemoteAsset[] = [];
	let fetched = 0;

	for (const ref of ordered) {
		const served = SERVED[ref.kind];
		if (served === undefined) {
			failures.push(`remote asset refused: ${ref.url}: unknown kind ${String(ref.kind)}`);
			continue;
		}
		let held = bodies.get(ref.url);
		if (held === undefined) {
			const pin = Object.hasOwn(pins, ref.url) ? pins[ref.url] : undefined;
			const cached = pin !== undefined && !pinning ? await readCache(cacheDir, ref.url, pin) : undefined;
			if (cached !== undefined && pin !== undefined) {
				held = { body: cached.body, finalUrl: cached.finalUrl, sha384: pin.sha384, fromCache: true };
			} else {
				try {
					const got = await fetchRemote(ref.url, ref.kind, policy);
					fetched++;
					if (pin !== undefined && pin.sha384 !== got.sha384 && !pinning) {
						held = { error: `remote asset changed: ${ref.url} pinned sha384-${pin.sha384} got sha384-${got.sha384}; run the pin command to accept` };
					} else if (pin === undefined && !pinning) {
						held = { error: `remote asset not pinned: ${ref.url}` };
					} else if (ref.integrity !== undefined && !integrityHolds(ref.integrity, got.body)) {
						held = { error: `remote asset integrity mismatch: ${ref.url} tag ${ref.integrity} got sha384-${got.sha384}` };
					} else {
						if (pin === undefined || pin.sha384 !== got.sha384) {
							pins[ref.url] = { sha384: got.sha384, size: got.body.byteLength, type: got.type, pinned: now };
							pinned.add(ref.url);
						}
						await writeCache(cacheDir, got);
						held = { body: got.body, finalUrl: got.finalUrl, sha384: got.sha384, fromCache: false };
					}
				} catch (error) {
					held = { error: messageOf(error) };
				}
			}
			bodies.set(ref.url, held);
			if ("error" in held) failures.push(held.error);
		}
		if ("error" in held) continue;
		const pin = pins[ref.url] as RemotePin;
		if (!CONTENT_TYPES[ref.kind].includes(pin.type)) {
			failures.push(`remote asset refused: ${ref.url}: content type ${pin.type} is not allowed for a ${ref.kind}`);
			continue;
		}
		if (ref.integrity !== undefined && !integrityHolds(ref.integrity, held.body)) {
			failures.push(`remote asset integrity mismatch: ${ref.url} tag ${ref.integrity} got sha384-${held.sha384}`);
			continue;
		}
		let body = withoutSourceMap(new TextDecoder("utf-8").decode(held.body));
		if (ref.kind === "style") body = absoluteCss(body, held.finalUrl);
		assets.push({
			ref: ref.ref,
			url: ref.url,
			kind: ref.kind,
			file: hashedName(`r-${slugOf(ref.url)}`, body, served.extension),
			body,
			type: served.type,
			sha384: held.sha384,
			integrity: `sha384-${sha384Of(body)}`,
			fromCache: held.fromCache,
		});
	}

	if (failures.length > 0) throw new Error([...new Set(failures)].join("\n"));
	const sorted: Record<string, RemotePin> = {};
	for (const url of Object.keys(pins).sort()) sorted[url] = pins[url] as RemotePin;
	const next: RemoteLock = { version: 1, pins: sorted };
	if (pinned.size > 0) await writeLock(lockPath, next);
	return { assets, lock: next, pinned: [...pinned].sort(), fetched };
}

function isTagSpace(code: number): boolean {
	return code === 32 || code === 9 || code === 10 || code === 13 || code === 12;
}

export function withoutIntegrity(tag: string): string {
	if (tag.charCodeAt(0) !== 60) return tag;
	const length = tag.length;
	let i = 1;
	while (i < length) {
		const code = tag.charCodeAt(i);
		if (isTagSpace(code) || code === 62 || code === 47) break;
		i++;
	}
	let out = "";
	let copied = 0;
	while (i < length) {
		const gap = i;
		while (i < length && isTagSpace(tag.charCodeAt(i))) i++;
		if (i >= length) break;
		const code = tag.charCodeAt(i);
		if (code === 62) break;
		if (code === 47 || code === 61) {
			i++;
			continue;
		}
		const nameStart = i;
		while (i < length) {
			const c = tag.charCodeAt(i);
			if (isTagSpace(c) || c === 61 || c === 62 || c === 47) break;
			i++;
		}
		const name = tag.slice(nameStart, i).toLowerCase();
		let at = i;
		while (at < length && isTagSpace(tag.charCodeAt(at))) at++;
		if (tag.charCodeAt(at) === 61) {
			at++;
			while (at < length && isTagSpace(tag.charCodeAt(at))) at++;
			const quote = tag.charCodeAt(at);
			if (quote === 34 || quote === 39) {
				const close = tag.indexOf(tag[at] as string, at + 1);
				if (close < 0) break;
				at = close + 1;
			} else {
				while (at < length) {
					const c = tag.charCodeAt(at);
					if (isTagSpace(c) || c === 62) break;
					at++;
				}
			}
			i = at;
		}
		if (name === "integrity" || name === "crossorigin") {
			out += tag.slice(copied, gap);
			copied = i;
		}
	}
	if (copied === 0) return tag;
	return out + tag.slice(copied);
}
