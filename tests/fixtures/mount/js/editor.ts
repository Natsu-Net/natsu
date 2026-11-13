export function mount(el: Element, signal: AbortSignal): () => void {
	const drawn = document.createElement("p");
	drawn.className = "ed";
	drawn.textContent = signal.aborted ? "" : "drawn";
	el.append(drawn);
	return () => drawn.remove();
}
