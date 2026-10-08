// Converted: mounts nothing of its own, and loads a converted widget script,
// appended to the body as many loaders do.
natsu.mount(":not(*)", () => {});
const s = document.createElement("script");
s.src = "/w.js";
document.body.append(s);
