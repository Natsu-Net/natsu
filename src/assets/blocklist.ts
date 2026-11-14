import type { AssetRule, BlockMatcher } from "./contract.ts";

export function blockMatcher(rules: AssetRule[] | undefined): BlockMatcher {
	if (rules === undefined || rules.length === 0) return () => false;
	const exact = new Set<string>();
	const prefixes: string[] = [];
	const patterns: RegExp[] = [];
	for (const rule of rules) {
		if (typeof rule === "string") {
			if (rule.endsWith("*")) prefixes.push(rule.slice(0, -1));
			else exact.add(rule);
		} else if (rule instanceof RegExp) {
			patterns.push(rule);
		} else {
			throw new Error(`block rule must be a string or a RegExp, got ${typeof rule}`);
		}
	}
	const matches = (ref: string): boolean => {
		if (exact.has(ref)) return true;
		for (const prefix of prefixes) if (ref.startsWith(prefix)) return true;
		return false;
	};
	return (ref: string): boolean => {
		if (typeof ref !== "string") return false;
		if (matches(ref)) return true;
		if (ref.startsWith("//") && matches(`https:${ref}`)) return true;
		for (const pattern of patterns) {
			pattern.lastIndex = 0;
			const hit = pattern.test(ref);
			pattern.lastIndex = 0;
			if (hit) return true;
		}
		return false;
	};
}
