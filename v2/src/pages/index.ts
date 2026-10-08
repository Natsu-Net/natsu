/**
 * Page files: `pages/**\/*.uwu` under an app directory, served as routes
 * that find their own data. See mount.ts for the request, data.ts for where
 * each name comes from, block.ts for the `<page>` block.
 */

export {
	Invalid,
	action,
	clearActions,
	guard,
	type ActionHandler,
	type ActionInput,
	type ActionOptions,
	type ActionResult,
	type AuthRule,
	type Guard,
	type GuardInput,
} from "./actions.ts";
export { compilePages, compilePageFile, evaluateServer, routeOf, type CompiledFile, type Render, type CompileOptions, type PageManifest } from "./compile.ts";
export {
	clearSources,
	defaultKind,
	registerModelResolver,
	removeSource,
	source,
	type ModelKind,
	type ModelManyInput,
	type ModelOneInput,
	type ModelResolver,
	type ServiceConfig,
	type SourceFn,
	type SourceInput,
	type SourceOptions,
	type UsedData,
} from "./data.ts";
export { Forbidden, HttpError, NotFound, PageCompileError, Redirect } from "./errors.ts";
export { mountPages, type PageLocals, type PageRoute, type PageSite, type PagesOptions } from "./mount.ts";
export type { PageMeta } from "./meta.ts";
