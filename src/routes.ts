// deno-lint-ignore-file no-explicit-any
import { Oak } from "./global/_deps.ts";
import { ContextS } from "./interface.ts";

const OakRouter = Oak.Router;
const RoutersList: Map<string, Router> = new Map();

let newRouter = true;

// base router class for all routes
type middleware = (ctx: ContextS) => boolean | void | Promise<boolean | void>;

class Router extends OakRouter {
	private domain: string | undefined;
	private SubRouter: string | boolean = false;
	private middlewareList = new Map<string, middleware>();

	static instance: Router[] = [];

	/**
	 * Router constructor the first argument is the domain you want to listen to if left empty it will listen to all requests.
	 * @param  {string} domain
	 */
	constructor(domain: string | undefined = undefined, subRouter: string | boolean = false) {
		super();
		this.domain = domain;
		this.SubRouter = subRouter;
		newRouter = true;
		if (subRouter == false) {
			RoutersList.set(domain ?? "undefined", this);
		}
		Router.instance.push(this);
	}

	private customHandler(path: any, handler: any) {
		const controller = GetController(handler);
		const cdata = handler.split("@");
		const domain = this.domain;
		const spath = this.SubRouter ? `${this.SubRouter}${path}` : path;
		CLog(`[<green>Routes</green>] Register : <cyan>${spath}</cyan> > ${cdata[0]}.${cdata[1]}`);
		const func = async (ctx: any, next: any) => {
			if (domain && ctx.request.headers.get("host") != this.domain) return await next();

			const middle = this.middlewareList.get(this.SubRouter as string);

			if (middle) {
				(await middle(ctx)) ? await controller(ctx, next) : await next();
			} else {
				await controller(ctx, next);
			}
		};

		return { func, path };
	}

	private middleware(path: string, middleware: middleware) {
		this.middlewareList.set(path, middleware);
	}

	/**
	 * @param  {string} path
	 * @param  {Router} callback with the router as argument to register routes
	 * @param  {middleware} middleware
	 *
	 */
	public Prefix(path: string, func: (SubRouter: Router) => void, middleware?: middleware) {
		const router = new Router(this.domain, path);
		func(router);
		middleware ? router.middleware(path, middleware) : undefined;
		this.use(path, router.routes());
		newRouter = true;
	}

	public get(path: string, handler: any) {
		// GetSubController
		const data = this.customHandler(path, handler);
		return super.get(data.path, data.func);
	}

	public post(path: string, handler: any) {
		// GetSubController
		const data = this.customHandler(path, handler);

		return super.post(data.path, data.func);
	}

	public put(path: string, handler: any) {
		// GetSubController
		const data = this.customHandler(path, handler);
		return super.put(data.path, data.func);
	}

	public delete(path: string, handler: any) {
		// GetSubController
		const data = this.customHandler(path, handler);

		return super.delete(path, data.func);
	}

	public all(path: string, handler: any) {
		// GetSubController
		const data = this.customHandler(path, handler);

		return super.all(data.path, data.func);
	}

	static routes() {
		let cache_routes: Oak.Middleware<Record<string, any>, Oak.Context<Record<string, any>, Record<string, any>>>;
		const dispatch = async (ctx: any, next: any) => {
			if (newRouter) {
				const main = new OakRouter();
				for (const [_key, value] of RoutersList) {
					main.use(value.routes(), value.allowedMethods());
				}
				cache_routes = main.routes();
				newRouter = false;
				RoutersList.clear();
			}
			return cache_routes ? await cache_routes(ctx, next) : await next();
		};

		return dispatch;
	}
}

export { Router };
