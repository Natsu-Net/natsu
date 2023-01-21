// deno-lint-ignore-file
/// <reference path="../global.d.ts" />
var _encode = function (obj: any) {
	let string = "";
	for (const [key, value] of Object.entries(obj)) {
		if (!value) continue;
		string += `&${encodeURIComponent(key)}=${encodeURIComponent(value as any)}`;
	}

	return string.substring(1);
};

class DiscordAPI {
	private config: any = {};

	constructor(config: any) {
		this.config = config;
		return this;
	}
	/**
	 * @param  {string} url
	 * @param  {any} data?
	 * @param  {string} method?
	 * @param  {any} headers?
	 */
	public APIRequest = async (url: string, data?: any, method?: string, headers?: any) => {
		var body: any = "";
		var meth: any = "GET";
		var head: any = {};

		if (data) {
			body = await new URLSearchParams(data);
		}
		if (method) {
			meth = method;
		}
		if (headers) {
			head = headers;
		}

		if (body) {
			const res = await fetch(this.config.API_ENDPOINT + url, {
				method: meth,
				headers: head,
				body: body ?? null,
			});
			return res.json();
		} else {
			const res = await fetch(this.config.API_ENDPOINT + url, {
				method: meth,
				headers: head,

			});
			return res.json();
		}
	};

	/**
	 * Get Discord login redirect url
	 */
	public GetRedirectURL = () => {
		const urlparam = _encode({
			client_id: this.config.CLIENT_ID,
			redirect_uri: this.config.REDIRECT_URI,
			response_type: "code",
			scope: "identify email guilds",
		});
		return `https://discord.com/api/oauth2/authorize?${urlparam}`;
	};
	/**
	 * Exchange code with discord api
	 * @param  {string} code
	 */
	public ExchangeCode = async (code: string) => {
		const data = {
			client_id: this.config.CLIENT_ID,
			client_secret: this.config.CLIENT_SECRET,
			grant_type: "authorization_code",
			redirect_uri: this.config.REDIRECT_URI,
			code: code,
			scope: "identify email guilds",
		};

		const res: any = await fetch("https://discord.com/api/v10/oauth2/token", {
			method: "POST",
			body: _encode(data),
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
			},
		});
		return await res.json();
	};
}
const Discord = new DiscordAPI(Config.Discord);

export {Discord as DiscordAPI, _encode};
