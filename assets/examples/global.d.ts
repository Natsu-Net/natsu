// deno-lint-ignore-file
import { Controller as TController , GetController as TGetController} from "../cli/src/controller.ts";
import type { Router as TRouter} from "../cli/src/routes.ts";
import type { TypeRegisterMiddleware} from "../cli/src/session/middle.ts";
import uwu from "../cli/src/templates.ts";


declare global {
	var Config: {
		General: {
			url: string;
			bantime?: number;
			port: number;
			listenOn: string|undefined;
		};
		Cache: {
			enablePublicCache: boolean;
			publicCacheTTL: number;
			autoUpdatePublicCache: boolean;
			logPublicHit: boolean;
		};
		MySQL: {
			host: string;
			database: string;
			username: string;
			password: string;
			charset: string;
		};
		Session: {
			driver: string;
			CookieName: string;
			logLevel?: string;
		};
		[key: string]: any;
	};
	var Router: typeof TRouter;
	var Controller: typeof TController;
	var GetController: typeof TGetController;
	var SessionRegisterMiddleware: TypeRegisterMiddleware;
	var CLog: (str: string) => void;
	var registerHelper: typeof uwu.registerHelper;
	interface BigInt {
		toJSON(): string;
	}
}
