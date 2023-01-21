let config = {
	"General": {
		"url": "http://127.0.0.1:8083",
		"bantime": 300,
		"proxy": false,
		"port": 8083,
		"listenOn": "0.0.0.0",
		"logFormat": ""
	},
	"Cache" : {
		"enablePublicCache": true,
		"publicCacheTTL": 900,
		"autoUpdatePublicCache": true,
		"logPublicHit": true,
	},
	"MySQL": {
		"host": "",
		"database": "",
		"username": "",
		"password": "",
		"charset": ""
	},
	"Session" : {
		"CookieName": "NASTU_SESSION",
		"driver": "mysql",
	}
};
try {
    config = JSON.parse(await Deno.readTextFile(`${Deno.cwd()}/config.json`));
} catch (_error) {
	console.log("No config file found, using default config");
}

export { config };
