/**
 * Page files, end to end: three pages under `pages/`, no controllers.
 *
 *   bun run example-pages/app.ts      (port 8084, or PORT)
 *
 * - `/`            lists `jobs` (a plural name: the model resolver's list,
 *                  sorted by `?sort=` where the resolver allows it);
 * - `/jobs/:id`    loads `job` (singular, matched to `:id`; none is a 404)
 *                  and its `company` through a `<data>` line that waits
 *                  for `job`;
 * - `/p/:slug`     loads `product` and fetches `stock` from the
 *                  `inventory` service, falling back to null.
 *
 * The layout reads `categories` (a source) and `viewer`. The data here is
 * in memory; the resolver is where the ORM plugin will plug in.
 */

import { join } from "node:path";
import { Application, Assets, NotFound, mountPages, registerModelResolver, setConfig, source } from "../index.ts";

const port = Number(process.env.PORT ?? 8084);
setConfig({
	General: { port, url: `http://127.0.0.1:${port}`, logLevel: "info", development: true },
	Session: { driver: "memory" },
	Static: { enabled: false },
});

const companies = [
	{ id: 1, name: "Acme", slug: "acme", price: 12 },
	{ id: 2, name: "Globex", slug: "globex", price: 30 },
];
const jobs = [
	{ id: 1, title: "Backend developer", summary: "Bun, SQL and patience.", companyId: 1 },
	{ id: 2, title: "Designer", summary: "Make it look like it works.", companyId: 2 },
];

source("categories", () => [{ slug: "dev", name: "Development" }, { slug: "design", name: "Design" }]);
source("companies.byId", ({ args }) => companies.find((c) => c.id === args.id) ?? new NotFound("no such company"));

/** Only these fields may sort a list: the resolver decides, never the URL. */
const SORTABLE = new Set(["title", "id"]);
const pick = (row: Record<string, unknown>, fields: string[]) =>
	fields.includes("*") ? row : Object.fromEntries(fields.map((f) => f.split(".")[0]!).map((f) => [f, row[f]]));

registerModelResolver({
	one(name, { value, fields }) {
		if (name === "job") return jobs.find((job) => String(job.id) === value);
		if (name === "product") {
			const company = companies.find((c) => c.slug === value);
			return company && pick({ name: company.name, price: company.price }, fields);
		}
		return null;
	},
	many(name, { sort, fields }) {
		if (name !== "jobs") return [];
		const key = sort?.replace(/^-/, "");
		const rows = jobs.map((job) => ({ ...job, company: companies.find((c) => c.id === job.companyId) }));
		if (key && SORTABLE.has(key)) rows.sort((a, b) => String(a[key as "id"]).localeCompare(String(b[key as "id"])) * (sort!.startsWith("-") ? -1 : 1));
		return rows.map((row) => pick(row, fields));
	},
});

// A stand-in inventory service.
const inventory = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	fetch: (request) => {
		const slug = new URL(request.url).pathname.split("/").pop();
		return slug === "acme" ? Response.json({ count: 4 }) : new Response("unknown", { status: 404 });
	},
});

const assets = new Assets({ outDir: join(import.meta.dir, ".natsu", "assets"), navigate: true });
await assets.build();

const app = new Application();
app.use(assets.middleware());
const site = await mountPages({
	dir: import.meta.dir,
	dev: true,
	app,
	assets,
	services: { inventory: { base: `http://127.0.0.1:${inventory.port}`, cookie: false } },
});
await app.start();
for (const route of site.routes) console.log(route.path, "<-", route.file, route.data.map((d) => `${d.name}:${d.kind}`).join(" "));

export { app, site };
