import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { CliDeps, PrebuildResult, PrebuildTarget } from "./contract.ts";

const COMMANDS = new Set(["build", "pin", "check"]);
const USAGE = [
	"usage: bun node_modules/natsu/src/assets/cli.ts <build|pin|check> [--config <file>] [--export <name>]",
	"  build   build every asset and write the manifest the app boots from",
	"  pin     build, fetching remote assets and writing their pins to the lockfile",
	"  check   build and exit 1 when the result differs from the manifest on disk",
	"  --config  module that exports the asset options (default assets.config.ts)",
	"  --export  name of the export holding them (default: default)",
];

interface Parsed {
	command: string;
	config: string;
	exported: string;
}

function parse(argv: string[]): Parsed | string {
	let command: string | undefined;
	let config = "assets.config.ts";
	let exported = "default";
	for (let index = 0; index < argv.length; index++) {
		const argument = argv[index]!;
		if (argument === "--help" || argument === "-h") return "";
		if (argument === "--config" || argument === "--export") {
			const value = argv[++index];
			if (value === undefined || value === "" || value.startsWith("--")) return `${argument} needs a value`;
			if (argument === "--config") config = value;
			else exported = value;
			continue;
		}
		if (argument.startsWith("--config=") || argument.startsWith("--export=")) {
			const value = argument.slice(9);
			if (value === "") return `${argument.slice(0, 8)} needs a value`;
			if (argument.startsWith("--config=")) config = value;
			else exported = value;
			continue;
		}
		if (argument.startsWith("-")) return `unknown option ${argument}`;
		if (command !== undefined) return `unexpected argument ${argument}`;
		command = argument;
	}
	if (command === undefined) return "no command given";
	if (!COMMANDS.has(command)) return `unknown command ${command}`;
	return { command, config, exported };
}

function messageOf(cause: unknown): string {
	if (!(cause instanceof Error)) return String(cause);
	const inner = cause.cause instanceof Error ? `: ${cause.cause.message}` : "";
	return `${cause.message}${inner}`;
}

function manifestGuess(options: unknown, cwd: string): string | undefined {
	if (options === null || typeof options !== "object") return undefined;
	const record = options as { outDir?: unknown; prebuilt?: unknown };
	const prebuilt = record.prebuilt;
	if (prebuilt !== null && typeof prebuilt === "object") {
		const manifest = (prebuilt as { manifest?: unknown }).manifest;
		if (typeof manifest === "string" && manifest !== "") return resolve(cwd, manifest);
	}
	if (typeof record.outDir !== "string" || record.outDir === "") return undefined;
	return join(resolve(cwd, record.outDir), "natsu-assets.json");
}

async function textOf(path: string | undefined): Promise<string | undefined> {
	if (path === undefined) return undefined;
	try {
		return await readFile(path, "utf8");
	} catch {
		return undefined;
	}
}

function summaryOf(text: string | undefined): Map<string, string> | undefined {
	if (text === undefined) return undefined;
	try {
		const parsed = JSON.parse(text) as { files?: unknown; entries?: unknown; fingerprint?: unknown; natsu?: unknown; buildId?: unknown };
		const out = new Map<string, string>();
		out.set("fingerprint", String(parsed.fingerprint));
		out.set("natsu", String(parsed.natsu));
		out.set("buildId", String(parsed.buildId));
		out.set("entries", JSON.stringify(parsed.entries ?? null));
		if (Array.isArray(parsed.files)) {
			for (const file of parsed.files as Array<{ file?: unknown; sha256?: unknown }>) {
				out.set(`file ${String(file?.file)}`, String(file?.sha256));
			}
		}
		return out;
	} catch {
		return undefined;
	}
}

function changes(before: Map<string, string>, after: Map<string, string>): string[] {
	const out: string[] = [];
	for (const key of [...new Set([...before.keys(), ...after.keys()])].sort()) {
		const was = before.get(key);
		const now = after.get(key);
		if (was === now) continue;
		out.push(was === undefined ? `added ${key}` : now === undefined ? `removed ${key}` : `changed ${key}`);
	}
	return out;
}

function report(result: PrebuildResult, out: (line: string) => void): void {
	out(`natsu assets: ${result.files} files, ${result.bytes} bytes, manifest ${result.manifest}`);
	if (result.remote) {
		out(`remote: ${result.remote.fetched} fetched, ${result.remote.pinned.length} pinned`);
		for (const url of result.remote.pinned) out(`pinned ${url}`);
	}
	for (const skipped of result.skipped ?? []) {
		out(`skipped ${skipped.ref} (${skipped.outcome}${skipped.reason ? `: ${skipped.reason}` : ""})`);
	}
}

export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
	const out = deps.out ?? ((line: string) => console.log(line));
	const err = deps.err ?? ((line: string) => console.error(line));
	const usage = (problem: string): number => {
		if (problem !== "") err(`natsu assets: ${problem}`);
		for (const line of USAGE) err(line);
		return 2;
	};
	const parsed = parse(argv);
	if (typeof parsed === "string") return usage(parsed);

	const cwd = resolve(deps.cwd ?? process.cwd());
	let root: string;
	let file: string;
	try {
		root = await realpath(cwd);
	} catch {
		return usage(`working directory ${cwd} does not exist`);
	}
	try {
		file = await realpath(isAbsolute(parsed.config) ? parsed.config : resolve(cwd, parsed.config));
	} catch {
		return usage(`config file ${parsed.config} does not exist`);
	}
	if (!file.startsWith(root.endsWith(sep) ? root : root + sep)) {
		return usage(`config file ${parsed.config} is outside ${cwd}`);
	}

	try {
		const load = deps.load ?? ((path: string) => import(pathToFileURL(path).href) as Promise<Record<string, unknown>>);
		const module = await load(file);
		if (module === null || typeof module !== "object" || !(parsed.exported in module)) {
			err(`natsu assets: ${parsed.config} has no export named ${parsed.exported}`);
			return 1;
		}
		let options: unknown = module[parsed.exported];
		if (typeof options === "function") options = await (options as () => unknown)();
		if (options === null || typeof options !== "object") {
			err(`natsu assets: export ${parsed.exported} of ${parsed.config} is not an options object`);
			return 1;
		}
		const before = parsed.command === "check" ? summaryOf(await textOf(manifestGuess(options, cwd))) : undefined;
		const target: PrebuildTarget = deps.create(options);
		const result = await target.prebuild(parsed.command === "pin" ? { pin: true } : undefined);
		report(result, out);
		if (parsed.command !== "check") return 0;
		const after = summaryOf(await textOf(resolve(cwd, result.manifest)));
		if (!before) {
			err("natsu assets: check failed, there was no readable manifest before this build");
			return 1;
		}
		if (!after) {
			err(`natsu assets: check failed, manifest ${result.manifest} is not readable`);
			return 1;
		}
		const changed = changes(before, after);
		if (changed.length > 0) {
			err(`natsu assets: check failed, ${changed.length} change${changed.length === 1 ? "" : "s"}`);
			for (const line of changed) err(`  ${line}`);
			return 1;
		}
		out("natsu assets: check passed, the manifest is current");
		return 0;
	} catch (cause) {
		err(`natsu assets: ${parsed.command} failed: ${messageOf(cause)}`);
		return 1;
	}
}

if (import.meta.main) {
	const loaded = (await import("../assets.ts")) as unknown as { Assets: new (options: unknown) => Partial<PrebuildTarget> };
	const code = await runCli(process.argv.slice(2), {
		create: (options) => {
			const target = new loaded.Assets(options);
			if (typeof target.prebuild !== "function") throw new Error("this natsu build has no Assets.prebuild()");
			return target as PrebuildTarget;
		},
	});
	process.exit(code);
}
