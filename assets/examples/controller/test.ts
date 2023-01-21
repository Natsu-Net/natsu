/// <reference path="../global.d.ts" />
const Test = new Controller("Test");

Test.Add("user", (ctx) => {
	ctx.response.body = "Prefix Test : user";
});

Test.Add("yolo", (ctx) => {
	ctx.response.body = "Prefix Test : yolo";
});
