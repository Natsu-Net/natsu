/// <reference lib="dom" />
import type { NatsuClient, NatsuOfflineDetail } from "./types.ts";

const D = document;
const me = D.currentScript as HTMLScriptElement | null;
const data = me?.dataset ?? {};
const SW = navigator.serviceWorker;

let cached = new Set<string>();
const bare = (url: string) => url.split("#")[0]!;
const learn = () =>
	"caches" in window &&
	caches
		.keys()
		.then((names) => Promise.all(names.filter((n) => n.startsWith("natsu-")).map((n) => caches.open(n).then((c) => c.keys()))))
		.then((lists) => (cached = new Set(lists.flat().map((r) => bare(r.url)))))
		.catch(() => {});

try {
	const css = new CSSStyleSheet();
	css.replaceSync(
		"@layer natsu{natsu-offline,natsu-toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:999999;display:flex;gap:12px;align-items:center;max-width:calc(100vw - 32px);box-sizing:border-box;padding:12px 16px;border-radius:12px;background:var(--natsu-pwa-bg,#18181c);color:var(--natsu-pwa-fg,#fafafa);border:1px solid var(--natsu-pwa-line,#2a2a31);box-shadow:0 10px 30px #0006;font:14px/1.4 system-ui,sans-serif}natsu-offline button,natsu-toast button{font:inherit;border:0;border-radius:8px;padding:6px 12px;background:var(--natsu-pwa-accent,#5088ff);color:#fff;cursor:pointer}[hidden]:is(natsu-offline,natsu-toast){display:none}}",
	);
	D.adoptedStyleSheets = [...D.adoptedStyleSheets, css];
} catch {}

const box = (tag: string, role: string, text: string, label: string, act: () => void) => {
	const el = D.createElement(tag);
	el.setAttribute("role", role);
	el.hidden = true;
	const p = D.createElement("span");
	p.textContent = text;
	const b = D.createElement("button");
	b.type = "button";
	b.textContent = label;
	b.onclick = act;
	el.append(p, b);
	return el;
};

let again: string | undefined;
const offline = box("natsu-offline", "alertdialog", data.offline || "", data.retry || "", () => {
	offline.hidden = true;
	const url = again;
	again = undefined;
	url && (window.natsu as NatsuClient | undefined)?.visit(url);
});
offline.setAttribute("aria-live", "assertive");

let waiting: ServiceWorker | null = null;
let chose = false;
const toast = box("natsu-toast", "status", data.update || "", data.reload || "", () => {
	chose = true;
	toast.hidden = true;
	waiting ? waiting.postMessage("natsu:skip-waiting") : location.reload();
});

const attach = () => {
	D.body.append(offline, toast);
	learn();
};
D.body ? attach() : D.addEventListener("DOMContentLoaded", attach);

D.addEventListener("natsu:load", () => {
	learn();
});

D.addEventListener("natsu:offline", (e) => {
	const detail = (e as CustomEvent<NatsuOfflineDetail>).detail;
	if (!detail.post && cached.has(bare(detail.url))) return;
	e.preventDefault();
	again = detail.post ? undefined : detail.url;
	offline.hidden = false;
	(offline.querySelector("button") as HTMLButtonElement).focus({ preventScroll: true });
});

addEventListener("online", () => {
	offline.hidden = true;
});

if (SW && data.sw) {
	const offer = (w: ServiceWorker | null) => {
		if (!w || !SW.controller) return;
		waiting = w;
		toast.hidden = false;
	};
	SW.register(data.sw, { scope: "/" })
		.then((reg) => {
			offer(reg.waiting);
			reg.addEventListener("updatefound", () => {
				const w = reg.installing;
				w?.addEventListener("statechange", () => w.state == "installed" && offer(w));
			});
		})
		.catch(() => {});
	SW.addEventListener("controllerchange", () => chose && location.reload());
}
