/// <reference path="../global.d.ts" />
const Home = new Controller("Home");

Home.Add("Home", async (ctx) => {
	ctx.session.Set("user", "Aiko");

	ctx.response.body = await ctx.templates.renderView("pages/index",{
		name : "Home" + ctx.session.Get("user"),
	});
});

// add test page
Home.Add("Test", (ctx) => {
	ctx.response.body = "asdasd";
});

Home.Add("Dynamic", (ctx) => {
	ctx.response.body = "Home : " + ctx.params.id;
});