import type { Context } from "./context.ts";

export const PWA_ENTRY = "natsu-pwa";
export const MANIFEST_PATH = "/manifest.webmanifest";
export const WORKER_PATH = "/sw.js";

export interface PwaIcon {
	src: string;
	sizes: string;
	type?: string;
	purpose?: string;
}

export interface PwaManifest {
	name: string;
	short_name?: string;
	description?: string;
	id?: string;
	start_url?: string;
	scope?: string;
	display?: "standalone" | "fullscreen" | "minimal-ui" | "browser";
	theme_color?: string;
	background_color?: string;
	lang?: string;
	icons: PwaIcon[];
	[field: string]: unknown;
}

export interface PwaText {
	offline?: string;
	retry?: string;
	update?: string;
	reload?: string;
}

export interface PwaOptions {
	manifest: PwaManifest;
	offline?: Array<string | RegExp>;
	offlineWhen?: (ctx: Context) => boolean;
	cache?: string[];
	text?: PwaText;
}

const TEXT: Required<PwaText> = {
	offline: "This page needs a network connection.",
	retry: "Retry",
	update: "A new version is available.",
	reload: "Reload",
};

const escapeHtml = (text: string) =>
	text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export class Pwa {
	public readonly text: Required<PwaText>;
	private readonly manifestBody: string;
	private readonly prefixes: string[];
	private worker = "";

	constructor(private readonly options: PwaOptions, publicPath: string) {
		this.text = { ...TEXT, ...options.text };
		this.manifestBody = JSON.stringify({
			id: "/",
			start_url: "/",
			scope: "/",
			display: "standalone",
			...options.manifest,
		});
		this.prefixes = [`${publicPath}/`, ...(options.cache ?? [])];
	}

	public headTags(): string {
		const theme = this.options.manifest.theme_color;
		return `<link rel="manifest" href="${MANIFEST_PATH}">${theme ? `<meta name="theme-color" content="${escapeHtml(theme)}">` : ""}`;
	}

	public scriptTag(src: string, nonce: string | undefined): string {
		const t = this.text;
		const data = ` data-sw="${WORKER_PATH}" data-offline="${escapeHtml(t.offline)}" data-retry="${escapeHtml(t.retry)}" data-update="${escapeHtml(t.update)}" data-reload="${escapeHtml(t.reload)}"`;
		return `<script src="${src}"${nonce ? ` nonce="${nonce}"` : ""} defer data-natsu-once${data}></script>`;
	}

	public build(buildId: string, precache: string[]): void {
		this.worker = workerSource(buildId, precache, this.prefixes, offlineDocument(this.options.manifest, this.text));
	}

	public serve(ctx: Context): boolean {
		if (ctx.method !== "GET" && ctx.method !== "HEAD") return false;
		const headers = ctx.response.headers;
		if (ctx.path === MANIFEST_PATH) {
			headers.set("content-type", "application/manifest+json; charset=utf-8");
			headers.set("cache-control", "no-cache");
			ctx.response.body = this.manifestBody;
			return true;
		}
		if (ctx.path === WORKER_PATH && this.worker) {
			headers.set("content-type", "text/javascript; charset=utf-8");
			headers.set("cache-control", "no-cache");
			headers.set("service-worker-allowed", "/");
			ctx.response.body = this.worker;
			return true;
		}
		return false;
	}

	public mark(ctx: Context): void {
		if (ctx.method !== "GET" || ctx.response.status !== 200) return;
		const paths = this.options.offline ?? [];
		if (!paths.some((p) => (typeof p === "string" ? p === ctx.path : p.test(ctx.path)))) return;
		if (this.options.offlineWhen && !this.options.offlineWhen(ctx)) return;
		ctx.response.headers.set("natsu-offline", "1");
	}
}

function offlineDocument(manifest: PwaManifest, text: Required<PwaText>): string {
	const bg = escapeHtml(manifest.background_color ?? "#0b0b0f");
	const fg = escapeHtml(manifest.theme_color ?? "#5088ff");
	return `<!doctype html><html lang="${escapeHtml(manifest.lang ?? "en")}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(manifest.short_name ?? manifest.name)}</title><style>html{color-scheme:dark light}body{margin:0;min-height:100vh;display:grid;place-items:center;background:${bg};color:#e8e8ee;font:16px/1.5 system-ui,sans-serif;text-align:center}main{padding:24px}a{display:inline-block;margin-top:16px;padding:10px 18px;border-radius:10px;background:${fg};color:#fff;text-decoration:none}</style></head><body><main><p>${escapeHtml(text.offline)}</p><a href="">${escapeHtml(text.retry)}</a></main></body></html>`;
}

export function workerSource(buildId: string, precache: string[], prefixes: string[], offline: string): string {
	return `"use strict";
const C="natsu-"+${JSON.stringify(buildId)},P=${JSON.stringify(precache)},I=${JSON.stringify(prefixes)},O=${JSON.stringify(offline)};
self.addEventListener("install",e=>e.waitUntil(caches.open(C).then(c=>Promise.all(P.map(u=>c.add(u).catch(()=>{}))))));
self.addEventListener("activate",e=>e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(n=>n.startsWith("natsu-")&&n!=C).map(n=>caches.delete(n)))).then(()=>self.clients.claim())));
self.addEventListener("message",e=>e.data=="natsu:skip-waiting"&&self.skipWaiting());
self.addEventListener("fetch",e=>{
const r=e.request;
if(r.method!="GET")return;
const u=new URL(r.url);
if(u.origin!=location.origin)return;
if(I.some(p=>u.pathname.startsWith(p)))return e.respondWith(caches.open(C).then(c=>c.match(r).then(m=>m||fetch(r).then(n=>(n.ok&&c.put(r,n.clone()),n)))));
u.hash="";
const k=u.href;
if(r.mode!="navigate"){if(r.headers.get("natsu-nav"))e.respondWith(fetch(r).then(n=>{n.headers.get("natsu-offline")=="1"&&e.waitUntil(fetch(k,{credentials:"same-origin"}).then(f=>f.ok&&f.headers.get("natsu-offline")=="1"&&caches.open(C).then(c=>c.put(k,f))).catch(()=>{}));return n}));return}
e.respondWith(fetch(r).then(n=>{const keep=n.ok&&n.headers.get("natsu-offline")=="1"&&n.clone();e.waitUntil(caches.open(C).then(c=>keep?c.put(k,keep):c.delete(k)));return n},()=>caches.open(C).then(c=>c.match(k)).then(m=>m||new Response(O,{status:503,headers:{"content-type":"text/html; charset=utf-8","cache-control":"no-store"}}))));
});
`;
}
