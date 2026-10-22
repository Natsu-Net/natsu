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
 *                     { t: "watch", tags: "<signed tags>" | ["<signed tags>", …] }   (natsu's own runtime)
 *   server -> client  { t: "sync",  store, value }
 *                     { t: "patch", store, patches: [{ path, value }] }
 *                     { t: "invalidate", tag }
 *
 * `watch` is live data (see invalidate.ts): the tags a page drew, signed by
 * the server that drew it (one list, or the page's and each live island's);
 * each `watch` replaces the connection's last one.
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

/** Most signed tag lists one `watch` may carry: a page's and its islands'. */
const MAX_LISTS = 16;

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
	ip?: string;
	ended?: boolean;
	tokens?: number;
	refilledAt?: number;
	lastFrameAt?: number;
}

export interface LiveLimits {
	messageRate: number;
	messageBurst: number;
	silenceSeconds: number;
}

let limits: LiveLimits = { messageRate: 0, messageBurst: 1, silenceSeconds: 0 };
let silenceTimer: ReturnType<typeof setInterval> | undefined;
const allSockets = new Set<ServerWebSocket<LiveSocketData>>();

export function configureLive(next: LiveLimits): void {
	limits = next;
	if (silenceTimer) clearInterval(silenceTimer);
	silenceTimer = undefined;
	if (next.silenceSeconds <= 0) return;
	silenceTimer = setInterval(closeSilent, Math.max(250, (next.silenceSeconds * 1000) / 4));
	silenceTimer.unref?.();
}

function closeSilent(): void {
	const cutoff = Date.now() - limits.silenceSeconds * 1000;
	for (const ws of allSockets) {
		if ((ws.data.lastFrameAt ?? 0) > cutoff) continue;
		ws.data.ended = true;
		try {
			ws.close(4408, "silent");
		} catch {}
	}
}

function withinRate(data: LiveSocketData): boolean {
	if (limits.messageRate <= 0) return true;
	const now = Date.now();
	const last = data.refilledAt ?? now;
	const tokens = Math.min(limits.messageBurst, (data.tokens ?? limits.messageBurst) + ((now - last) / 1000) * limits.messageRate);
	data.refilledAt = now;
	if (tokens < 1) {
		data.tokens = 0;
		return false;
	}
	data.tokens = tokens - 1;
	return true;
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
	closeSocketsOf(sessionId);
	stopPublishing(sessionId);
	revokeSession(sessionId);
	dropScope(sessionId);
}

const socketsBySession = new Map<string, Set<ServerWebSocket<LiveSocketData>>>();

function trackSocket(ws: ServerWebSocket<LiveSocketData>): void {
	const id = ws.data.scopeId;
	if (!id) return;
	const set = socketsBySession.get(id) ?? new Set();
	set.add(ws);
	socketsBySession.set(id, set);
}

function untrackSocket(ws: ServerWebSocket<LiveSocketData>): void {
	const id = ws.data.scopeId;
	const set = id ? socketsBySession.get(id) : undefined;
	if (!set) return;
	set.delete(ws);
	if (set.size === 0) socketsBySession.delete(id);
}

function closeSocketsOf(sessionId: string): void {
	const set = socketsBySession.get(sessionId);
	if (!set) return;
	socketsBySession.delete(sessionId);
	for (const ws of set) {
		ws.data.ended = true;
		try {
			ws.close(4401, "session ended");
		} catch {}
	}
}

/** Forget every subscription. Tests and hot reload. */
export function resetLive(): void {
	allSockets.clear();
	if (silenceTimer) clearInterval(silenceTimer);
	silenceTimer = undefined;
	for (const stop of publishing.values()) stop();
	publishing.clear();
	hooks = {};
	socketsByIp.clear();
	socketsBySession.clear();
}

const socketsByIp = new Map<string, number>();

export function ipKey(ip: string): string {
	if (!ip.includes(":")) return ip;
	const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
	if (mapped) return mapped[1]!;
	const [head = "", tail] = ip.split("::");
	const front = head === "" ? [] : head.split(":");
	const back = tail === undefined || tail === "" ? [] : tail.split(":");
	const groups = tail === undefined ? front : [...front, ...Array(Math.max(0, 8 - front.length - back.length)).fill("0"), ...back];
	return groups.slice(0, 4).map((g) => g.toLowerCase().replace(/^0+(?=.)/, "")).join(":") + "::/64";
}

export function socketCountFor(ip: string): number {
	return socketsByIp.get(ipKey(ip)) ?? 0;
}

function releaseIp(ip: string | undefined): void {
	if (!ip) return;
	const key = ipKey(ip);
	const left = (socketsByIp.get(key) ?? 0) - 1;
	if (left > 0) socketsByIp.set(key, left);
	else socketsByIp.delete(key);
}

export interface OriginPolicy {
	allowed?: readonly string[];
	requireOrigin?: boolean;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function hostOf(value: string): string | undefined {
	try {
		return new URL(value.includes("://") ? value : `http://${value}`).host;
	} catch {
		return undefined;
	}
}

function browserLike(request: Request): boolean {
	const { headers } = request;
	if (headers.has("sec-fetch-mode") || headers.has("sec-fetch-site") || headers.has("sec-fetch-dest")) return true;
	return (headers.get("user-agent") ?? "").startsWith("Mozilla/");
}

export function sameOriginSocket(request: Request, publicUrl: string, policy: OriginPolicy = {}): boolean {
	const origin = request.headers.get("origin");
	if (origin === null) return !(policy.requireOrigin ?? true) || !browserLike(request);
	let originHost: string;
	try {
		originHost = new URL(origin).host;
	} catch {
		return false;
	}
	if (originHost === hostOf(publicUrl)) return true;
	for (const entry of policy.allowed ?? []) {
		if (originHost === hostOf(entry)) return true;
	}
	const requestHost = request.headers.get("host");
	return originHost === requestHost && LOOPBACK_HOSTS.has(new URL(`http://${originHost}`).hostname);
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
			trackSocket(ws);
			ws.data.lastFrameAt = Date.now();
			allSockets.add(ws);
			try {
				hooks.open?.(callerOf(ws.data));
			} catch (error) {
				log.warn(`[<yellow>live</yellow>] open hook threw: ${(error as Error).message}`);
			}
		},

		message(ws: ServerWebSocket<LiveSocketData>, raw: string | Buffer) {
			if (!isLive(ws)) return next?.message?.(ws as never, raw as never);
			if (ws.data.ended) return;
			ws.data.lastFrameAt = Date.now();
			if (!withinRate(ws.data)) {
				ws.data.ended = true;
				ws.close(4429, "too many frames");
				return;
			}

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
				// One signed list per thing on the page that drew live data: the
				// page's own, then each live island's. A list that does not verify
				// is dropped alone.
				const lists = Array.isArray(frame.tags) ? frame.tags.slice(0, MAX_LISTS) : [frame.tags];
				const tags = lists.flatMap((list: unknown) => verifyTags(list) ?? []);
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
			releaseIp(ws.data.ip);
			untrackSocket(ws);
			allSockets.delete(ws);
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
	ip = "",
): Response | undefined {
	const upgraded = server.upgrade(request, {
		data: { live: true, scopeId, session, topics: new Set<string>(), ip },
	});
	if (!upgraded) return new Response("expected a websocket", { status: 400 });
	if (ip) socketsByIp.set(ipKey(ip), socketCountFor(ip) + 1);
	return undefined;
}
