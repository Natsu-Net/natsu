import { Oak} from "./global/_deps.ts";
import type { Session } from "./session/session.ts";
import uwu from "./templates.ts";
import {defaultCache} from "./cache.ts"

const {Context, helpers } = Oak;

interface Libs {
	// deno-lint-ignore no-explicit-any
	[index: string]: any;
}

class ContextS extends Context {
	// deno-lint-ignore no-explicit-any
	[x: string]: any;
	public cache = defaultCache;
	public libs!: Libs;
	public templates = uwu;
	public helpers = helpers;
	// deno-lint-ignore no-explicit-any
	public params: any;
	public session!: Session;
}

export { ContextS };
