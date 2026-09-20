import { describe, expect, test, afterEach } from "bun:test";
import { CLog, colorize, formatLine, log, setColorEnabled, setLogLevel, setLogSink, stripTags } from "../src/logger.ts";

afterEach(() => {
	setColorEnabled(false);
	setLogLevel("silent");
	setLogSink(() => {});
});

function capture(fn: () => void): string[] {
	const lines: string[] = [];
	setLogSink((line) => lines.push(line));
	fn();
	return lines;
}

describe("colorize", () => {
	test("wraps a known tag in SGR codes", () => {
		setColorEnabled(true);
		expect(colorize("<green>ok</green>")).toBe("\x1b[32mok\x1b[39m");
	});

	test("nesting restores the outer attribute, not everything", () => {
		setColorEnabled(true);
		// The close of <red> must not switch bold off.
		expect(colorize("<bold>a<red>b</red>c</bold>")).toBe("\x1b[1ma\x1b[31mb\x1b[39mc\x1b[22m");
	});

	test("leaves unknown tags alone", () => {
		setColorEnabled(true);
		expect(colorize("<div><red>x</red></div>")).toBe("<div>\x1b[31mx\x1b[39m</div>");
	});

	test("ignores an unmatched close tag", () => {
		setColorEnabled(true);
		expect(colorize("plain</red>")).toBe("plain");
	});

	test("closes anything left open at the end of the line", () => {
		setColorEnabled(true);
		expect(colorize("<cyan>oops")).toBe("\x1b[36moops\x1b[0m");
	});

	test("strips markup when colour is off", () => {
		setColorEnabled(false);
		expect(colorize("[<green>Routes</green>] <cyan>/x</cyan>")).toBe("[Routes] /x");
	});

	test("stripTags keeps unknown tags", () => {
		expect(stripTags("<b>x</b><span>y</span>")).toBe("x<span>y</span>");
	});
});

describe("levels", () => {
	test("a level below the threshold produces nothing", () => {
		setLogLevel("warn");
		const lines = capture(() => {
			log.debug("d");
			log.info("i");
			log.warn("w");
			log.error("e");
		});
		expect(lines).toEqual(["[WARN] w", "[ERROR] e"]);
	});

	test("silent suppresses CLog too", () => {
		setLogLevel("silent");
		expect(capture(() => CLog("anything"))).toEqual([]);
	});

	test("CLog joins its arguments and inspects non-strings", () => {
		setLogLevel("info");
		expect(capture(() => CLog("n =", 42))).toEqual(["n = 42"]);
	});
});

describe("formatLine", () => {
	test("substitutes known keys", () => {
		expect(formatLine("{method} {path} {status}", { method: "GET", path: "/x", status: 200 })).toBe("GET /x 200");
	});

	test("leaves an unknown placeholder as written", () => {
		expect(formatLine("{method} {nope}", { method: "GET" })).toBe("GET {nope}");
	});

	test("a zero value is substituted, not treated as absent", () => {
		expect(formatLine("{ms}ms", { ms: 0 })).toBe("0ms");
	});
});
