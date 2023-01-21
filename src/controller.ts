// deno-lint-ignore-file
import { ContextS } from "./interface.ts";
import { Oak } from "./global/_deps.ts";

interface ControllerList {
	[index: string]: any;
}

var ControllerList: ControllerList = {};

// public controller class
class Controller {
	private namespace: string;
	constructor(namespace: string) {
		this.namespace = namespace;
	}
	/**
	 * @param  {string} name
	 * @param  {(ctx:ContextS)=>void} func
	 */
	public Add(name: string, func: (ctx: ContextS) => void) {
		CLog(`[<magenta>Controller</magenta>] Register : <cyan>${this.namespace}.${name}</cyan> > ${typeof func}`);
		ControllerList[`${this.namespace}@${name}`] = func;
	}
}

function GetController(name: string) {
	return (...args: any) => { return ControllerList[name]?.(...args)  };
}

export async function middlewareConvert(this: any, ctx:Oak.Context,next:any){
	await this.func(ctx,next);
}


export { Controller, GetController };
export type { ContextS as Context };
