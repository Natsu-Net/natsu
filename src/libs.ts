import { Oak } from "./global/_deps.ts";
import HandlebarsJS from "./templates.ts";
import {defaultCache} from "./cache.ts"

// middleware for loading the handlebars,helpers &libs
// deno-lint-ignore no-explicit-any
export async function LibsMiddleWare(ctx: any, next: any) {
	ctx.cache = defaultCache;
	ctx.templates = HandlebarsJS;
	ctx.helpers = Oak.helpers;
	await next();
}
