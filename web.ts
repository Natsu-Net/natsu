/// <reference path="./src/global/_global.d.ts" />
import "./src/global/_global.ts";
import { Oak } from "./src/global/_deps.ts";
import { LibsMiddleWare } from "./src/libs.ts";
import uwu from "./src/templates.ts";
import { SessionMiddleware } from "./src/session/session.ts";
import { CreateWatcherWorker } from "./src/watcher/watcher.ts";
import { path } from "./src/global/_deps.ts";

import { ExtMapping } from "https://deno.land/x/common_mime_types@0.1.1/mod.ts";
import { config } from "./src/global/config.ts";

ExtMapping[".svg"] = ["image/svg+xml"];

// extract Application, send, isHttpError, ErrorStatus from oak
const { Application } = Oak;

// create a function to check if file exists
function exists(path: string): boolean {
	try {
		Deno.statSync(path);
		return true;
	} catch (_e) {
		return false;
	}
}
//const appOptions = hasFlash() ? { serverConstructor: FlashServer } : undefined;

const app = new Application({ proxy: config.General.proxy });
let listenPromise: Promise<void>;

let controller: AbortController;
let signal: AbortSignal;

const logFormat = uwu.compile(config.General.logFormat);

// deno-lint-ignore no-inferrable-types
let firststart: boolean = false;

async function loadServerstuff(dev = false): Promise<void> {
	// Log response time in ms
	app.use(async (ctx, next) => {
		if (ctx.request.url.pathname !== "/favicon.ico" && !ctx.request.url.pathname.startsWith("/assets")) {
			const start: number = Date.now();
			await next();
			const ms: number = Date.now() - start;
			const color: "red" | "yellow" | "green" = ms > 1000 ? "red" : ms > 500 ? "yellow" : "green";
			CLog(logFormat({ ctx, ms, color }))
		} else {
			await next();
		}
	});

	// middle ware for the entire app
	app.use(SessionMiddleware);
	app.use(LibsMiddleWare);

	// serve public folder
	// deno-lint-ignore no-explicit-any
	app.use(async (ctx: any, next: any) => {

		if (exists(`${Deno.cwd()}/public/${ctx.request.url.pathname}`) && ctx.request.url.pathname !== "/") {
			// check if file in cache
			if (Config.Cache.enablePublicCache && ctx.cache.has(ctx.request.url.pathname)) {
				if (Config.Cache.autoUpdatePublicCache) {
					const path = `${Deno.cwd()}/public/${ctx.request.url.pathname}`.replace(/\/\.\.\//g, "/");

					// check if file has changed
					const stat = (await Deno.stat(path)) as Deno.FileInfo;
					if (stat.size !== ctx.cache.getSize()) {
						// update cache
						ctx.cache.set(ctx.request.url.pathname, await Deno.readFile(path), Config.Cache.publicCacheTTL);
					}
				}
				if (Config.Cache.logPublicHit) CLog(`[<magenta>Cache HIT</magenta>] <cyan>${ctx.request.url.pathname}</cyan>`);
				// get mimetype
				const ext = path.extname(ctx.request.url.pathname);
				const mime = ExtMapping[ext] ?? "application/octet-stream";
				ctx.response.body = ctx.cache.get(ctx.request.url.pathname);
				// set cache headers for 5h
				ctx.response.headers.set("Cache-Control", "public, max-age=18000");
				ctx.response.headers.set("Expires", new Date(Date.now() + 18000).toUTCString());
				ctx.response.headers.set("Content-Type", mime);
			} else {
				// make sure path does not get escaped with /../ or /..\ or /..\..\ etc
				const l_path = `${Deno.cwd()}/public/${ctx.request.url.pathname}`.replace(/\/\.\.\//g, "/");
				// check if file exists
				if (exists(l_path)) {
					// read file
					const file = await Deno.readFile(l_path);
					if (Config.Cache.enablePublicCache) {
						ctx.cache.set(ctx.request.url.pathname, file, Config.Cache.publicCacheTTL);
					}
					const ext = path.extname(ctx.request.url.pathname);
					const mime = ExtMapping[ext] ?? "application/octet-stream";
					ctx.response.body = file;
					ctx.response.headers.set("Content-Type", mime);
				} else {
					ctx.response.status = 404;
				}
			}
		} else {
			try {
				await next();
			} catch (error) {
				console.log(error);
				ctx.response.status = 503;
			}
		}
	});

	async function RecurisveImport(dir: string, hotreload = false) {
		const filesAndFolders: Map<string, Array<Deno.DirEntry>> = new Map();
		filesAndFolders.set(dir, [...Deno.readDirSync(dir)]);

		if (hotreload) {
			const worker = CreateWatcherWorker(dir, ".ts");

			worker.addEventListener("message", async (e) => {
				const file = JSON.parse(e.data);
				CLog(`[<yellow>FS-EVENT</yellow>] <magenta>${file.event}</magenta> : ${file.path}`);
				if (file.event != "remove") {
					await import("file://" + path.normalize(file.path) + "?t=" + new Date().getTime());
				}
			});
		}

		while (filesAndFolders.size > 0) {
			const [dir, files] = [...filesAndFolders.entries()][0];
			if (files.length === 0) {
				filesAndFolders.delete(dir);
				continue;
			}

			const file = files.shift() as Deno.DirEntry;
			if (file.isDirectory) {
				filesAndFolders.set(`${dir}/${file.name}`, [...Deno.readDirSync(`${dir}/${file.name}`)]);
			} else if (file.isFile && file.name.endsWith(".ts")) {
				const sdir = `file://${dir}`;
				await import(`${sdir}/${file.name}` + "?t=" + new Date().getTime());
			}
		}
	}

	// make sure all files in controllers are read
	await RecurisveImport(`${Deno.cwd()}/routes`, dev);
	
	await RecurisveImport(`${Deno.cwd()}/controller`, dev);
	
	app.use(Router.routes());

	uwu.InitView();
}

export const start = async (dev = false) => {
	controller = new AbortController();
	signal = controller.signal;
	// create new application
	if (!firststart) {
		firststart = true;
		await loadServerstuff(dev);
	}

	// listen for requests
	listenPromise = app.listen({ port: Config.General.port, signal, hostname: Config.General.listenOn });
	// console.log to console the port the server is listening on and the url to access it from the browser (localhost:port)
	CLog(`Server listening on port <green>${Config.General.port}</green>`);
	CLog(`Server url <green>${Config.General.url}</green>`);
};

export const stop = async () => {
	console.log("stopping server");

	controller.abort();
	await listenPromise;

	console.log("server stopped");
};

export const restart = async () => {
	await stop();
	await start();
};
