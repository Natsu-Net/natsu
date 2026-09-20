# natsu v2 — Bun rework design

Status: design + validated prototype (`prototype/`). Companion document:
`DESIGN.md` in [beingsuz/uwu-template](https://github.com/beingsuz/uwu-template),
which covers the template engine and hydration half.

## Goal

Move natsu off Deno/Oak onto the latest Bun, and make networkable state a
first-class feature: a decorated field on a server class stays linked to the
text that rendered it in every connected browser.

## Where natsu stands today

794 lines of Deno, resolved at runtime from `https://deno.land/x/…`:

| Piece | Today |
| --- | --- |
| HTTP | Oak v12 `Application` |
| Routing | `Router` extending Oak's, string handlers (`"Home@Home"`) |
| Controllers | `new Controller("Home").Add("Home", fn)`, global registry |
| Templates | uwu-template via raw GitHub import, `.nnt` files |
| Sessions | denodb + MySQL, in-memory `Map` fallback |
| Static files | `Deno.readFile` + a TTL cache |
| Hot reload | `Deno.watchFs` in a blob Worker, re-import with a cache-busting query |
| Globals | `Router`, `Controller`, `Config`, `CLog` on `globalThis` |

The shape of the API is good and worth preserving. What has to change is
everything underneath it.

## Port map

| Deno | Bun |
| --- | --- |
| Oak `Application` | `Bun.serve` with native `routes` (parameterised paths, per-method handlers) |
| `https://deno.land/x/…` | npm dependencies in `package.json` |
| denodb / MySQL | `bun:sqlite` by default, `Bun.SQL` for MySQL/Postgres |
| `Deno.watchFs` + blob Worker | `fs.watch`, or `bun --hot` in development |
| `Deno.readFile` for statics | `Bun.file()` — `Bun.serve` streams it with `sendfile(2)` |
| `Deno.cwd()` / `Deno.args` | `process.cwd()` / `Bun.argv` |
| Blob-URL Workers | Native `Worker`, or none — `fs.watch` needs no thread |

Two deliberate drops:

- **Oak.** natsu already wraps it so thoroughly that the wrapper *is* the API.
  Owning a router on top of `Bun.serve`'s native routing removes a dependency
  and a layer of per-request allocation.
- **denodb.** Unmaintained, and the only thing natsu uses it for is a sessions
  table. `bun:sqlite` covers the default case with no external service.

`Config`, `CLog`, `Router` and `Controller` stay on `globalThis` — that is
natsu's character — but everything also gets a typed module export, so an app
can `import { Router } from "natsu"` and get real types.

## Networkable state — the decorator API

```ts
import { State, Networked, Action } from "natsu";

@State("room", { scope: "global" })
class Room {
  @Networked() online = 0;                      // server writes stream out
  @Networked({ writable: true }) topic = "hi";  // client may write this one
  @Action() bump(by = 1) { this.online += by }  // client may call, runs on server
}
```

A controller then writes to it like any object:

```ts
Home.Add("Index", (ctx) => {
  const room = ctx.state(Room);
  room.online++;                                 // every connected client updates
  ctx.response.body = ctx.templates.render("pages/index", { room });
});
```

And the template is unchanged ordinary uwu-template:

```hbs
<p>online: <b>{{room.online}}</b></p>
```

### How it works

`@Networked` records field metadata; `@State` reads that metadata in its class
decorator and redefines each field on the instance as an accessor over a
uwu-template reactive store. Plain assignment is therefore what produces a
patch — no `.set()`, no proxy the author has to remember to use.

These are **TC39 standard decorators**, which Bun runs natively. Verified: field
decorators thread metadata to the class decorator through `context.metadata`, so
`@Networked() online = 0` works without the `accessor` keyword and without
`experimentalDecorators`.

### Scopes

| Scope | Meaning | Backing |
| --- | --- | --- |
| `session` | One instance per session (**default**) | natsu's session store |
| `global` | One instance shared by every client | Process singleton |
| `request` | Per-request render data, never socketed | Nothing |

`session` is the default because it is the safe one: a field accidentally
marked networkable leaks to one user's own tabs rather than to everybody.

### Wire protocol

WebSocket at `/_uwu/socket`, using `Bun.serve`'s built-in pub/sub — one topic
per state scope, so a `global` store fans out with a single `server.publish`.

- server → client: `{ t: "patch", store, patches: [{ path, value }] }`, batched
  per microtask so a burst of writes is one frame
- client → server: `{ t: "set", store, key, value }` — refused unless the path
  is marked writable
- client → server: `{ t: "call", store, method, args }` — refused unless the
  method is marked `@Action`

Both directions default to closed. A field is read-only and a method is
un-callable until the author opts in.

## Defaults chosen where the request was open

| Fork | Default chosen | Why |
| --- | --- | --- |
| Keep or drop Oak | Drop | natsu's wrapper is already the real API |
| Session store | `bun:sqlite`, MySQL via adapter | No external service needed to run |
| State scope | `session` | The safe default if a field is marked by accident |
| Transport | WebSocket only (SSE later) | Two-way from the start; SSE cannot carry actions |
| Router API | Keep `"Controller@method"`, add `@Get`/`@Post` decorators | Existing apps port unchanged |
| Versioning | v2 on a branch | v1 keeps working for anyone on Deno |
| Repo layout | natsu depends on uwu-template via npm | uwu-template ships independently |

## Staged plan

Test and benchmark suites are part of every stage, not a phase at the end.

**Stage 1 — Bun core**
`Bun.serve`, router, controller registry, context, static files via `Bun.file`,
config, logger, `fs.watch` hot reload. Port the bundled example app. `bun run dev`.

**Stage 2 — sessions**
`bun:sqlite` store, cookie handling, expiry sweep, pluggable adapter interface,
MySQL adapter on `Bun.SQL`.

**Stage 3 — state decorators ✅ prototype validated**
`@State`, `@Networked`, `@Action`, scope resolution, `ctx.state(Class)`.
Working in `prototype/state.ts`.

**Stage 4 — the wire ✅ prototype validated**
WebSocket on `Bun.serve` with pub/sub, protocol, batching, writability and
action enforcement. Reconnect-with-resync still to build.

**Stage 5 — integration**
natsu serves the uwu client runtime and per-template modules under `/_uwu/*`,
auto-injects the state script, and derives end-to-end types from the state class
to the template.

**Stage 6 — test suite**
Router (params, prefixes, domains, method matching), controllers, sessions
(persistence, expiry, concurrent writes), static file serving and cache
behaviour, middleware ordering, state scoping and isolation between sessions,
protocol conformance including every refusal path, and hot reload. Integration
tests drive a real `Bun.serve` instance; browser tests drive real hydration.

**Stage 7 — benchmark suite**
Requests/sec for plain text, static file and rendered-template routes; latency
percentiles rather than just the mean; session store read/write throughput;
patch fan-out to 1/100/10k subscribers; memory per idle connection. Compared
against Bun's bare `serve`, Elysia and Hono so the framework's own overhead is
visible. Results committed so a regression shows up in a diff.

**Stage 8 — migration**
v1 → v2 guide, codemod for the `.nnt` → `.uwu` rename, and a compatibility shim
for the `globalThis` API.

## What the prototype already proves

`prototype/` runs the whole loop on Bun 1.3.11. Verified in a real browser:

- a server-side `room.online++` reaches the DOM with no reload and no polling
- a button click invokes a server `@Action`, which round-trips back as a patch
- a client write to a `writable` field is accepted
- a client write to a read-only field is refused
- the page is never reloaded during any of it

```bash
cd prototype
bun run server.ts
```
