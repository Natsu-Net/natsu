/**
 * Page files, compiled: from `pages/**\/*.uwu` under an app directory to the
 * route table, each file's server module, and what each one reads.
 *
 *   pages/index.uwu          /
 *   pages/about.uwu          /about
 *   pages/jobs/index.uwu     /jobs
 *   pages/p/[slug].uwu       /p/:slug
 *   pages/_layout.uwu        wraps every page in pages/ and below ({{> @child}})
 *   pages/jobs/_layout.uwu   wraps the pages in jobs/, inside the one above
 *   pages/_error.uwu         drawn for a 404/403/500 a page answers
 *   pages/_bare.uwu          a layout a page picks by name: <page layout="_bare">
 *   pages/_partials/card.uwu {{> card}} (or another directory: `partials`)
 *
 * A file or directory whose name starts with `_` is never a route.
 *
 * **Links.** `<a @href="/p/{{vendor}}/{{slug}}">` (uwu's link directive)
 * draws a plain `href="/p/acme/shoe"` that works without script, and is
 * checked here against the routes above: a path no page file answers fails
 * the compile with the file and line of the link (`checkLinks`). Each hole
 * stands for one value, so it fits a `[param]` or a fixed segment; the query
 * and the hash are free. The holes are reads like any other: inside
 * `{{#each products}}`, `{{slug}}` asks the source for `slug`. A link to
 * anything that is not a page file (a controller, a file, another site) is
 * a plain `href`. With page navigation on, every link to the site swaps;
 * `data-natsu-prefetch="viewport" | "hover" | "none"` picks when it is
 * fetched ahead (docs/page-navigation.md).
 *
 * A partial renders with its caller's data where it is included, so its
 * reads are walked there: `{{> card}}` inside `{{#each products}}` makes
 * `card`'s `{{name}}` a read of `products.name`. A partial registered only
 * at render time (`mountPages({ render: { partials } })`) is not seen.
 *
 * Templates are compiled once: `compilePages(dir, outDir)` writes them for a
 * deploy, and `mountPages({ dir })` compiles them in memory at start (and
 * again on change, in development). Either way the output is uwu's server
 * module text, which natsu evaluates against uwu's runtime itself, so a build
 * directory needs no module resolution of its own.
 */

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, sep } from "node:path";
import { type PageBlock, splitPageBlock, textPaths } from "./block.ts";
import { PageCompileError } from "./errors.ts";
import { HOLE, type Reads, type TplNode, addRead, collectReads, fieldList, scriptDeclarations } from "./reads.ts";

export type FileKind = "page" | "layout" | "error" | "partial";

/** Where partials live by default, relative to the app directory. */
export const PARTIALS_DIR = "pages/_partials";

export interface CompileOptions {
	/** The partials directory, relative to the app directory (default `pages/_partials`). */
	partials?: string;
	/**
	 * Rewrites a file's source before it compiles: the `<page>` block is
	 * already cut out (its lines kept blank), so this sees the template. For an
	 * app's own preprocessing, a minifier or text includes; `file` is relative
	 * to `pages/`. It should keep the file's lines where it can, or errors point
	 * at the wrong line.
	 */
	transform?: (source: string, file: string) => string;
}

/** What a name is read as, in a form that survives JSON (the build manifest). */
export interface ReadInfo {
	fields: string[];
	line: number;
}

export interface CompiledFile {
	/** Relative to `pages/`, with `/` separators. */
	file: string;
	kind: FileKind;
	/** Pages only: the route pattern, `/p/:slug`. */
	route?: string;
	params: string[];
	block: PageBlock | null;
	/** Every top-level name the file reads (template, title, data arguments). */
	reads: Record<string, ReadInfo>;
	/** uwu's server module, as text. */
	server: string;
	css: string;
	/** Partials (`{{> name}}`) the template includes, through other partials too. */
	partials: string[];
	/** Of those, the ones no partial file provides: their reads are not seen here. */
	unresolved: string[];
	/** `@event="action:name"` in the template (and its partials), first use of each. */
	actions: { name: string; line: number }[];
	/** `@href="/path"` links in the template itself, each checked against the page routes (see `checkLinks`). */
	links?: { href: string; line: number }[];
	/** A partial file: the name it is included by. */
	partial?: string;
}

export interface PageManifest {
	version: 1;
	files: (Omit<CompiledFile, "server"> & { module: string })[];
}

import type { TemplateAST } from "uwu-template/ast";

/** The part of uwu's `compile` result natsu reads. */
interface UwuCompiled {
	server: string;
	css: string;
	sfc: { scripts: { content: string }[] };
	template?: TemplateAST;
}

// uwu ships TypeScript sources written to flags looser than natsu's, so its
// compiler and runtime are loaded by specifiers the type checker does not
// follow (checking natsu should not mean checking uwu with natsu's flags).
// The tree's types come from `uwu-template/ast`, a file of types alone.
const UWU = "uwu-template";
const UWU_RUNTIME = "uwu-template/runtime";
type UwuCompile = (source: string, options: { file?: string }) => UwuCompiled;
// Loaded on the first compile, not on import: an app that serves pages compiled
// at build never loads the compiler (nor the CSS tools it brings).
let uwuCompile: UwuCompile | undefined;
const compile: UwuCompile = (source, options) =>
	(uwuCompile ??= (createRequire(import.meta.url)(UWU) as { compile: UwuCompile }).compile)(source, options);

const SEGMENT = /^[\w.~-]+$/;
const PARAM = /^\[([A-Za-z_][\w]*)\]$/;

/** The route a page file answers, from its path under `pages/`. */
export function routeOf(file: string): { route: string; params: string[] } {
	const parts = file.replace(/\.uwu$/, "").split("/");
	if (parts[parts.length - 1] === "index") parts.pop();
	const params: string[] = [];
	const out: string[] = [];
	for (const part of parts) {
		const param = PARAM.exec(part);
		if (param) {
			if (params.includes(param[1]!)) throw new PageCompileError(`pages/${file}`, 1, `the route names '${param[1]}' twice`);
			params.push(param[1]!);
			out.push(`:${param[1]}`);
		} else if (SEGMENT.test(part)) out.push(part);
		else {
			throw new PageCompileError(
				`pages/${file}`,
				1,
				`'${part}' cannot be part of a route: use letters, digits, '-', '_', '.', or [param] for a parameter`,
			);
		}
	}
	return { route: `/${out.join("/")}`, params };
}

function kindOf(file: string): FileKind {
	const parts = file.split("/");
	const base = parts[parts.length - 1]!;
	if (base === "_error.uwu") return "error";
	if (parts.some((part) => part.startsWith("_"))) return "layout";
	return "page";
}

/** Every `.uwu` file under `pagesDir`, relative and sorted. */
export function listPageFiles(pagesDir: string): string[] {
	const out: string[] = [];
	const walk = (dir: string): void => {
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.name.endsWith(".uwu")) out.push(relative(pagesDir, full).split(sep).join("/"));
		}
	};
	walk(pagesDir);
	return out.sort();
}

/** A partial's tree, as the reads walker takes it. */
export interface PartialTree {
	nodes: readonly TplNode[];
	scriptNames: ReadonlySet<string>;
}

interface Compiled {
	file: CompiledFile;
	tree: PartialTree;
}

/** Compile one page, layout or error file. `file` is relative to `pages/`. */
export function compilePageFile(
	source: string,
	file: string,
	options: { partials?: ReadonlyMap<string, PartialTree>; partial?: string; transform?: CompileOptions["transform"] } = {},
): CompiledFile {
	return compileOne(source, file, options).file;
}

function compileOne(source: string, file: string, options: { partials?: ReadonlyMap<string, PartialTree>; partial?: string; transform?: CompileOptions["transform"] }): Compiled {
	const shown = `pages/${file}`;
	const kind = options.partial !== undefined ? "partial" : kindOf(file);
	const { rest, block } = splitPageBlock(source, shown);
	if (block && kind === "partial") {
		throw new PageCompileError(shown, block.line, "a partial has no <page> block: it reads its caller's data; declare <data> and <action> on the page or a layout");
	}
	if (block && kind !== "page") {
		const pageOnly = (["title", "description", "cache", "layout"] as const).find((key) => block[key] !== undefined);
		if (pageOnly) {
			throw new PageCompileError(shown, block.line, `<page ${pageOnly}> belongs on a page; a ${kind} file may only declare <data> and <action>`);
		}
	}

	let result: UwuCompiled;
	try {
		// uwu derives the scope of a `<style>` from the file's path.
		result = compile(options.transform ? options.transform(rest, file) : rest, { file: shown });
	} catch (error) {
		const loc = (error as { loc?: { line: number } }).loc;
		throw new PageCompileError(shown, loc?.line ?? 1, (error as Error).message);
	}
	if (/^\s*import\s/m.test(result.server.replace(/^import\s*\{[^}]*\}\s*from\s*"@uwu\/runtime";?\s*$/m, ""))) {
		throw new PageCompileError(shown, 1, "a page's <script> may not import modules: load data in a source and read it by name");
	}

	const partials = new Set<string>();
	const unresolved = new Set<string>();
	const actions = new Map<string, number>();
	const links: { href: string; line: number }[] = [];
	const scriptNames = scriptDeclarations(result.sfc.scripts);
	const nodes = result.template?.nodes ?? [];
	const reads: Reads = collectReads(nodes, {
		scriptNames,
		partial: (name) => {
			const tree = options.partials?.get(name);
			if (tree) partials.add(name);
			return tree;
		},
		onPartial: (name) => {
			partials.add(name);
			unresolved.add(name);
		},
		onAction: (name, loc) => {
			if (!actions.has(name)) actions.set(name, loc.line);
		},
		onLink: (href, loc) => void links.push({ href, line: loc.line }),
	});

	// The block reads too: title holes, data arguments, service paths.
	if (block) {
		const at = { line: block.line, col: 1 };
		for (const path of [...textPaths(block.title), ...textPaths(block.description)]) addRead(reads, path, at);
		for (const decl of block.data) {
			const where = { line: decl.line, col: 1 };
			if (decl.from.t === "source") {
				for (const arg of Object.values(decl.from.args)) if (arg.t === "path") addRead(reads, arg.segments, where);
			} else for (const path of textPaths(decl.from.path)) addRead(reads, path, where);
		}
	}

	const { route, params } = kind === "page" ? routeOf(file) : { route: undefined, params: [] };
	const out: Record<string, ReadInfo> = {};
	for (const [name, read] of reads) out[name] = { fields: fieldList(read), line: read.loc.line };
	return {
		file: {
			file,
			kind,
			route,
			params,
			block,
			reads: out,
			server: result.server,
			css: result.css,
			partials: [...partials],
			unresolved: [...unresolved],
			actions: [...actions].map(([name, line]) => ({ name, line })),
			...(links.length > 0 ? { links } : {}),
			...(options.partial !== undefined ? { partial: options.partial } : {}),
		},
		tree: { nodes, scriptNames },
	};
}

/**
 * Compile every file under `<appDir>/pages`, and the partials directory:
 * the partials first, so every other file walks them where it includes them.
 */
export function compileAll(appDir: string, options: CompileOptions = {}): CompiledFile[] {
	const pagesDir = join(appDir, "pages");
	const partialsDir = join(appDir, options.partials ?? PARTIALS_DIR);
	const inPages = relative(pagesDir, partialsDir).split(sep).join("/");
	const outside = inPages.startsWith("..") || inPages === "";
	const files = listPageFiles(pagesDir).filter((file) => outside || !file.startsWith(`${inPages}/`));
	const partialFiles = listPageFiles(partialsDir).map((name) => ({ name: name.replace(/\.uwu$/, ""), file: relative(pagesDir, join(partialsDir, name)).split(sep).join("/") }));

	const trees = new Map<string, PartialTree>();
	const partials = partialFiles.map(({ name, file }) => {
		const source = readFileSync(join(pagesDir, file), "utf8");
		trees.set(name, compileOne(source, file, { partial: name, transform: options.transform }).tree);
		return { name, file, source };
	});
	// Again, now that every partial's tree is known: a partial including another.
	const compiled = [
		...partials.map(({ name, file, source }) => compileOne(source, file, { partial: name, partials: trees, transform: options.transform }).file),
		...files.map((file) => compileOne(readFileSync(join(pagesDir, file), "utf8"), file, { partials: trees, transform: options.transform }).file),
	];
	const routes = new Map<string, string>();
	for (const page of compiled) {
		if (page.kind !== "page") continue;
		const other = routes.get(page.route!);
		if (other) throw new PageCompileError(`pages/${page.file}`, 1, `answers ${page.route}, as pages/${other} already does`);
		routes.set(page.route!, page.file);
	}
	checkLinks(compiled);
	return compiled;
}

/**
 * Every `@href` in every file must lead to a page: `@href="/p/{{slug}}"`
 * needs a page file that answers `/p/:slug` (or `/p/sale`, which a hole may
 * fill). The value is the URL that ships, so this is the whole router: no
 * table to keep, and a renamed or deleted page file is an error at compile,
 * with the file and line of every link that pointed at it. A link to a
 * route that is not a page file (a controller, a static file, another site)
 * is a plain `href`.
 */
export function checkLinks(files: readonly CompiledFile[]): void {
	const routes = files.filter((file) => file.kind === "page").map((file) => file.route!);
	for (const file of files) for (const link of file.links ?? []) {
		const problem = linkProblem(link.href, routes);
		if (problem) throw new PageCompileError(`pages/${file.file}`, link.line, `@href="${link.href}" ${problem}`);
	}
}

const HOLE_MARK = "\0";

/** Why `href` reaches no route of `routes`, or undefined when one may answer it. */
export function linkProblem(href: string, routes: readonly string[]): string | undefined {
	// A hole stands for one value: out of the way while the path is read.
	const marked = href.replace(HOLE, HOLE_MARK);
	if (marked.startsWith(HOLE_MARK)) return "starts with data: write the path from /, or use href for a URL that is data";
	if (/^[a-z][\w+.-]*:|^\/\//i.test(marked)) return "is another site: @href links to a page of this one; use href";
	if (!marked.startsWith("/")) return "is relative: write the path from /, as the page's route says it";
	// The router answers /x/ as /x; the query and the hash are the page's own.
	let path = marked.split(/[?#]/)[0]!;
	if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
	const segments = path === "/" ? [] : path.slice(1).split("/");
	const fits = (route: string): boolean => {
		const want = route === "/" ? [] : route.slice(1).split("/");
		return (
			want.length === segments.length &&
			want.every((part, i) => {
				const have = segments[i]!;
				if (have === "") return false;
				if (part.startsWith(":")) return true;
				// A hole may fill a fixed segment: /{{section}} may be /about.
				if (!have.includes(HOLE_MARK)) return safeDecode(have) === part;
				const pattern = have.split(HOLE_MARK).map((text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".+");
				return new RegExp(`^${pattern}$`).test(part);
			})
		);
	};
	if (routes.some(fits)) return undefined;
	const shown = segments.length === 0 ? "/" : `/${segments.map((part) => (part.includes(HOLE_MARK) ? ":…" : part)).join("/")}`;
	const near = routes.filter((route) => (route === "/" ? 0 : route.split("/").length - 1) === segments.length);
	return `matches no page: no file under pages/ answers ${shown}${near.length > 0 ? ` (pages of that depth: ${near.sort().join(", ")})` : ""}`;
}

function safeDecode(text: string): string {
	try {
		return decodeURIComponent(text);
	} catch {
		return text;
	}
}

/**
 * Compile `<appDir>/pages` for a deploy: one ES module per file under
 * `outDir/pages/`, the scoped CSS of all of them in `outDir/pages.css`, and
 * `outDir/pages.json`, which `mountPages({ built: outDir })` loads.
 */
export function compilePages(appDir: string, outDir: string, options: CompileOptions = {}): PageManifest {
	const compiled = compileAll(appDir, options);
	const manifest: PageManifest = { version: 1, files: [] };
	for (const { server, ...rest } of compiled) {
		const module = `pages/${rest.file.replace(/\.uwu$/, ".js")}`;
		mkdirSync(dirname(join(outDir, module)), { recursive: true });
		writeFileSync(join(outDir, module), server);
		manifest.files.push({ ...rest, module });
	}
	writeFileSync(join(outDir, "pages.css"), compiled.map((file) => file.css).filter(Boolean).join("\n"));
	writeFileSync(join(outDir, "pages.json"), JSON.stringify(manifest, null, "\t"));
	return manifest;
}

/** Load what `compilePages` wrote. */
export function loadBuilt(outDir: string): CompiledFile[] {
	const manifest = JSON.parse(readFileSync(join(outDir, "pages.json"), "utf8")) as PageManifest;
	if (manifest.version !== 1) throw new Error(`natsu/pages: ${outDir}/pages.json is from another version of natsu`);
	return manifest.files.map(({ module, ...rest }) => ({ ...rest, server: readFileSync(join(outDir, module), "utf8") }));
}

// --- evaluating a server module --------------------------------------------

export type Render = (props: Record<string, unknown>, child?: string, opts?: Record<string, unknown>) => Promise<string>;

let runtime: Promise<Record<string, unknown>> | undefined;

/** uwu's server runtime: what compiled modules import as `@uwu/runtime`. */
export function uwuRuntime(): Promise<Record<string, unknown>> {
	return (runtime ??= import(UWU_RUNTIME) as Promise<Record<string, unknown>>);
}

const RUNTIME_IMPORT = /^import\s*\{([^}]*)\}\s*from\s*"@uwu\/runtime";?\s*$/m;

/** Turn a compiled server module's text into its `render` function. */
export async function evaluateServer(text: string, file: string): Promise<Render> {
	const rt = await uwuRuntime();
	const imports = RUNTIME_IMPORT.exec(text);
	let body = text.replace(RUNTIME_IMPORT, "");
	const bindings = (imports?.[1] ?? "")
		.split(",")
		.map((part) => part.trim())
		.filter(Boolean)
		.map((part) => part.replace(/\s+as\s+/, ": "));
	if (!/export\s+async\s+function\s+render\b/.test(body)) throw new Error(`natsu/pages: ${file} has no render export`);
	body = body.replace(/export\s+async\s+function\s+render\b/, "async function render");
	const code = `"use strict";\nconst { ${bindings.join(", ")} } = __rt;\n${body}\nreturn render;\n//# sourceURL=${file}`;
	return new Function("__rt", code)(rt) as Render;
}
