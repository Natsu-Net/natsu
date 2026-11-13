import { mount } from "../../../../src/client/mount.ts";

mount("[data-editor]", () => import("./editor.ts"));

document.addEventListener("click", (event) => {
	if (!(event.target instanceof Element) || !event.target.matches("[data-add]")) return;
	const host = document.createElement("div");
	host.id = "added";
	host.setAttribute("data-editor", "");
	document.querySelector("main")!.append(host);
});
