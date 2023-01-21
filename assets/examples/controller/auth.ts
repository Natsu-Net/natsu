/// <reference path="../global.d.ts" />
import { DiscordAPI } from "../libs/discord.ts";

const AuthController = new Controller("Auth");

AuthController.Add("login", function (ctx) {
	ctx.response.redirect(DiscordAPI.GetRedirectURL());
});

AuthController.Add("authcode", async (ctx) => {
	const param = await ctx.helpers.getQuery(ctx);
	// Redirect if no code found or User already connect
	if (ctx.session.Get("user")) return ctx.response.redirect("/");
	if (typeof param["code"] === "undefined") return ctx.response.redirect("/");
	const discordRES = await DiscordAPI.ExchangeCode(param["code"]);

	// redirect if error
	if (discordRES.error_description) return ctx.response.redirect(Config.General.url);
	discordRES.expiresat = Math.floor(Date.now() / 1000) + discordRES.expires_in;

	// Set Discord Data in the Session
	ctx.session.Set("discordData", discordRES);
	ctx.session.Set("access_token", discordRES.access_token);

	// get User Data & guilds
	const user = await DiscordAPI.APIRequest("/users/@me", null, "GET", {
		Authorization: "Bearer " + discordRES.access_token,
	});

	const userGuilds = await DiscordAPI.APIRequest("/users/@me/guilds", null, "GET", {
		Authorization: "Bearer " + discordRES.access_token,
	});

	// Looking for user in db
	// const userDB = await User.find(user.id);
	// if (typeof userDB === "undefined") {
	// 	// Create User in db if not found
	// 	User.create({
	// 		id: user.id,
	// 		username: user.username,
	// 		email: user.email,
	// 		group: 3,
	// 		avatar: `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}`,
	// 		code: null,
	// 		code_use: null,
	// 		code_date: null,
	// 	});
	// } else {
	// 	// Update user info
	// 	userDB.email = user.email;
	// 	userDB.username = user.username;
	// 	userDB.avatar = `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}`;
	// 	await userDB.update();
	// }

	// if (user.group == 3) {
	// 	if (
	// 		// deno-lint-ignore no-explicit-any
	// 		typeof user.guilds.find(function (v: any) {
	// 			return v.id == "510274000488890368";
	// 		}) !== "undefined"
	// 	)
	// 		user.group = 2;
	// }

	// Set User Data & guild
	ctx.session.Set("user", user);
	ctx.session.Set("userGuilds", userGuilds);

	ctx.response.redirect("/");
});
