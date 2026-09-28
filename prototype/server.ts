/**
 * End-to-end prototype: Bun.serve + uwu-template precise-targeting hydration +
 * a WebSocket carrying patches, driven by the decorator API.
 *
 * What this demonstrates:
 *   - a server-side field write lands in the exact text node that printed it
 *   - one row of a live list updates without disturbing its siblings
 *   - an attribute-bound value updates its element, not a text range
 *   - a bound input writes back, and a read-only field refuses the write
 *   - none of it re-renders the page
 */

import { compile } from "uwu-template";
import {
	beginRender,
	endRender,
	serializeManifest,
} from "uwu-template/reactive/bindings";
import { isWritable, snapshot } from "uwu-template/reactive/store";
import { Action, Networked, State, callAction, storeOf, watch } from "./state.ts";

// --- application state -----------------------------------------------------

@State("room", { scope: "global" })
class Room {
	@Networked() online = 0;
	@Networked({ writable: true }) topic = "bun + uwu";
	@Networked() theme = "calm";
	@Networked() items = [
		{ name: "alpha", qty: 1 },
		{ name: "beta", qty: 2 },
		{ name: "gamma", qty: 3 },
	];

	@Action()
	bump(by = 1) {
		this.online += by;
	}

	/** Touch exactly one field of one row — the precise-targeting case. */
	@Action()
	renameRow(index: number, name: string) {
		const store = storeOf(this) as unknown as {
			items: Array<{ name: string }>;
		};
		if (store.items[index]) store.items[index].name = name;
	}

	@Action()
	addRow() {
		const store = storeOf(this) as unknown as {
			items: Array<{ name: string; qty: number }>;
		};
		const next = snapshot(store.items);
		next.push({ name: `row-${next.length}`, qty: next.length });
		store.items = next;
	}

	@Action()
	setTheme(theme: string) {
		this.theme = theme;
	}
}

const room = new Room();

// --- template --------------------------------------------------------------
// Ordinary uwu-template syntax throughout. Nothing in the markup says which
// values are live; that is decided by the data the controller passes.

const PAGE = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>{{title}}</title></head>
<body class="{{room.theme}}">
  <h1>{{title}}</h1>
  <p id="static">This paragraph is plain data and is never hydrated.</p>

  <p>online: <b id="online">{{room.online}}</b></p>
  <p>topic: <i id="topic">{{room.topic}}</i></p>
  <input id="topic-input" value="{{room.topic}}">

  <ul id="rows">{{#each room.items}}<li data-name="{{name}}">{{name}} x{{qty}}</li>{{/each}}</ul>

  <button id="bump">bump</button>
  __STATE__
  <script type="module" src="/_uwu/client.js"></script>
</body>
</html>`;

const renderPage = compile(PAGE, { escape: true, reactive: true });

function renderHTML(): string {
	const context = beginRender();
	const html = renderPage({ title: "natsu x uwu", room: storeOf(room) });
	const manifest = endRender(context);
	return html.replace("__STATE__", serializeManifest(manifest));
}

// --- transport -------------------------------------------------------------

const TOPIC = "state:room";

const clientBundle = await Bun.build({
	entrypoints: ["./client.ts"],
	target: "browser",
	minify: true,
});
const clientJS = await clientBundle.outputs[0].text();
console.log(`client runtime: ${(clientJS.length / 1024).toFixed(1)} KB minified`);

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
			return srv.upgrade(request)
				? undefined
				: new Response("expected a websocket", { status: 400 });
		}
		return new Response("not found", { status: 404 });
	},
	websocket: {
		open(ws) {
			ws.subscribe(TOPIC);
		},
		message(ws, raw) {
			let frame: Record<string, unknown>;
			try {
				frame = JSON.parse(String(raw)) as Record<string, unknown>;
			} catch {
				return;
			}

			// A reconnecting client asks for a snapshot, so a patch it missed
			// while offline cannot leave the page quietly wrong.
			if (frame.t === "hello") {
				ws.send(JSON.stringify({
					t: "sync",
					store: "room",
					value: snapshot(storeOf(room)),
				}));
				return;
			}

			if (frame.t === "call" && typeof frame.method === "string") {
				try {
					callAction(room, frame.method, (frame.args as unknown[]) ?? []);
				} catch (error) {
					console.warn("refused action:", (error as Error).message);
				}
				return;
			}

			if (frame.t === "set" && typeof frame.key === "string") {
				// Writability is re-checked here whatever the client believes:
				// the manifest hint is for the UI, never the authority.
				if (!isWritable(storeOf(room), frame.key)) {
					console.warn(`refused client write to room.${frame.key}`);
					return;
				}
				(storeOf(room) as Record<string, unknown>)[frame.key] = frame.value;
			}
		},
	},
});

// Every committed mutation fans out to all subscribers of the topic.
watch(room, (patches) => {
	server.publish(TOPIC, JSON.stringify({ t: "patch", store: "room", patches }));
});

console.log(`listening on ${server.url}`);

// Drive a change from the server with nobody asking for it, to prove the push
// direction works on its own.
setInterval(() => room.bump(), 300);

export { room, server };
