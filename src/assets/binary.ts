import { posix } from "node:path";
import type { AssetBody, CssUrlOptions, MediaType } from "./contract.ts";

const TEXT = (type: string): MediaType => ({ type, binary: false, compress: true });
const PACKED = (type: string): MediaType => ({ type, binary: true, compress: false });
const LOOSE = (type: string): MediaType => ({ type, binary: true, compress: true });

const MEDIA_TYPES: ReadonlyMap<string, MediaType> = new Map([
	[".css", TEXT("text/css; charset=utf-8")],
	[".js", TEXT("text/javascript; charset=utf-8")],
	[".mjs", TEXT("text/javascript; charset=utf-8")],
	[".json", TEXT("application/json; charset=utf-8")],
	[".map", TEXT("application/json; charset=utf-8")],
	[".svg", TEXT("image/svg+xml")],
	[".txt", TEXT("text/plain; charset=utf-8")],
	[".webmanifest", TEXT("application/manifest+json")],
	[".woff2", PACKED("font/woff2")],
	[".woff", PACKED("font/woff")],
	[".ttf", LOOSE("font/ttf")],
	[".otf", LOOSE("font/otf")],
	[".png", PACKED("image/png")],
	[".jpg", PACKED("image/jpeg")],
	[".jpeg", PACKED("image/jpeg")],
	[".gif", PACKED("image/gif")],
	[".webp", PACKED("image/webp")],
	[".avif", PACKED("image/avif")],
	[".ico", LOOSE("image/x-icon")],
	[".mp3", PACKED("audio/mpeg")],
	[".ogg", PACKED("audio/ogg")],
	[".wasm", LOOSE("application/wasm")],
]);

export function mediaType(file: string): MediaType | undefined {
	const slash = Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\"));
	const base = file.slice(slash + 1);
	const dot = base.lastIndexOf(".");
	if (dot < 0) return undefined;
	const found = MEDIA_TYPES.get(base.slice(dot).toLowerCase());
	return found === undefined ? undefined : { ...found };
}

export function contentHash(body: AssetBody): string {
	return new Bun.CryptoHasher("sha256").update(body).digest("hex").slice(0, 10);
}

export function hashedName(name: string, body: AssetBody, extension: string): string {
	const ext = extension === "" || extension.startsWith(".") ? extension : `.${extension}`;
	return `${name}.${contentHash(body)}${ext}`;
}

const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

export function rewriteCssUrls(css: string, options: CssUrlOptions): string {
	const length = css.length;
	let out = "";
	let copied = 0;
	let i = 0;

	const replace = (start: number, end: number, raw: string, quote: string): void => {
		const next = resolveTarget(unescapeCss(raw), options);
		if (next === undefined) return;
		out += css.slice(copied, start) + escapeTarget(next, quote);
		copied = end;
	};

	const skipSpace = (from: number): number => {
		let at = from;
		while (at < length) {
			const code = css.charCodeAt(at);
			if (code === 32 || code === 9 || code === 10 || code === 13 || code === 12) at++;
			else break;
		}
		return at;
	};

	const stringEnd = (from: number): number => {
		const quote = css.charCodeAt(from);
		let at = from + 1;
		while (at < length) {
			const code = css.charCodeAt(at);
			if (code === 92) {
				at += 2;
				continue;
			}
			if (code === quote) return at;
			if (code === 10) return -1;
			at++;
		}
		return -1;
	};

	while (i < length) {
		const code = css.charCodeAt(i);
		if (code === 47 && css.charCodeAt(i + 1) === 42) {
			const end = css.indexOf("*/", i + 2);
			if (end < 0) break;
			i = end + 2;
			continue;
		}
		if (code === 34 || code === 39) {
			const end = stringEnd(i);
			i = end < 0 ? i + 1 : end + 1;
			continue;
		}
		if (code === 64 && isWordAt(css, i + 1, "import") && !isIdentCode(css.charCodeAt(i + 7))) {
			const at = skipSpace(i + 7);
			const first = css.charCodeAt(at);
			if (first === 34 || first === 39) {
				const end = stringEnd(at);
				if (end < 0) {
					i = at + 1;
					continue;
				}
				replace(at + 1, end, css.slice(at + 1, end), css[at] as string);
				i = end + 1;
				continue;
			}
			i = at;
			continue;
		}
		if ((code === 117 || code === 85) && isWordAt(css, i, "url(") && (i === 0 || !isIdentCode(css.charCodeAt(i - 1)))) {
			const at = skipSpace(i + 4);
			const first = css.charCodeAt(at);
			if (first === 34 || first === 39) {
				const end = stringEnd(at);
				if (end < 0) {
					i = at + 1;
					continue;
				}
				const close = skipSpace(end + 1);
				if (css.charCodeAt(close) === 41) replace(at + 1, end, css.slice(at + 1, end), css[at] as string);
				i = end + 1;
				continue;
			}
			let end = at;
			let bad = false;
			while (end < length) {
				const c = css.charCodeAt(end);
				if (c === 41) break;
				if (c === 92) {
					end += 2;
					continue;
				}
				if (c === 34 || c === 39 || c === 40) {
					bad = true;
					break;
				}
				end++;
			}
			if (bad || end >= length) {
				i = at + 1;
				continue;
			}
			let stop = end;
			while (stop > at && isSpaceCode(css.charCodeAt(stop - 1))) stop--;
			if (stop > at) replace(at, stop, css.slice(at, stop), "");
			i = end + 1;
			continue;
		}
		i++;
	}
	if (copied === 0) return css;
	return out + css.slice(copied);
}

function resolveTarget(target: string, options: CssUrlOptions): string | undefined {
	if (target === "") return undefined;
	if (target.startsWith("#") || target.startsWith("//") || SCHEME.test(target)) return options.resolve(target);
	const cut = firstOf(target, "?", "#");
	let path = cut < 0 ? target : target.slice(0, cut);
	const tail = cut < 0 ? "" : target.slice(cut);
	if (path === "") return undefined;
	if (options.base !== undefined && !path.startsWith("/")) path = againstBase(path, options.base);
	const next = options.resolve(path);
	return next === undefined ? undefined : next + tail;
}

function againstBase(path: string, base: string): string {
	if (SCHEME.test(base) || base.startsWith("//")) {
		try {
			return new URL(path, base.startsWith("//") ? `https:${base}` : base).href;
		} catch {
			return path;
		}
	}
	const cut = firstOf(base, "?", "#");
	const clean = cut < 0 ? base : base.slice(0, cut);
	const dir = clean.endsWith("/") ? clean : posix.dirname(clean);
	return posix.normalize(posix.join(dir, path));
}

function firstOf(text: string, a: string, b: string): number {
	const x = text.indexOf(a);
	const y = text.indexOf(b);
	if (x < 0) return y;
	if (y < 0) return x;
	return Math.min(x, y);
}

function isWordAt(text: string, at: number, word: string): boolean {
	if (at + word.length > text.length) return false;
	for (let n = 0; n < word.length; n++) {
		const code = text.charCodeAt(at + n);
		const want = word.charCodeAt(n);
		if (code !== want && !(code >= 65 && code <= 90 && code + 32 === want)) return false;
	}
	return true;
}

function isIdentCode(code: number): boolean {
	return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 45 || code === 95 || code > 127;
}

function isSpaceCode(code: number): boolean {
	return code === 32 || code === 9 || code === 10 || code === 13 || code === 12;
}

function isHexCode(code: number): boolean {
	return (code >= 48 && code <= 57) || (code >= 65 && code <= 70) || (code >= 97 && code <= 102);
}

function unescapeCss(raw: string): string {
	if (!raw.includes("\\")) return raw;
	let out = "";
	let i = 0;
	while (i < raw.length) {
		const code = raw.charCodeAt(i);
		if (code !== 92) {
			out += raw[i];
			i++;
			continue;
		}
		i++;
		if (i >= raw.length) break;
		let end = i;
		while (end < raw.length && end - i < 6 && isHexCode(raw.charCodeAt(end))) end++;
		if (end > i) {
			const point = Number.parseInt(raw.slice(i, end), 16);
			out += point === 0 || point > 0x10ffff ? "�" : String.fromCodePoint(point);
			i = end;
			if (i < raw.length && isSpaceCode(raw.charCodeAt(i))) i++;
			continue;
		}
		if (raw.charCodeAt(i) === 10) {
			i++;
			continue;
		}
		out += raw[i];
		i++;
	}
	return out;
}

function escapeTarget(value: string, quote: string): string {
	let out = "";
	for (let i = 0; i < value.length; i++) {
		const ch = value[i] as string;
		const code = value.charCodeAt(i);
		if (code === 10 || code === 13 || code === 12) {
			out += `\\${code.toString(16)} `;
			continue;
		}
		if (ch === "\\") {
			out += "\\\\";
			continue;
		}
		if (quote !== "") {
			out += ch === quote ? `\\${ch}` : ch;
			continue;
		}
		if (ch === " " || ch === "\t" || ch === "(" || ch === ")" || ch === '"' || ch === "'") out += `\\${ch}`;
		else out += ch;
	}
	return out;
}
