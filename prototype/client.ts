/**
 * The entire client. `live()` hydrates the server markup, opens the socket,
 * and keeps both directions in sync from there.
 */

import { live } from "uwu-template/live";

const connection = live();

document.getElementById("bump")?.addEventListener("click", () => {
	connection.call("room", "bump", 5);
});

// Exposed so the end-to-end assertions can drive the page.
(globalThis as Record<string, unknown>).__uwu = connection;
