/**
 * The bundled example app — what `bun run dev` serves.
 *
 * It is written the way a v1 app is written (globals, `routes/` and
 * `controller/` directories loaded by convention, `"Controller@method"`
 * strings) with one decorator controller alongside, to show both styles
 * running in the same process.
 */

import { join } from "node:path";
import { Application, installGlobals, loadDirectory, setConfig } from "../index.ts";

installGlobals();

setConfig({
	General: {
		port: Number(process.env.PORT ?? 8083),
		url: `http://127.0.0.1:${process.env.PORT ?? 8083}`,
		logFormat: "[<yellow>{method}</yellow>] {ip} <magenta>{path}</magenta> <{color}>{status}</{color}> in <{color}>{ms}ms</{color}>",
		logLevel: "info",
		development: true,
	},
	Static: { enabled: true, root: join(import.meta.dir, "public"), maxAge: 60 },
	Session: { driver: "sqlite", path: join(import.meta.dir, ".natsu", "sessions.sqlite"), CookieName: "NATSU_EXAMPLE" },
});

// Loading a file is how it registers itself; order between the two does not
// matter, because `"Controller@method"` resolves per request.
await loadDirectory(join(import.meta.dir, "routes"));
await loadDirectory(join(import.meta.dir, "controller"));

const app = new Application({ cwd: import.meta.dir });
await app.start();

export { app };
