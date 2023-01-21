// deno-lint-ignore-file
import  { GetController as TGetController, Controller as TController } from "../controller.ts";
import { Router as TRouter } from "../routes.ts";
import type { TypeRegisterMiddleware} from "../session/middle.ts";
import uwu from "../templates.ts";


declare global {
	var Config: {
		General: {
			listenOn: string|undefined;
			url: string;
			bantime?: number;
			proxy?: boolean;
			port: number;
			logFormat: string;
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
