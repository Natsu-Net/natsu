const Home = new Controller("Home");

Home.Add("Index", (ctx) => {
	ctx.response.body = `<!doctype html>
<html>
	<head><meta charset="utf-8"><title>natsu v2</title><link rel="stylesheet" href="/style.css"></head>
	<body>
		<h1>natsu v2 on Bun</h1>
		<ul>
			<li><a href="/hello/aiko">/hello/:name</a> — a route parameter</li>
			<li><a href="/json">/json</a> — an object body</li>
			<li><a href="/count">/count</a> — a session counter</li>
			<li><a href="/admin/panel">/admin/panel</a> — refused by a guard</li>
			<li><a href="/admin/panel?key=open-sesame">/admin/panel?key=open-sesame</a> — allowed</li>
			<li><a href="/api/time">/api/time</a> — a decorated controller</li>
			<li><a href="/style.css">/style.css</a> — a static file</li>
		</ul>
	</body>
</html>`;
});

Home.Add("Hello", (ctx) => {
	ctx.response.body = `hello ${ctx.params.name}`;
});

Home.Add("Json", (ctx) => {
	ctx.response.body = { framework: "natsu", version: 2, runtime: `bun ${Bun.version}` };
});

Home.Add("Count", (ctx) => {
	const seen = Number(ctx.session.Get("seen") || 0) + 1;
	ctx.session.Set("seen", seen);
	ctx.response.body = `you have loaded this page ${seen} time(s) — session ${ctx.session.id}`;
});

const Admin = new Controller("Admin");

Admin.Add("Panel", (ctx) => {
	ctx.response.body = "the guard let you through";
});
