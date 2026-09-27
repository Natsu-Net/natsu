/**
 * Networkable state: the decorators, the scopes, and every refusal.
 *
 * The refusals matter more than the happy path. A `@Networked` field is
 * read-only to a client and a method is un-callable until the author opts in,
 * and a socket frame names a store but never a scope — so the tests that prove
 * a write is refused, and that one scope cannot see another's instance, are the
 * ones standing between this and a data leak.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import {
	Action,
	Networked,
	State,
	applyWrite,
	callAction,
	dropScope,
	resetState,
	resolveState,
	snapshotOf,
	stateClass,
	storeOf,
	topicFor,
	watch,
	type StateClass,
} from "../src/state.ts";
import { flushPatches } from "uwu-template/reactive/store";

@State("counter", { scope: "global" })
class Counter {
	@Networked() online = 0;
	@Networked({ writable: true }) topic = "hello";
	/** Not decorated: invisible to the wire in both directions. */
	secret = "shh";

	@Action()
	bump(by = 1) {
		this.online += by;
	}

	/** Deliberately undecorated, to prove `call` refuses it. */
	nuke() {
		this.online = -1;
	}
}

@State("basket")
class Basket {
	@Networked() items = 0;

	@Action()
	add() {
		this.items++;
	}
}

@State("scratch", { scope: "request" })
class Scratch {
	@Networked() n = 0;
}

const AsClass = <T extends object>(c: unknown) => c as StateClass<T>;

beforeEach(() => {
	resetState();
});

describe("the decorators", () => {
	test("a plain assignment produces a patch", () => {
		const counter = resolveState(AsClass<Counter>(Counter), "");
		const seen: Array<{ path: string; value: unknown }> = [];
		watch(counter, (patches) => seen.push(...patches));

		counter.online = 7;
		// Patches are coalesced to the end of the tick; a test that wants to
		// see one without yielding asks for it.
		flushPatches(storeOf(counter));

		expect(seen).toEqual([{ path: "online", value: 7 }]);
		expect(counter.online).toBe(7);
	});

	test("an @Action runs on the server and patches like any other write", () => {
		const counter = resolveState(AsClass<Counter>(Counter), "");
		const seen: Array<{ path: string; value: unknown }> = [];
		watch(counter, (patches) => seen.push(...patches));

		callAction(counter, "bump", [5]);
		flushPatches(storeOf(counter));

		expect(counter.online).toBe(5);
		expect(seen).toEqual([{ path: "online", value: 5 }]);
	});

	test("an undecorated field is not on the wire", () => {
		const counter = resolveState(AsClass<Counter>(Counter), "");
		expect(counter.secret).toBe("shh");
		expect(Object.keys(snapshotOf(counter))).toEqual(["online", "topic"]);
	});

	test("a snapshot is a plain copy, not a live view", () => {
		const counter = resolveState(AsClass<Counter>(Counter), "");
		const before = snapshotOf(counter);
		counter.online = 42;
		expect(before.online).toBe(0);
		expect(snapshotOf(counter).online).toBe(42);
	});
});

describe("refusals", () => {
	test("a client write to a writable field is accepted", () => {
		const counter = resolveState(AsClass<Counter>(Counter), "");
		expect(applyWrite(counter, "topic", "changed")).toBe(true);
		expect(counter.topic).toBe("changed");
	});

	test("a client write to a read-only field is refused", () => {
		const counter = resolveState(AsClass<Counter>(Counter), "");
		expect(applyWrite(counter, "online", 999)).toBe(false);
		expect(counter.online).toBe(0);
	});

	test("a client write to an undeclared field is refused", () => {
		const counter = resolveState(AsClass<Counter>(Counter), "");
		expect(applyWrite(counter, "secret", "leaked")).toBe(false);
		expect(applyWrite(counter, "invented", 1)).toBe(false);
		expect(counter.secret).toBe("shh");
	});

	test("a dotted path is refused even under a writable field", () => {
		// `topic` is writable, but `topic.anything` reaches into a shape the
		// author never declared. Whole fields only.
		const counter = resolveState(AsClass<Counter>(Counter), "");
		expect(applyWrite(counter, "topic.length", 0)).toBe(false);
	});

	test("calling a method that is not an @Action throws", () => {
		const counter = resolveState(AsClass<Counter>(Counter), "");
		expect(() => callAction(counter, "nuke", [])).toThrow(/not an @Action/);
		expect(counter.online).toBe(0);
	});

	test("calling something that is not a method at all throws", () => {
		const counter = resolveState(AsClass<Counter>(Counter), "");
		expect(() => callAction(counter, "online", [])).toThrow();
		expect(() => callAction(counter, "constructor", [])).toThrow(/not an @Action/);
	});
});

describe("scopes", () => {
	test("a global store is one instance for everybody", () => {
		const a = resolveState(AsClass<Counter>(Counter), "session-a");
		const b = resolveState(AsClass<Counter>(Counter), "session-b");
		expect(a).toBe(b);

		a.online = 3;
		expect(b.online).toBe(3);
	});

	test("a session store is one instance per session, and they do not see each other", () => {
		const a = resolveState(AsClass<Basket>(Basket), "session-a");
		const b = resolveState(AsClass<Basket>(Basket), "session-b");
		expect(a).not.toBe(b);

		a.items = 4;
		expect(b.items).toBe(0);
	});

	test("the same session gets the same instance back", () => {
		expect(resolveState(AsClass<Basket>(Basket), "s")).toBe(resolveState(AsClass<Basket>(Basket), "s"));
	});

	test("a session store with no session is an error, not a shared one", () => {
		// The dangerous failure would be quietly falling back to a global
		// instance, which is one person's basket handed to everybody.
		expect(() => resolveState(AsClass<Basket>(Basket), "")).toThrow(/needs a session/);
	});

	test("a request store is fresh every time and never kept", () => {
		const a = resolveState(AsClass<Scratch>(Scratch), "s");
		const b = resolveState(AsClass<Scratch>(Scratch), "s");
		expect(a).not.toBe(b);
	});

	test("dropping a scope forgets its instance", () => {
		const before = resolveState(AsClass<Basket>(Basket), "s");
		before.items = 9;
		dropScope("s");
		expect(resolveState(AsClass<Basket>(Basket), "s").items).toBe(0);
	});
});

describe("topics", () => {
	test("a global store has one topic and a session store has one each", () => {
		expect(topicFor(AsClass(Counter), "anything")).toBe("uwu:counter");
		expect(topicFor(AsClass(Basket), "session-a")).toBe("uwu:basket:session-a");
		expect(topicFor(AsClass(Basket), "session-b")).toBe("uwu:basket:session-b");
	});

	test("two sessions never share a topic", () => {
		expect(topicFor(AsClass(Basket), "a")).not.toBe(topicFor(AsClass(Basket), "b"));
	});
});

describe("the registry", () => {
	test("a class is found by its wire key", () => {
		expect(stateClass("counter")).toBe(AsClass(Counter));
		expect(stateClass("basket")).toBe(AsClass(Basket));
	});

	test("an unknown key resolves to nothing rather than throwing", () => {
		expect(stateClass("nope")).toBeUndefined();
	});

	test("storeOf refuses an object that is not a @State class", () => {
		expect(() => storeOf({})).toThrow(/not a @State class/);
	});
});
