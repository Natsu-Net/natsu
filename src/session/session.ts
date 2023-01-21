/// <reference path="../global/_global.d.ts" />
import "../global/_global.ts";
import { denodb } from "../global/_deps.ts";
import { getAllMiddleware } from "./middle.ts";

const useMySQL = Config.Session.driver == "mysql";
console.log(useMySQL);

const { Database, MySQLConnector, Model, DataTypes } = denodb;

class DBSession extends Model {
	static table = "Sessions";

	static fields = {
		id: {
			type: DataTypes.STRING,
			length: 36,
			primaryKey: true,
		},
		data: DataTypes.JSON,
		expires: DataTypes.DATETIME,
	};
}

if (useMySQL) {
	const connector = new MySQLConnector({
		database: Config.MySQL.database,
		host: Config.MySQL.host,
		username: Config.MySQL.username,
		password: Config.MySQL.password,
		port: 3306, // optional
		charset: Config.MySQL.charset,
		poolSize: 10, // optional
	});

	const db = new Database(connector);
	db.link([DBSession]);
	try {
		await db.sync();
	} catch (_e) {
		// ignore
	}
}

class Session {
	public date: number;
	public expire: number;
	public id: string;
	public data: Record<string, unknown>;
	static all: Map<string, Session> = new Map();

	private saving = false;

	constructor(id: string) {
		this.id = id;
		this.date = Math.floor(Date.now() / 1000);
		this.expire = Math.floor(Date.now() / 1000) + 3600 * 24 * 7;
		this.data = {};

		Session.all.set(this.id, this);
	}

	// deno-lint-ignore no-explicit-any
	public iSet(key: string, value: any) {
		this.data[key]=  value;
	}

	// Session functions for session data
	// deno-lint-ignore no-explicit-any
	public Set(key: string, value: any) {
		this.data[key] = value;
		if (useMySQL) this.Save();
	}

	public async Save() {
		if (this.saving) return;
		this.saving = true;
		const dbSession = await DBSession.where("id", this.id).first();
		// convert expiry to mysql datetime
		const expires = new Date(this.expire * 1000);
		if (dbSession) {
			dbSession.data = JSON.stringify(this.data);
			dbSession.expires = expires;
			await dbSession.update();
			Config.Session.logLevel == "debug" && CLog(`[<yellow>SESSION</yellow>] Updated session in Database : ${this.id}`);
		} else {
			try {
				await DBSession.create({
					id: this.id,
					data: JSON.stringify(this.data),
					expires: expires,
				});
				CLog(`[<yellow>SESSION</yellow>] Creating session in Database : ${this.id}`);
			} catch (e) {
				console.log(e);
			}
		}
		this.saving = false;
	}

	public Get(key: string) {
		return this.data[key] ?? false;
	}

	public delete(key: string) {
		delete this.data[key];
		if (useMySQL) this.Save();
	}

	public SetExpires(times: number) {
		return this.expire + times;
	}

	public Renew() {
		this.expire = Math.floor(Date.now() / 1000) + 3600 * 24 * 7;
	}

	public IsExpired() {
		return this.expire < Math.floor(Date.now() / 1000);
	}

	// static Session functions for session management
	static Create() {
		const id = crypto.randomUUID();
		Config.Session.logLevel == "debug" && CLog(`[<yellow>SESSION</yellow>] Creating session : ${id}`);
		const session = new Session(id);
		return session;
	}
	static async Get(id: string) {
		let session = Session.all.get(id);
		if (!session && useMySQL) {
			// check in database
			const dbSession = await DBSession.where("id", id).first();
			if (dbSession) {
				session = new Session(id);
				session.data = JSON.parse(dbSession.data as string);
				session.expire = new Date(dbSession.expires as string).getTime() / 1000;
				CLog(`[<yellow>SESSION</yellow>] Found session from Database : ${id}`);
			}
		}
		// check if session is expired
		if (session && session.IsExpired()) {
			await Session.delete(id);
			return undefined;
		}

		return session;
	}

	static async delete(...ids: string[]) {
		for (const id of ids) {
			Session.all.delete(id);
			if (useMySQL) {
				const dbSession = await DBSession.where("id", id).first();
				if (dbSession) {
					await dbSession.delete();
					Config.Session.logLevel == "debug" && CLog(`[<yellow>SESSION</yellow>] Deleted session from Database : ${id}`);
				}
			}
		}
	}
}

// middleware for injecting session into context
// deno-lint-ignore no-explicit-any
async function SessionMiddleware(ctx: any, next: any) {
	const cookieValue = await ctx.cookies.get(Config.Session.CookieName);
	if (cookieValue) {
		ctx.session = await Session.Get(cookieValue);

		if (!ctx.session) {
			ctx.session = Session.Create();

			ctx.cookies.set(Config.Session.CookieName, ctx.session.id, {
				httpOnly: true,
				maxAge: 3600 * 24 * 7,
				sameSite: "lax",
				secure: false,
			});
		}
		for (const middleware of getAllMiddleware()) {
			const func = middleware[1];
			await func(ctx, next);
		}
	} else {
		ctx.session = Session.Create();
		ctx.cookies.set(Config.Session.CookieName, ctx.session.id, {
			httpOnly: true,
			maxAge: 3600 * 24 * 7,
			sameSite: "lax",
			secure: false,
		});
	}
	await next();
}

if (useMySQL) {
	// check every hour if sessions are expired
	setInterval(async () => {
		const SessionList = await DBSession.all();
		for (const cSession of SessionList) {
			// convert to session object
			const SessionObj = new Session(cSession.id as string);
			SessionObj.id = cSession.id as string;
			SessionObj.data = JSON.parse(cSession.data as string);
			SessionObj.expire = new Date(cSession.expires as string).getTime() / 1000;

			if (SessionObj.IsExpired()) {
				await Session.delete(SessionObj.id);
			}
		}
	}, 3600 * 1000);
}

export { Session, SessionMiddleware };
