/// <reference lib="dom" />
/**
 * The browser half of the live link: the client for `src/live.ts`.
 *
 * uwu-template 1.x shipped this as `uwu-template/live`, together with a
 * hydrator that patched marked-up text nodes in place. uwu 2 is a template
 * engine only — its reactive store stays as a host-side tool and the wire is
 * natsu's — so the client moved here, without the hydrator: a page holds a
 * store by its wire name, reads it as a plain object, and redraws what it
 * shows when a listener says it changed.
 *
 *   import { live } from "natsu/src/client/live.ts";
 *
 *   const link = live({ stores: ["party:abc-123"] });
 *   link.on("party:abc-123", (party, paths) => draw(party));
 *   link.call("party:abc-123", "say", "hello");
 *
 * Everything else exists to make that behave on a real network: reconnect
 * with backoff, a fresh `hello` after a drop so the server re-sends every
 * store whole (a missed patch cannot leave the page subtly wrong), and
 * outbound batching per microtask so a burst of writes is one frame each.
 *
 * Wire protocol: see `src/live.ts`.
 */

/** One change, as the server sends it: a dotted path and its new value. */
export interface LivePatch {
	path: string;
	value: unknown;
}

export interface LiveOptions {
	/** Wire names of the stores this page holds (`party:abc-123`, `room`). */
	stores?: string[];
	/** Socket URL. Defaults to `/_uwu/socket` on the current origin. */
	url?: string;
	/** Retry backoff bounds, in milliseconds. */
	minBackoff?: number;
	maxBackoff?: number;
	/** Called on every connection state change. */
	onStatus?: (status: LiveStatus) => void;
}

export type LiveStatus = "connecting" | "open" | "reconnecting" | "closed";

/**
 * Called after a store changed. `paths` are the patched paths, or `["*"]`
 * when the server sent the store whole (the first answer, and after every
 * reconnect).
 */
export type LiveListener = (value: Record<string, unknown>, paths: string[]) => void;

export interface LiveConnection {
	readonly status: LiveStatus;
	/** Current values by wire name. A store is `{}` until its first `sync`. */
	readonly stores: Record<string, Record<string, unknown>>;
	/** Listen for changes to one store. Returns an unsubscribe function. */
	on(store: string, listener: LiveListener): () => void;
	/** Invoke a server-side `@Action`. */
	call(store: string, method: string, ...args: unknown[]): void;
	/** Write a field the state class marked writable. */
	set(store: string, key: string, value: unknown): void;
	/** Close the socket and stop retrying. */
	close(): void;
}

interface ServerFrame {
	t: string;
	store?: string;
	patches?: LivePatch[];
	value?: Record<string, unknown>;
}

type ClientFrame =
	| { t: "hello"; stores: string[] }
	| { t: "set"; store: string; key: string; value: unknown }
	| { t: "call"; store: string; method: string; args: unknown[] };

export function live(options: LiveOptions = {}): LiveConnection {
	const url = options.url ?? `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/_uwu/socket`;
	const minBackoff = options.minBackoff ?? 250;
	const maxBackoff = options.maxBackoff ?? 10_000;

	const stores: Record<string, Record<string, unknown>> = {};
	for (const name of options.stores ?? []) stores[name] = {};
	const listeners = new Map<string, Set<LiveListener>>();

	let socket: WebSocket | null = null;
	let status: LiveStatus = "connecting";
	let backoff = minBackoff;
	let closed = false;
	let retryTimer: ReturnType<typeof setTimeout> | undefined;

	// Writes are keyed, so holding a key down sends the latest value once;
	// calls are keyed by their place in the queue, so none is dropped.
	const outbound = new Map<string, ClientFrame>();
	let calls = 0;
	let flushQueued = false;

	function setStatus(next: LiveStatus): void {
		if (status === next) return;
		status = next;
		options.onStatus?.(next);
	}

	function queue(key: string, frame: ClientFrame): void {
		outbound.set(key, frame);
		if (flushQueued) return;
		flushQueued = true;
		queueMicrotask(flush);
	}

	function flush(): void {
		flushQueued = false;
		if (socket?.readyState !== WebSocket.OPEN) return;
		for (const frame of outbound.values()) socket.send(JSON.stringify(frame));
		outbound.clear();
	}

	function notify(store: string, paths: string[]): void {
		const value = stores[store];
		if (!value) return;
		for (const listener of listeners.get(store) ?? []) {
			try {
				listener(value, paths);
			} catch (error) {
				// One broken listener must not stop the others or the socket.
				console.error(error);
			}
		}
	}

	function receive(frame: ServerFrame): void {
		const name = frame.store;
		if (typeof name !== "string" || !(name in stores)) return;
		if (frame.t === "sync" && frame.value && typeof frame.value === "object") {
			const value = stores[name]!;
			for (const key of Object.keys(value)) delete value[key];
			Object.assign(value, frame.value);
			notify(name, ["*"]);
		} else if (frame.t === "patch" && Array.isArray(frame.patches)) {
			const value = stores[name]!;
			for (const patch of frame.patches) setPath(value, patch.path, patch.value);
			notify(name, frame.patches.map((patch) => patch.path));
		}
	}

	function connect(): void {
		if (closed) return;
		const ws = (socket = new WebSocket(url));
		ws.addEventListener("open", () => {
			backoff = minBackoff;
			setStatus("open");
			// Ask for every store whole. On a first connection that confirms
			// what the server painted; after a drop it repairs whatever changed
			// while the page was away.
			ws.send(JSON.stringify({ t: "hello", stores: Object.keys(stores) } satisfies ClientFrame));
			flush();
		});
		ws.addEventListener("message", (event) => {
			let frame: ServerFrame;
			try {
				frame = JSON.parse(String(event.data)) as ServerFrame;
			} catch {
				return;
			}
			if (frame && typeof frame === "object") receive(frame);
		});
		ws.addEventListener("close", retry);
		ws.addEventListener("error", () => ws.close());
	}

	function retry(): void {
		if (closed) return;
		setStatus("reconnecting");
		// Full jitter, so everyone who dropped together does not come back together.
		retryTimer = setTimeout(() => {
			backoff = Math.min(backoff * 2, maxBackoff);
			connect();
		}, minBackoff + Math.random() * backoff);
	}

	connect();

	return {
		get status() {
			return status;
		},
		stores,
		on(store, listener) {
			let set = listeners.get(store);
			if (!set) listeners.set(store, (set = new Set()));
			set.add(listener);
			return () => void set.delete(listener);
		},
		call(store, method, ...args) {
			queue(`call:${calls++}`, { t: "call", store, method, args });
		},
		set(store, key, value) {
			queue(`set:${store}:${key}`, { t: "set", store, key, value });
		},
		close() {
			closed = true;
			clearTimeout(retryTimer);
			setStatus("closed");
			socket?.close();
		},
	};
}

/** `items.2.name` on a plain object; a missing branch is made on the way. */
function setPath(root: Record<string, unknown>, path: string, value: unknown): void {
	const parts = path.split(".");
	const last = parts.pop();
	if (last === undefined || last === "") return;
	let at: Record<string, unknown> = root;
	for (const part of parts) {
		if (isUnsafe(part)) return;
		let next = at[part];
		if (next === null || typeof next !== "object") at[part] = next = {};
		at = next as Record<string, unknown>;
	}
	if (isUnsafe(last)) return;
	at[last] = value;
}

/** A path from the wire never reaches a prototype. */
function isUnsafe(key: string): boolean {
	return key === "__proto__" || key === "constructor" || key === "prototype";
}
