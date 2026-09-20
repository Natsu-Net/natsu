/**
 * A deliberately tiny template compiler, for the benchmark only.
 *
 * The shipping framework renders with uwu-template; pulling that in here would
 * measure the engine rather than natsu. Both the natsu app and the bare
 * `Bun.serve` baseline render with *this*, so what the numbers show is the
 * framework's own overhead and nothing else.
 */

const TOKEN = /\{\{(\w+)\}\}/g;

const ESCAPES: Readonly<Record<string, string>> = {
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
	"'": "&#39;",
};

function escape(value: string): string {
	return value.replace(/[&<>"']/g, (char) => ESCAPES[char] ?? char);
}

export type Template = (data: Record<string, unknown>) => string;

/** Compile once into a closure over pre-split literals — no per-render parsing. */
export function compile(source: string): Template {
	const literals: string[] = [];
	const keys: string[] = [];
	let last = 0;

	for (const match of source.matchAll(TOKEN)) {
		literals.push(source.slice(last, match.index));
		keys.push(match[1] as string);
		last = match.index + match[0].length;
	}
	literals.push(source.slice(last));

	return (data) => {
		let out = literals[0] ?? "";
		for (let i = 0; i < keys.length; i++) {
			const value = data[keys[i] as string];
			out += escape(value === undefined || value === null ? "" : String(value));
			out += literals[i + 1] ?? "";
		}
		return out;
	};
}
