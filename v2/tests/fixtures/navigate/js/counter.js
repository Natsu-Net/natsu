// Converted: binds per element through natsu.mount. Its document listener
// goes with the signal, so a listener left behind would count a click twice.
natsu.mount("[data-counter]", (el, signal) => {
	window.__mounts = (window.__mounts || 0) + 1;
	document.addEventListener(
		"click",
		(e) => {
			if (!e.target.matches("[data-counter]")) return;
			window.__clicks = (window.__clicks || 0) + 1;
			e.target.textContent = String(+e.target.textContent + 1);
		},
		{ signal },
	);
	return () => {
		window.__cleanups = (window.__cleanups || 0) + 1;
	};
});
