/**
 * End-to-end prototype: Bun.serve + uwu-template reactive rendering + a
 * WebSocket carrying patches, driven by the decorator API.
 *
 * The point of this file is to prove the whole loop runs:
 *   server state write -> patch -> socket -> client signal -> text node
 * with no page reload, no virtual DOM, and no framework-specific markup in the
 * template.
 */

import { compile } from "uwu-template";
import {
	beginRender,
	endRender,
	serializeManifest,
} from "uwu-template/reactive/bindings";
import type { Patch } from "uwu-template/reactive/store";
import { isWritable } from "uwu-template/reactive/store";
import { Action, Networked, State, callAction, storeOf, watch } from "./state.ts";

// --- application state -----------------------------------------------------

@State("room", { scope: "global" })
class Room {
	@Networked() online = 0;
	@Networked({ writable: true }) topic = "bun + uwu";

	@Action()
	bump(by = 1) {
		this.online += by;
	}
}

const room = new Room();

// --- template --------------------------------------------------------------
// Note: no directives, no data attributes. Ordinary uwu-template syntax.

const PAGE = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>{{title}}</title></head>
<body>
  <h1>{{title}}</h1>
  <p>online: <b id="online">{{room.online}}</b></p>
  <p>topic: <i id="topic">{{room.topic}}</i></p>
  <button id="bump">bump</button>
  __STATE__
  <script type="module" src="/_uwu/client.js"></script>
</body>
</html>`;

const renderPage = compile(PAGE, { escape: true, reactive: true });

function renderHTML(): string {
	const context = beginRender();
	const html = renderPage({ title: "natsu × uwu", room: storeOf(room) });
	const manifest = endRender(context);
	return html.replace("__STATE__", serializeManifest(manifest));
}

// --- transport -------------------------------------------------------------

const TOPIC = "state:room";

interface Frame {
	t: "patch" | "set" | "call";
	store?: string;
	patches?: Patch[];
	key?: string;
	value?: unknown;
	method?: string;
	args?: unknown[];
}

const clientBundle = await Bun.build({
	entrypoints: ["./client.ts"],
	target: "browser",
	minify: true,
});
const clientJS = await clientBundle.outputs[0].text();

const server = Bun.serve({
	port: 8099,
	routes: {
		"/": () =>
			new Response(renderHTML(), {
				headers: { "content-type": "text/html; charset=utf-8" },
			}),
		"/_uwu/client.js": () =>
			new Response(clientJS, {
				headers: { "content-type": "text/javascript" },
			}),
	},
	fetch(request, srv) {
		if (new URL(request.url).pathname === "/_uwu/socket") {
			return srv.upgrade(request) ? undefined : new Response("no", {
				status: 400,
			});
		}
		return new Response("not found", { status: 404 });
	},
	websocket: {
		open(ws) {
			ws.subscribe(TOPIC);
		},
		message(ws, raw) {
			const frame = JSON.parse(String(raw)) as Frame;

			if (frame.t === "call" && frame.method) {
				// Actions run on the server; the resulting writes fan out as
				// patches through the same watch() below.
				callAction(room, frame.method, frame.args ?? []);
				return;
			}

			if (frame.t === "set" && frame.key !== undefined) {
				// A client write is only honoured for fields marked writable.
				if (!isWritable(storeOf(room), frame.key)) {
					console.warn(`refused client write to room.${frame.key}`);
					return;
				}
				(storeOf(room) as Record<string, unknown>)[frame.key] =
					frame.value;
			}
		},
	},
});

// Every committed mutation fans out to all subscribers of the topic.
watch(room, (patches) => {
	server.publish(TOPIC, JSON.stringify({ t: "patch", store: "room", patches }));
});

console.log(`listening on ${server.url}`);

// Drive a change from the server side, with nobody asking for it, to prove the
// push direction works.
setInterval(() => room.bump(), 300);

export { room, server };
