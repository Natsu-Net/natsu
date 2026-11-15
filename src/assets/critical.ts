import type { CriticalInput, CriticalPass, WarmSignal } from "./contract.ts";

const TAG_START = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)/y;
const SPACE = /[\t\n\f\r ]/;
const SPACES = /[\t\n\f\r ]+/;
const NONCE = /^[A-Za-z0-9+/_=-]+$/;
const TOKEN = /^[\w.-]{1,64}$/;
const UNSAFE_VALUE = /["<>]/;
const UNSAFE_URL = /[\t\n\f\r "'<>&]/;
const CARRIED = new Set(["rel", "href", "media", "type", "nonce", "crossorigin", "data-natsu-families", "fetchpriority", "blocking", "referrerpolicy"]);
const RAW_TEXT: Record<string, RegExp> = { script: /<\/script/gi, style: /<\/style/gi };

interface StartTag {
	end: number;
	attributes: Map<string, string>;
}

function readTag(text: string, from: number): StartTag | undefined {
	const attributes = new Map<string, string>();
	const length = text.length;
	let at = from;
	while (at < length) {
		const char = text[at]!;
		if (char === ">") return { end: at, attributes };
		if (char === "/" || SPACE.test(char)) {
			at++;
			continue;
		}
		const nameStart = at;
		at++;
		while (at < length && text[at] !== "=" && text[at] !== ">" && text[at] !== "/" && !SPACE.test(text[at]!)) at++;
		const name = text.slice(nameStart, at).toLowerCase();
		while (at < length && SPACE.test(text[at]!)) at++;
		let value = "";
		if (text[at] === "=") {
			at++;
			while (at < length && SPACE.test(text[at]!)) at++;
			const quote = text[at];
			if (quote === '"' || quote === "'") {
				const close = text.indexOf(quote, at + 1);
				if (close === -1) return undefined;
				value = text.slice(at + 1, close);
				at = close + 1;
			} else {
				const valueStart = at;
				while (at < length && text[at] !== ">" && !SPACE.test(text[at]!)) at++;
				value = text.slice(valueStart, at);
			}
		}
		if (!attributes.has(name)) attributes.set(name, value);
	}
	return undefined;
}

export function criticalPass(input: CriticalInput): CriticalPass {
	const prefix = `${input.publicPath.replace(/\/+$/, "")}/`;
	const nonce = input.style.nonce;
	const active = input.style.allowed === true && Number.isFinite(input.maxBytes) && input.maxBytes > 0 && (nonce === undefined || NONCE.test(nonce));
	const nonceAttribute = nonce === undefined ? "" : ` nonce="${nonce}"`;
	const inlined: string[] = [];
	let bytes = 0;
	let started = false;
	let done = !active;
	let mode: "comment" | "script" | "style" | undefined;

	const replacement = (attributes: Map<string, string>): string | undefined => {
		for (const name of attributes.keys()) if (!CARRIED.has(name)) return undefined;
		const rel = (attributes.get("rel") ?? "").toLowerCase().split(SPACES).filter(Boolean);
		if (!rel.includes("stylesheet") || rel.includes("alternate")) return undefined;
		const type = attributes.get("type");
		if (type !== undefined && type !== "" && type.trim().toLowerCase() !== "text/css") return undefined;
		const media = attributes.get("media");
		const medium = media?.trim().toLowerCase();
		if (medium !== undefined && medium !== "" && medium !== "all" && medium !== "screen") return undefined;
		const families = attributes.get("data-natsu-families");
		if (families !== undefined && UNSAFE_VALUE.test(families)) return undefined;
		const url = attributes.get("href");
		if (!url || !url.startsWith(prefix) || UNSAFE_URL.test(url) || inlined.includes(url)) return undefined;
		let css: string | undefined;
		try {
			css = input.body(url);
		} catch {
			return undefined;
		}
		if (typeof css !== "string" || /<\/style/i.test(css) || css.includes("<!--")) return undefined;
		const size = Buffer.byteLength(css);
		if (bytes + size > input.maxBytes) return undefined;
		bytes += size;
		inlined.push(url);
		let style = `<style data-natsu-critical="${url}"`;
		if (medium) style += ` media="${medium}"`;
		if (families !== undefined) style += ` data-natsu-families="${families}"`;
		style += `${nonceAttribute}>${css}</style>`;
		if (!input.warm) style += `<link rel="preload" as="style" href="${url}"${nonceAttribute} data-natsu-warm>`;
		return style;
	};

	const apply = (text: string): string => {
		if (done || typeof text !== "string") return text;
		let out = "";
		let copied = 0;
		let at = 0;
		while (at < text.length) {
			if (mode === "comment") {
				const close = text.indexOf("-->", at);
				if (close === -1) break;
				at = close + 3;
				mode = undefined;
				continue;
			}
			if (mode) {
				const closer = RAW_TEXT[mode]!;
				closer.lastIndex = at;
				const close = closer.exec(text);
				if (!close) break;
				at = close.index;
				mode = undefined;
			}
			const open = text.indexOf("<", at);
			if (open === -1) break;
			if (text.startsWith("<!--", open)) {
				mode = "comment";
				at = open + 4;
				continue;
			}
			TAG_START.lastIndex = open;
			const start = TAG_START.exec(text);
			if (!start) {
				at = open + 1;
				continue;
			}
			const closing = start[1] === "/";
			const name = start[2]!.toLowerCase();
			if ((closing && name === "head") || (!closing && name === "body")) {
				done = true;
				break;
			}
			const tag = readTag(text, open + start[0].length);
			if (!tag) break;
			at = tag.end + 1;
			if (closing) continue;
			if (name === "head") started = true;
			else if (name === "script" || name === "style") mode = name;
			else if (name === "link" && started) {
				const inline = replacement(tag.attributes);
				if (inline === undefined) continue;
				out += text.slice(copied, open) + inline;
				copied = at;
			}
		}
		return copied === 0 ? text : out + text.slice(copied);
	};

	return {
		apply,
		get inlined() {
			return inlined;
		},
		get bytes() {
			return bytes;
		},
	};
}

export function warmSignal(cookieHeader: string | null | undefined, name: string, buildId: string, secure: boolean): WarmSignal {
	if (typeof name !== "string" || typeof buildId !== "string" || !TOKEN.test(name) || !TOKEN.test(buildId)) return { warm: true };
	if (cookieHeader) {
		for (const pair of cookieHeader.split(";")) {
			const equals = pair.indexOf("=");
			if (equals === -1 || pair.slice(0, equals).trim() !== name) continue;
			let value = pair.slice(equals + 1).trim();
			if (value.length > 1 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
			if (value === buildId) return { warm: true };
		}
	}
	return { warm: false, setCookie: `${name}=${buildId}; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly${secure ? "; Secure" : ""}` };
}
