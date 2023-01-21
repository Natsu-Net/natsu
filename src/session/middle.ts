import { ContextS } from "../interface.ts";

type Middleware = (ctx: ContextS,next:()=>void)=>void;

const sessionMiddleware = new Map<string, Middleware>();
function registerMiddleware(name: string, middleware: Middleware ) {
	sessionMiddleware.set(name, middleware);
}
function getAllMiddleware() {
	return sessionMiddleware;
}

type TypeRegisterMiddleware = typeof registerMiddleware;
export type { TypeRegisterMiddleware };
export { getAllMiddleware, registerMiddleware };
