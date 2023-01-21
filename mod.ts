// deno-lint-ignore-file no-var
import {start,stop,restart} from "./web.ts";
import {download} from "./init.ts";

// get deno args
const args = Deno.args;

// check if args are valid
if (args.length === 0) Deno.exit(1);

// get first arg
const laucnhArg = args[0];

declare global {
    var web_restart: typeof restart;
	var web_stop: typeof stop;
	var web_start: typeof start;
}

globalThis.web_restart = restart;
globalThis.web_stop = stop;
globalThis.web_start = start;

switch (laucnhArg) {
	case "start":
		await start();
		break;
	case "dev":
		await start(true);
		break;
	case "init":
		await download(Deno.cwd());
		Deno.exit(0);
}