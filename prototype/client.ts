/**
 * Client half of the prototype: hydrate the server markup, then keep the
 * signals in sync over the socket.
 */

import { hydrate } from "uwu-template/client";
import type { Patch } from "uwu-template/reactive/store";

const root = hydrate(document);

const socket = new WebSocket(
	`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/_uwu/socket`,
);

socket.addEventListener("message", (event) => {
	const frame = JSON.parse(event.data) as {
		t: string;
		store: string;
		patches: Patch[];
	};
	if (frame.t === "patch") root.patch(frame.store, frame.patches);
});

document.getElementById("bump")?.addEventListener("click", () => {
	socket.send(JSON.stringify({ t: "call", store: "room", method: "bump", args: [5] }));
});

// Expose for the end-to-end assertions.
(globalThis as Record<string, unknown>).__uwu = { root, socket };
