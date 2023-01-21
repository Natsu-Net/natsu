// deno-lint-ignore-file
/// <reference path="./_global.d.ts" />
import { Controller as GlobalController, GetController as GlobalGetController } from "../controller.ts";
import {ink} from './_deps.ts'
import { Router as GlobalRouter } from "../routes.ts";
import { config } from './config.ts';
import { registerMiddleware } from "../session/middle.ts";
import uwu from "../templates.ts"

/**
 * @param  {string} str
 */
function Clog(str:string) {
	console.log(ink.colorize(str));
}

BigInt.prototype.toJSON = function() { return this.toString() }

globalThis.GetController = GlobalGetController;
globalThis.Controller = GlobalController as typeof Controller;
globalThis.Router = GlobalRouter as unknown as typeof Router;
globalThis.Config = config;
globalThis.SessionRegisterMiddleware = registerMiddleware;
globalThis.registerHelper = uwu.registerHelper;
globalThis.CLog = Clog;