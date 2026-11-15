import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import type {
	AssetBody,
	LoadedFile,
	PrebuiltExpect,
	PrebuiltFailure,
	PrebuiltFile,
	PrebuiltInput,
	PrebuiltLoad,
	PrebuiltManifest,
} from "./contract.ts";

const MANIFEST = "natsu-assets.json";
const FILE_NAME = /^[\w.-]+$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_FILES = 5000;
const MAX_BYTES = 256 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024 * 1024;
const TEXT_TYPES = new Set(["application/javascript", "application/json", "image/svg+xml"]);

function compare(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

function bytesOf(body: AssetBody): Uint8Array {
	return typeof body === "string" ? new TextEncoder().encode(body) : body;
}

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function validName(file: unknown): file is string {
	return typeof file === "string" && FILE_NAME.test(file) && file !== "." && file !== "..";
}

function isText(type: string): boolean {
	const semicolon = type.indexOf(";");
	const base = (semicolon === -1 ? type : type.slice(0, semicolon)).trim().toLowerCase();
	return base.startsWith("text/") || TEXT_TYPES.has(base);
}

function canonical(value: unknown, seen: Set<object>): unknown {
	if (value === null) return null;
	if (typeof value === "function") return "fn";
	if (typeof value === "bigint") return `${value}n`;
	if (typeof value === "symbol") return String(value);
	if (typeof value !== "object") return value;
	if (value instanceof RegExp) return `/${value.source}/${value.flags}`;
	if (value instanceof Date) return Number.isNaN(value.getTime()) ? "date" : value.toISOString();
	if (seen.has(value)) return "cycle";
	seen.add(value);
	let out: unknown;
	if (Array.isArray(value)) {
		out = value.map((item) => (item === undefined ? null : canonical(item, seen)));
	} else if (value instanceof Set) {
		out = { set: [...value].map((item) => JSON.stringify(canonical(item, seen)) ?? "null").sort(compare) };
	} else if (value instanceof Map) {
		out = {
			map: [...value]
				.map(([key, item]) => JSON.stringify([canonical(key, seen), canonical(item, seen)]) ?? "null")
				.sort(compare),
		};
	} else if (ArrayBuffer.isView(value)) {
		out = { bytes: sha256(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)) };
	} else {
		const record = value as Record<string, unknown>;
		const result: Record<string, unknown> = {};
		for (const key of Object.keys(record).sort(compare)) {
			if (record[key] === undefined) continue;
			result[key] = canonical(record[key], seen);
		}
		out = result;
	}
	seen.delete(value);
	return out;
}

export function optionsFingerprint(options: unknown): string {
	let subject = options;
	if (options !== null && typeof options === "object" && !Array.isArray(options)) {
		const { prebuilt: _prebuilt, ...rest } = options as Record<string, unknown>;
		const remote = rest.remote;
		if (remote !== null && typeof remote === "object" && !Array.isArray(remote)) {
			const { pin: _pin, ...kept } = remote as Record<string, unknown>;
			rest.remote = kept;
		}
		subject = rest;
	}
	const text = JSON.stringify(canonical(subject, new Set())) ?? "undefined";
	return createHash("sha256").update(text).digest("hex");
}

export async function writePrebuilt(outDir: string, input: PrebuiltInput): Promise<PrebuiltManifest> {
	const seen = new Set<string>();
	const files: PrebuiltFile[] = [];
	for (const file of [...input.files].sort((a, b) => compare(a.file, b.file))) {
		if (!validName(file.file)) throw new Error(`prebuilt: file name ${JSON.stringify(file.file)} cannot be held in the manifest`);
		if (seen.has(file.file)) throw new Error(`prebuilt: file ${file.file} is listed twice`);
		seen.add(file.file);
		const bytes = bytesOf(file.body);
		const entry: PrebuiltFile = { file: file.file, type: file.type, bytes: bytes.byteLength, sha256: sha256(bytes) };
		if (file.br) entry.br = file.br.byteLength;
		if (file.gzip) entry.gzip = file.gzip.byteLength;
		files.push(entry);
	}
	const entries: Record<string, string> = {};
	for (const name of Object.keys(input.entries).sort(compare)) entries[name] = input.entries[name]!;
	const manifest: PrebuiltManifest = {
		version: 1,
		natsu: input.natsu,
		fingerprint: input.fingerprint,
		buildId: input.buildId,
		entries,
		files,
		state: input.state,
	};
	if (input.discovery) manifest.discovery = input.discovery;
	const path = input.manifest ?? join(outDir, MANIFEST);
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
	try {
		await writeFile(temporary, `${JSON.stringify(manifest, null, "\t")}\n`);
		await rename(temporary, path);
	} catch (cause) {
		await rm(temporary, { force: true });
		throw new Error(`prebuilt: cannot write manifest ${path}`, { cause });
	}
	return manifest;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSize(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function stringRecord(value: unknown): boolean {
	return isRecord(value) && Object.values(value).every((item) => typeof item === "string");
}

function discoveryShape(value: unknown): string | undefined {
	if (!isRecord(value)) return "discovery is not an object";
	for (const key of ["scripts", "classicScripts", "files", "rewrite"]) {
		if (!stringRecord(value[key])) return `discovery.${key} is not a record of strings`;
	}
	const styles = value.styles;
	if (!isRecord(styles) || !Object.values(styles).every((list) => Array.isArray(list) && list.every((item) => typeof item === "string"))) {
		return "discovery.styles is not a record of string lists";
	}
	for (const key of ["remote", "refs", "skipped"]) {
		const list = value[key];
		if (!Array.isArray(list) || !list.every((item) => isRecord(item) && typeof item.ref === "string")) {
			return `discovery.${key} is not a list of refs`;
		}
	}
	return undefined;
}

function fileShape(value: unknown, index: number): string | undefined {
	if (!isRecord(value)) return `files[${index}] is not an object`;
	if (typeof value.file !== "string") return `files[${index}].file is not a string`;
	if (typeof value.type !== "string") return `files[${index}].type is not a string`;
	if (!isSize(value.bytes)) return `files[${index}].bytes is not a size`;
	if (typeof value.sha256 !== "string" || !SHA256.test(value.sha256)) return `files[${index}].sha256 is not a sha256`;
	if (value.br !== undefined && !isSize(value.br)) return `files[${index}].br is not a size`;
	if (value.gzip !== undefined && !isSize(value.gzip)) return `files[${index}].gzip is not a size`;
	return undefined;
}

async function directChild(root: string, file: string): Promise<string | undefined> {
	let actual: string;
	try {
		actual = await realpath(join(root, file));
	} catch {
		return undefined;
	}
	const fence = root.endsWith(sep) ? root : root + sep;
	if (!actual.startsWith(fence) || actual.slice(fence.length).includes(sep)) return undefined;
	return actual;
}

async function sibling(
	root: string,
	file: string,
	size: number | undefined,
	body: Uint8Array,
	inflate: (packed: Uint8Array, limit: number) => Uint8Array,
): Promise<Uint8Array | undefined> {
	if (size === undefined || size > MAX_BYTES) return undefined;
	try {
		const actual = await directChild(root, file);
		if (actual === undefined) return undefined;
		const info = await stat(actual);
		if (!info.isFile() || info.size !== size) return undefined;
		const packed = new Uint8Array(await readFile(actual));
		if (packed.byteLength !== size) return undefined;
		const plain = inflate(packed, Math.max(body.byteLength, 1));
		if (plain.byteLength !== body.byteLength || Buffer.compare(plain, body) !== 0) return undefined;
		return packed;
	} catch {
		return undefined;
	}
}

export async function loadPrebuilt(outDir: string, expect: PrebuiltExpect): Promise<PrebuiltLoad> {
	const fail = (reason: PrebuiltFailure, detail: string): PrebuiltLoad => ({ ok: false, reason, detail });
	const path = expect.manifest ?? join(outDir, MANIFEST);
	try {
		let text: string;
		try {
			const info = await stat(path);
			if (!info.isFile()) return fail("unreadable", `${path} is not a file`);
			if (info.size > MAX_MANIFEST_BYTES) return fail("limit", `${path} is ${info.size} bytes, over ${MAX_MANIFEST_BYTES}`);
			text = await readFile(path, "utf8");
		} catch (cause) {
			if ((cause as { code?: string } | null)?.code === "ENOENT") return fail("missing", `${path} does not exist`);
			return fail("unreadable", `${path}: ${cause instanceof Error ? cause.message : String(cause)}`);
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch (cause) {
			return fail("unreadable", `${path} is not JSON: ${cause instanceof Error ? cause.message : String(cause)}`);
		}
		if (!isRecord(parsed)) return fail("unreadable", `${path} does not hold an object`);
		if (parsed.version !== 1) return fail("version", `manifest version ${JSON.stringify(parsed.version)}, expected 1`);
		if (parsed.natsu !== expect.natsu) {
			return fail("version", `built by natsu ${JSON.stringify(parsed.natsu)}, running ${expect.natsu}`);
		}
		if (parsed.fingerprint !== expect.fingerprint) return fail("fingerprint", "asset options changed since the build");
		if (typeof parsed.buildId !== "string") return fail("shape", "buildId is not a string");
		if (!stringRecord(parsed.entries)) return fail("shape", "entries is not a record of strings");
		if (!("state" in parsed) || parsed.state === undefined) return fail("shape", "state is missing");
		if (!Array.isArray(parsed.files)) return fail("shape", "files is not a list");
		if (parsed.discovery !== undefined) {
			const wrong = discoveryShape(parsed.discovery);
			if (wrong) return fail("shape", wrong);
		}
		const maxFiles = expect.maxFiles ?? MAX_FILES;
		const maxBytes = expect.maxBytes ?? MAX_BYTES;
		if (parsed.files.length > maxFiles) return fail("limit", `${parsed.files.length} files, over ${maxFiles}`);
		let total = 0;
		const names = new Set<string>();
		for (let index = 0; index < parsed.files.length; index++) {
			const wrong = fileShape(parsed.files[index], index);
			if (wrong) return fail("shape", wrong);
			const file = parsed.files[index] as PrebuiltFile;
			if (names.has(file.file)) return fail("shape", `file ${JSON.stringify(file.file)} is listed twice`);
			names.add(file.file);
			total += file.bytes;
			if (total > maxBytes) return fail("limit", `files hold more than ${maxBytes} bytes`);
		}
		const manifest = parsed as unknown as PrebuiltManifest;

		let root: string;
		try {
			root = await realpath(outDir);
		} catch {
			return fail("path", `${outDir} does not exist`);
		}
		for (const file of manifest.files) {
			if (!validName(file.file)) return fail("path", `file name ${JSON.stringify(file.file)} is not allowed`);
		}
		const located = new Map<string, string>();
		for (const file of manifest.files) {
			let present = true;
			try {
				await stat(join(root, file.file));
			} catch {
				present = false;
			}
			if (!present) return fail("size", `${file.file} is not on disk`);
			const actual = await directChild(root, file.file);
			if (actual === undefined) return fail("path", `${file.file} does not resolve directly inside ${outDir}`);
			located.set(file.file, actual);
		}
		for (const file of manifest.files) {
			let type: string | undefined;
			try {
				type = expect.typeOf(file.file);
			} catch {
				type = undefined;
			}
			if (type === undefined || type !== file.type) {
				return fail("type", `${file.file} is recorded as ${JSON.stringify(file.type)}, expected ${JSON.stringify(type)}`);
			}
		}
		for (const file of manifest.files) {
			const info = await stat(located.get(file.file)!);
			if (!info.isFile()) return fail("size", `${file.file} is not a regular file`);
			if (info.size !== file.bytes) return fail("size", `${file.file} is ${info.size} bytes, manifest says ${file.bytes}`);
		}
		const files = new Map<string, LoadedFile>();
		for (const file of manifest.files) {
			const bytes = new Uint8Array(await readFile(located.get(file.file)!));
			if (bytes.byteLength !== file.bytes) {
				return fail("size", `${file.file} is ${bytes.byteLength} bytes, manifest says ${file.bytes}`);
			}
			if (sha256(bytes) !== file.sha256) return fail("hash", `${file.file} does not match its recorded sha256`);
			let body: AssetBody = bytes;
			if (isText(file.type)) {
				try {
					body = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
				} catch {
					body = bytes;
				}
			}
			const loaded: LoadedFile = { body, type: file.type };
			const br = await sibling(root, `${file.file}.br`, file.br, bytes, (packed, limit) =>
				brotliDecompressSync(packed, { maxOutputLength: limit }),
			);
			if (br) loaded.br = br;
			const gzip = await sibling(root, `${file.file}.gz`, file.gzip, bytes, (packed, limit) =>
				gunzipSync(packed, { maxOutputLength: limit }),
			);
			if (gzip) loaded.gzip = gzip;
			files.set(file.file, loaded);
		}
		return { ok: true, manifest, files };
	} catch (cause) {
		return fail("unreadable", cause instanceof Error ? cause.message : String(cause));
	}
}
