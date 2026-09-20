/// <reference types="bun" />

const Routes = new Router();

Routes.get("/", "Home@Index");
Routes.get("/hello/:name", "Home@Hello");
Routes.get("/json", "Home@Json");
Routes.get("/count", "Home@Count");

// A group behind a guard. v1 semantics: the route runs only if the guard
// returns something truthy.
Routes.Prefix(
	"/admin",
	(admin) => {
		admin.get("/panel", "Admin@Panel");
	},
	(ctx) => ctx.query.key === "open-sesame",
);
