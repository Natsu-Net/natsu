/**
 * natsu's log colouring, replacing Deno's `ink`.
 *
 * v1 log strings are markup, not printf: `[<green>Routes</green>] <cyan>/x</cyan>`.
 * Apps and controllers already write that markup, so the tag language has to be
 * preserved verbatim; only the implementation moves in-tree.
 */

const CODES: Readonly<Record<string, readonly [number, number]>> = {
	// [open, close] SGR pairs. Close codes are per-attribute so nesting a colour
	// inside a bold span does not switch the bold off on the inner close tag.
	black: [30, 39],
	red: [31, 39],
	green: [32, 39],
	yellow: [33, 39],
	blue: [34, 39],
	magenta: [35, 39],
	cyan: [36, 39],
	white: [37, 39],
	gray: [90, 39],
	grey: [90, 39],
	"bright-red": [91, 39],
	"bright-green": [92, 39],
	"bright-yellow": [93, 39],
	"bright-blue": [94, 39],
	"bright-magenta": [95, 39],
	"bright-cyan": [96, 39],
	"bg-black": [40, 49],
	"bg-red": [41, 49],
	"bg-green": [42, 49],
	"bg-yellow": [43, 49],
	"bg-blue": [44, 49],
	"bg-magenta": [45, 49],
	"bg-cyan": [46, 49],
	"bg-white": [47, 49],
	b: [1, 22],
	bold: [1, 22],
	dim: [2, 22],
	i: [3, 23],
	italic: [3, 23],
	u: [4, 24],
	underline: [4, 24],
	strike: [9, 29],
};

const TAG = /<(\/?)([a-z-]+)>/g;

function envColour(): boolean {
	if (process.env.NO_COLOR) return false;
	if (process.env.FORCE_COLOR) return process.env.FORCE_COLOR !== "0";
	return Boolean(process.stdout.isTTY);
}

let colourEnabled = envColour();

/** Force colour on/off; tests and piped output need the plain form. */
export function setColorEnabled(enabled: boolean): void {
	colourEnabled = enabled;
}

export function isColorEnabled(): boolean {
	return colourEnabled;
}

/**
 * Replace known tags with SGR escapes. Unknown tags are left alone so a log
 * line containing real markup (`<div>`) survives the round trip untouched.
 */
export function colorize(input: string): string {
	if (!colourEnabled) return stripTags(input);
	// Unbalanced tags are common in hand-written log lines; the stack lets a
	// stray close tag be ignored instead of emitting a bare reset.
	const open: string[] = [];
	const out = input.replace(TAG, (match, slash: string, name: string) => {
		const code = CODES[name];
		if (!code) return match;
		if (slash) {
			const at = open.lastIndexOf(name);
			if (at === -1) return "";
			open.splice(at, 1);
			return `\x1b[${code[1]}m`;
		}
		open.push(name);
		return `\x1b[${code[0]}m`;
	});
	// Close whatever the line left open so the next line starts clean.
	return open.length ? `${out}\x1b[0m` : out;
}

/** Drop the markup without colouring — used when stdout is not a terminal. */
export function stripTags(input: string): string {
	return input.replace(TAG, (match, _slash: string, name: string) => (CODES[name] ? "" : match));
}

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

const LEVELS: Readonly<Record<LogLevel, number>> = {
	debug: 10,
	info: 20,
	warn: 30,
	error: 40,
	silent: 100,
};

let threshold = LEVELS.info;
let sink: (line: string) => void = (line) => console.log(line);

export function setLogLevel(level: LogLevel): void {
	threshold = LEVELS[level] ?? LEVELS.info;
}

/** Redirect output; tests capture lines instead of writing to the terminal. */
export function setLogSink(fn: (line: string) => void): void {
	sink = fn;
}

export function resetLogSink(): void {
	sink = (line) => console.log(line);
}

/** The v1 global: takes markup, writes a coloured line. */
export function CLog(...parts: unknown[]): void {
	if (threshold > LEVELS.info) return;
	sink(colorize(parts.map(stringify).join(" ")));
}

function stringify(value: unknown): string {
	return typeof value === "string" ? value : Bun.inspect(value);
}

function emit(level: Exclude<LogLevel, "silent">, prefix: string, parts: unknown[]): void {
	if (LEVELS[level] < threshold) return;
	sink(colorize(`${prefix} ${parts.map(stringify).join(" ")}`));
}

export const log = {
	debug: (...parts: unknown[]) => emit("debug", "[<gray>DEBUG</gray>]", parts),
	info: (...parts: unknown[]) => emit("info", "[<cyan>INFO</cyan>]", parts),
	warn: (...parts: unknown[]) => emit("warn", "[<yellow>WARN</yellow>]", parts),
	error: (...parts: unknown[]) => emit("error", "[<red>ERROR</red>]", parts),
};

/**
 * Tiny `{placeholder}` interpolator for `Config.General.logFormat`.
 *
 * v1 compiled the log line with the template engine, which dragged the whole
 * renderer onto the request path for one string. Access is flat-key only on
 * purpose — the log line has no business walking arbitrary object graphs.
 */
export function formatLine(format: string, values: Record<string, string | number>): string {
	return format.replace(/\{(\w+)\}/g, (match, key: string) => {
		const value = values[key];
		return value === undefined ? match : String(value);
	});
}
