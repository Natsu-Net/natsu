// deno-lint-ignore-file
import { CreateWatcherWorker } from "./watcher/watcher.ts";
import { ink, uwu } from "./global/_deps.ts";

const TEMPLATE_DIR = `${Deno.cwd()}/views`;
const LAYOUT_REGEX = /{{\> (.*?)}}/gms;

function Clog(str: string) {
	console.log(ink.colorize(str));
}

const helper = {
	/**
	 * @param  {any} expression
	 * @param  {any} options
	 */
	x: function (expression: any, options: any) {
		return Function("return " + expression).apply(this);
	},
	/**
	 * @param  {any} n
	 * @param  {any} block
	 */
	times: function (n: any, block: any) {
		var accum = "";
		for (var i = 0; i < n; ++i) accum += block.fn(i);
		return accum;
	},
	/**
	 * @param  {any} obj
	 */
	toJSON: function (obj: any) {
		return JSON.stringify(obj, (key, value) => (typeof value === "bigint" ? value.toString() : value), 3);
	},
};

const compiled = new Map<string, any>();

const layouts_list = new Map<string, any>();

// read all file in views folder
function InitView() {
	const worker = CreateWatcherWorker(TEMPLATE_DIR, ".nnt");

	worker.addEventListener("message", async (e) => {
		const data = JSON.parse(e.data);
		const slash = data.path.indexOf("/") > -1 ? "/" : "\\";
		const view = data.path
			.replace(new RegExp(`.*?views\\${slash}`), "")
			.replace(/\.nnt$/, "")
			.replaceAll(slash, "/");
		if (data.event == "delete") {
			compiled.delete(view);
			return Clog(`[<cyan>VIEWS</cyan>] Removed : ${view}`);
		}
		if (view.startsWith("layouts/")) {
			const dependents = layouts_list.get(view);
			if (dependents) {
				for (const dependent of dependents) {
					Clog(`[<green>VIEWS</green>] Updating : ${dependent} because of <cyan>${view}</cyan>`);
					compiled.set(dependent, GetCompiled(dependent));
				}
			}
		} else {
			Clog(`[<cyan>VIEWS</cyan>] Updated : ${view}`);
			compiled.set(view, GetCompiled(view));
		}
	});

	const filesAndFolders: Map<string, Array<Deno.DirEntry>> = new Map();
	filesAndFolders.set(TEMPLATE_DIR, [...Deno.readDirSync(TEMPLATE_DIR)]);

	while (filesAndFolders.size > 0) {
		const [dir, files] = [...filesAndFolders.entries()][0];
		if (files.length === 0) {
			filesAndFolders.delete(dir);
			continue;
		}

		const file = files.shift() as Deno.DirEntry;
		if (file.isDirectory) {
			filesAndFolders.set(`${dir}/${file.name}`, [...Deno.readDirSync(`${dir}/${file.name}`)]);
		} else if (file.isFile && file.name.endsWith(".nnt")) {
			const slash = dir.indexOf("/") > -1 ? "/" : "\\";
			// remove everything infront of /pages
			const view = dir.replace(new RegExp(`.*?views\\${slash}`), "").replaceAll(slash, "/") + "/" + file.name.replace(/\.nnt$/, "");
			Clog(`[<cyan>VIEWS</cyan>] Caching : ${view}`);
			const template = GetCompiled(view);
			compiled.set(view, template);
		}
	}
}

const formatdate = (date: any) => {
	const d = new Date(date);
	const h = d.getUTCHours();
	const m = d.getUTCMinutes();
	const y = d.getUTCFullYear();
	const M = d.getUTCMonth() + 1;
	const D = d.getUTCDate();
	return `${h < 10 ? "0" + h : h}:${m < 10 ? "0" + m : m} ${y}-${M < 10 ? "0" + M : M}-${D < 10 ? "0" + D : D}`;
};

uwu.registerHelper("formatdate", formatdate);

function GetCompiled(view: string) {
	const file = Deno.readTextFileSync(`${TEMPLATE_DIR}/${view}.nnt`);
	// check for layout
	let temp = file.replace(LAYOUT_REGEX, (match, layout) => {
		const file = layout.trim();
		const dependent = layouts_list.get(file) || [];
		if (!dependent.includes(view)) {
			dependent.push(view);
			layouts_list.set(file, dependent);
		}
		const data = Deno.readTextFileSync(`${TEMPLATE_DIR}/${file}.nnt`);
		return data;
	});
	try {
		return uwu.compile(temp);
	} catch (error) {
		console.log(error);
		return async (...args:any) => error;
	}
}

function renderView(view: string, data: any) {
	if (compiled.has(view)) {
		return compiled.get(view)(data);
	}

	const template = GetCompiled(view);
	compiled.set(view, template);
	try {
		return template(data);
	} catch (error) {
		console.log(error.message, view, data);
		return error.message;
	}
}
const registerHelper = uwu.registerHelper
export default { renderView, InitView,registerHelper,compile : uwu.compile };

