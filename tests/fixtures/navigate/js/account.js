// A ticking clock: what a mount must clean up, or intervals pile up.
natsu.mount("[data-clock]", (el) => {
	window.__clocks = (window.__clocks || 0) + 1;
	const timer = setInterval(() => {
		el.textContent = String(+el.textContent + 1);
	}, 50);
	return () => {
		clearInterval(timer);
		window.__clocks--;
	};
});
