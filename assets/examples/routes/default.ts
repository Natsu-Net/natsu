/// <reference path="../global.d.ts" />
const Routes = new Router("127.0.0.1:8083");
// default home page
Routes.get("/", "Home@Home");
Routes.get("/user", "Home@Test");
// prefix for router
Routes.Prefix("/test",
	(SubRouter) => {
		SubRouter.get("/user", "Test@user");
		SubRouter.get("/yolo", "Test@yolo");
	},
    (_ctx) => {
        return false
    }
);

// User Auth Handler
Routes.get("/user/login", "Auth@login");

Routes.get("/user/authcode", "Auth@authcode");