/**
 * A small natsu app for the mount browser suite (`tests/mount.e2e.ts`):
 * `Assets` with `"families"` chunking over two stylesheets (base styles and
 * an editor area), navigation on, a module entry that mounts the editor with
 * `client/mount` on `[data-editor]`, and a CSP with a fresh script nonce and
 * `style-src 'self'` on every page.
 *
 *  - `/with`: the page has the editor's element, so the server links the
 *    editor family.
 *  - `/plain`: it has not; its button adds one from a script.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Application, Assets, Router, navigable, resetConfig, setConfig } from "../../../index.ts";
import type { Context } from "../../../index.ts";

const HERE = import.meta.dir;

export interface MountApp {
	assets: Assets;
	start(port: number): Promise<string>;
	stop(): Promise<void>;
}

export async function mountApp(): Promise<MountApp> {
	resetConfig();
	setConfig({ General: { logFormat: "", logLevel: "silent", development: false }, Session: { driver: "memory", sweepInterval: 0 }, Static: { enabled: false } });
	Router.clear();
	const outDir = mkdtempSync(join(tmpdir(), "natsu-mount-e2e-"));
	const assets = new Assets({
		outDir,
		minify: true,
		styles: { site: [join(HERE, "css/base.css"), join(HERE, "css/editor.css")] },
		scripts: { app: join(HERE, "js/app.ts") },
		rewrite: { "/assets/site.css": "site", "/assets/js/app.js": "app" },
		chunking: { mode: "families", minBytes: 0 },
		navigate: true,
	});
	await assets.build();

	const page = (ctx: Context, title: string, main: string): string => {
		const nonce = crypto.randomUUID().replaceAll("-", "");
		ctx.response.headers.set("content-security-policy", `default-src 'self'; script-src 'nonce-${nonce}' 'strict-dynamic'; style-src 'self'; object-src 'none'; base-uri 'none'`);
		ctx.response.headers.set("content-type", "text/html; charset=utf-8");
		return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title><link rel="stylesheet" href="/assets/site.css">` +
			`<script type="module" src="/assets/js/app.js" nonce="${nonce}"></script></head>` +
			`<body><header class="card"><a href="/plain">Plain</a> <a href="/with">With</a></header><main id="main" data-natsu-region>${main}</main></body></html>`;
	};
	const routes = new Router();
	routes.get("/plain", navigable((ctx: Context) => page(ctx, "Plain", '<h1 class="muted">Plain</h1><button type="button" data-add>Add an editor</button>')));
	routes.get("/with", navigable((ctx: Context) => page(ctx, "With", '<h1>With</h1><div id="editor" data-editor></div>')));

	const app = new Application({ sessions: false });
	app.use(assets.middleware());
	return {
		assets,
		async start(port) {
			const server = await app.start({ port, hostname: "127.0.0.1", quiet: true });
			return server.url.origin;
		},
		async stop() {
			await app.close(true);
			rmSync(outDir, { recursive: true, force: true });
		},
	};
}
