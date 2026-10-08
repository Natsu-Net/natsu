/**
 * The live link: the server half of uwu-template's `live()`.
 *
 * One WebSocket at `/_uwu/socket`. A client says which stores it is holding,
 * the server sends a snapshot of each and then streams patches as they happen;
 * the client may write a field or call a method, and both are refused unless
 * the state class opted in.
 *
 * Wire protocol, matching `uwu-template/live`:
 *
 *   client -> server  { t: "hello", stores: string[] }
 *                     { t: "set",  store, key, value }
 *                     { t: "call", store, method, args }
 *                     { t: "watch", tags: "<signed tags>" }   (natsu's own runtime)
 *   server -> client  { t: "sync",  store, value }
 *                     { t: "patch", store, patches: [{ path, value }] }
 *                     { t: "invalidate", tag }
 *
 * `watch` is live data (see invalidate.ts): the tags a page drew, signed by
 * the server that drew it; each `watch` replaces the connection's last one.
 *
 * **A frame never names a scope.** It names a store by its class key; which
 * instance that is comes from the connection — the session it authenticated
 * as. That is the whole isolation model, and it means a client cannot reach
 * another person's state by asking nicely, because there is no field in the
 * protocol with which to ask.
 *
 * Fan-out is Bun's own pub/sub: one `server.publish` per topic, so a global
 * store with ten thousand listeners is one call, not ten thousand sends.
 */

import type { ServerWebSocket } from "bun";

/**
 * The two things this layer needs from a running server.
 *
 * Structural rather than Bun's `Server<T>`, which is invariant in its
 * socket-data type: an app that types its own sockets would otherwise be
 * unable to hand its server to natsu at all.
 */
export interface LiveServer {
	publish(topic: string, data: string): number;
	// Data is required, not optional: a server whose sockets carry data has
	// no meaningful upgrade without it, and Bun's own typing says so.
	upgrade(request: Request, options: { data: NatsuSocketData; headers?: HeadersInit }): boolean;
}

import type { NatsuSocketData } from "./context.ts";
import { onInvalidate, tagTopic, verifyTags } from "./invalidate.ts";
import { log } from "./logger.ts";
import {
	type Caller,
	type CallerSession,
	type Patch,
	type StateClass,
	applyWrite,
	callAction,
	dropScope,
	hasRoom,
	resolveState,
	revokeSession,
	snapshotOf,
	stateClass,
	topicFor,
	watch,
} from "./state.ts";

/** The path the client runtime connects to. Matches uwu-template's default. */
export const SOCKET_PATH = "/_uwu/socket";

/** What natsu keeps on every live connection. */
export interface LiveSocketData {
	/** Always true on natsu's own sockets. */
	live: true;
	/** Session id, or "" for a client with no session. */
	scopeId: string;
	/** The caller's session, so an @Action can tell who it is serving. */
	session?: CallerSession;
	/** Topics this connection is subscribed to, so close can undo them. */
	topics: Set<string>;
	/** Live-data tag topics, which the next `watch` replaces. */
	tags?: Set<string>;
}

interface ClientFrame {
	t?: unknown;
	store?: unknown;
	key?: unknown;
	value?: unknown;
	method?: unknown;
	args?: unknown;
	stores?: unknown;
	tags?: unknown;
}

/**
 * The server, for publishing.
 *
 * `Bun.serve`'s websocket callbacks are handed the socket, not the server, and
 * publishing needs the server. It is set once at start.
 */
let liveServer: LiveServer | undefined;

export function setLiveServer(server: LiveServer): void {
	liveServer = server;
}

// Live data: an invalidated tag is one frame to every socket watching it.
onInvalidate((tags) => {
	if (!liveServer) return;
	for (const tag of tags) liveServer.publish(tagTopic(tag), JSON.stringify({ t: "invalidate", tag }));
});

/**
 * Patch fan-out, one subscription per (class, scope) pair.
 *
 * Subscribing to a store's patches is a process-wide side effect, so it must
 * happen once however many clients are connected — otherwise the tenth client
 * to open a page makes every write publish ten times.
 */
const publishing = new Map<string, () => void>();

function ensurePublishing(server: LiveServer, found: Addressed): void {
	const topic = topicFor(found.Class, found.scopeId);
	if (publishing.has(topic)) return;

	// The frame names the store the way the client holds it — `party:abc-123`
	// for a room — because that is the key its own store was created under.
	const wire = found.wire;
	// Patches arrive already batched per microtask by the store, so a burst of
	// writes in one tick is one frame on the wire.
	const stop = watch(found.instance, (patches: Patch[]) => {
		server.publish(topic, JSON.stringify({ t: "patch", store: wire, patches }));
	});
	publishing.set(topic, stop);
}

/** Stop publishing for a scope — call when a session ends. */
export function stopPublishing(scopeId: string): void {
	for (const [topic, stop] of publishing) {
		if (!topic.endsWith(`:${scopeId}`)) continue;
		stop();
		publishing.delete(topic);
	}
}

/**
 * A session has ended: forget its state, its room grants and its fan-out.
 *
 * Called by the session manager on destroy and on sweep. Without it every
 * session that ever connected leaves a store, a grant and a live subscription
 * behind — a slow leak that only shows up in production.
 */
export function endSession(sessionId: string): void {
	if (!sessionId) return;
	stopPublishing(sessionId);
	revokeSession(sessionId);
	dropScope(sessionId);
}

/** Forget every subscription. Tests and hot reload. */
export function resetLive(): void {
	for (const stop of publishing.values()) stop();
	publishing.clear();
	hooks = {};
}

/** A store a connection is allowed to address, and where it lives. */
interface Addressed {
	Class: StateClass;
	instance: object;
	/** The key the client holds this store under — `party:abc-123` for a room. */
	wire: string;
	/** The scope id the instance lives under: "" global, session id, or room id. */
	scopeId: string;
}

/**
 * Resolve the instance a frame is talking about, for this connection.
 *
 * Returns undefined rather than throwing for anything the connection may not
 * have: an unknown key, a session-scoped store on a connection with no
 * session, or a room this session was never granted. A socket is a hostile
 * input surface and a thrown error here would take the connection down on a
 * malformed frame.
 */
function instanceFor(data: LiveSocketData, key: unknown): Addressed | undefined {
	if (typeof key !== "string") return undefined;

	const direct = stateClass(key);
	if (direct) {
		// A request-scoped store exists for the length of one render. There is
		// nothing on the wire to talk to.
		if (direct.scope === "request") return undefined;
		// A room store is only ever addressed with its room id attached, below.
		// The bare key names no instance.
		if (direct.scope === "room") return undefined;
		if (direct.scope === "session" && !data.scopeId) return undefined;
		const scopeId = direct.scope === "global" ? "" : data.scopeId;
		try {
			return { Class: direct, instance: resolveState(direct, scopeId), wire: key, scopeId };
		} catch {
			return undefined;
		}
	}

	// `party:abc-123`. The room id came off the client, unlike a session id, so
	// the only thing that makes it addressable is a grant the server issued
	// while it still had the request in hand. Naming a room is not joining it.
	const cut = key.lastIndexOf(":");
	if (cut < 1) return undefined;
	const stateKey = key.slice(0, cut);
	const roomId = key.slice(cut + 1);
	if (!roomId) return undefined;
	const Class = stateClass(stateKey);
	if (!Class || Class.scope !== "room") return undefined;
	if (!data.scopeId || !hasRoom(data.scopeId, stateKey, roomId)) return undefined;
	try {
		return { Class, instance: resolveState(Class, roomId), wire: key, scopeId: roomId };
	} catch {
		return undefined;
	}
}

/**
 * The `websocket` handler for `Bun.serve`.
 *
 * `next` is an app's own handler, if it has one. natsu takes the frames it
 * recognises on its own socket and hands everything else on, so an app that
 * already speaks its own protocol keeps working on the same port.
 */
export function liveWebSocketHandler(next?: Partial<Bun.WebSocketHandler<never>>) {
	return {
		open(ws: ServerWebSocket<LiveSocketData>) {
			if (!isLive(ws)) return next?.open?.(ws as never);
			// Nothing is subscribed until `hello` says which stores the page
			// actually holds: a connection that subscribed to everything would
			// receive patches for state its page never rendered.
			ws.data.topics = new Set();
			try {
				hooks.open?.(callerOf(ws.data));
			} catch (error) {
				log.warn(`[<yellow>live</yellow>] open hook threw: ${(error as Error).message}`);
			}
		},

		message(ws: ServerWebSocket<LiveSocketData>, raw: string | Buffer) {
			if (!isLive(ws)) return next?.message?.(ws as never, raw as never);

			let frame: ClientFrame;
			try {
				frame = JSON.parse(String(raw)) as ClientFrame;
			} catch {
				return;
			}

			if (frame.t === "hello") {
				const asked = Array.isArray(frame.stores) ? frame.stores : [];
				for (const key of asked.slice(0, 64)) {
					const found = instanceFor(ws.data, key);
					if (!found) continue;
					const topic = topicFor(found.Class, found.scopeId);
					// Publishing before subscribing, so a write that lands between
					// the two is not lost between the snapshot and the stream.
					if (liveServer) ensurePublishing(liveServer, found);
					ws.subscribe(topic);
					ws.data.topics.add(topic);
					ws.send(JSON.stringify({ t: "sync", store: found.wire, value: snapshotOf(found.instance) }));
				}
				return;
			}

			if (frame.t === "watch") {
				// Signed by the server that drew the page: a socket watches what a
				// page listed, never a tag it made up. Anything else clears the list.
				const tags = verifyTags(frame.tags) ?? [];
				const next = new Set(tags.map(tagTopic));
				for (const topic of ws.data.tags ?? []) {
					if (next.has(topic)) continue;
					ws.unsubscribe(topic);
					ws.data.topics.delete(topic);
				}
				for (const topic of next) {
					ws.subscribe(topic);
					ws.data.topics.add(topic);
				}
				ws.data.tags = next;
				return;
			}

			if (frame.t === "set") {
				const found = instanceFor(ws.data, frame.store);
				if (!found || typeof frame.key !== "string") return;
				// Re-checked here whatever the client believes. The manifest it
				// holds says which fields the UI should offer to edit; it is not
				// a capability.
				if (!applyWrite(found.instance, frame.key, frame.value)) {
					log.warn(`[<yellow>live</yellow>] refused write to <cyan>${found.wire}.${frame.key}</cyan>`);
				}
				return;
			}

			if (frame.t === "call") {
				const found = instanceFor(ws.data, frame.store);
				if (!found || typeof frame.method !== "string") return;
				const args = Array.isArray(frame.args) ? frame.args : [];
				// An action that cannot tell one caller from another cannot enforce
				// anything — no host check, no per-person rate limit.
				const who: Caller = { sessionId: ws.data.scopeId, session: ws.data.session, room: found.scopeId };
				try {
					callAction(found.instance, frame.method, args, who);
				} catch (error) {
					log.warn(`[<yellow>live</yellow>] refused call ${found.wire}.${frame.method}: ${(error as Error).message}`);
				}
				return;
			}

			// Not ours. An app sharing the socket gets first refusal on
			// anything natsu does not recognise.
			next?.message?.(ws as never, raw as never);
		},

		close(ws: ServerWebSocket<LiveSocketData>, code: number, reason: string) {
			if (!isLive(ws)) return next?.close?.(ws as never, code, reason);
			for (const topic of ws.data.topics ?? []) ws.unsubscribe(topic);
			try {
				hooks.close?.(callerOf(ws.data));
			} catch (error) {
				log.warn(`[<yellow>live</yellow>] close hook threw: ${(error as Error).message}`);
			}
		},

		drain(ws: ServerWebSocket<LiveSocketData>) {
			if (!isLive(ws)) return next?.drain?.(ws as never);
		},
	};
}

/**
 * What an app wants to know about live connections.
 *
 * Presence — who is online right now — is the common case, and it is not
 * something an app can work out for itself: the socket is natsu's, so only
 * natsu sees it open and close.
 */
export interface LiveHooks {
	open?(who: Caller): void;
	close?(who: Caller): void;
}

let hooks: LiveHooks = {};

/** Register connection hooks. Pass `{}` to clear them. */
export function setLiveHooks(next: LiveHooks): void {
	hooks = next;
}

function callerOf(data: LiveSocketData): Caller {
	return { sessionId: data.scopeId, session: data.session };
}

/** Is this one of natsu's live sockets, or an app's own? */
function isLive(ws: ServerWebSocket<LiveSocketData>): boolean {
	return (ws.data as unknown as { live?: boolean })?.live === true;
}

/**
 * Upgrade a request to a live socket, if it is one.
 *
 * `scopeId` is the caller's session id — natsu's server middleware resolves it
 * before calling this, because the session is what decides which state the
 * connection can see.
 */
export function upgradeLive(
	request: Request,
	server: LiveServer,
	scopeId: string,
	session?: CallerSession,
): Response | undefined {
	const upgraded = server.upgrade(request, {
		data: { live: true, scopeId, session, topics: new Set<string>() },
	});
	return upgraded ? undefined : new Response("expected a websocket", { status: 400 });
}
