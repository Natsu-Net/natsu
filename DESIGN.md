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

## Page navigation

A link click fetches only the part of the next page that changes, and a
small runtime swaps it in. There is no client-side rendering: the server
renders and caches the page exactly as it does for anyone, cuts the finished
page, and sends HTML.

```ts
const assets = new Assets({ ...existing, navigate: true });
app.use(assets.middleware());

Routes.get("/products/:id", navigable(showProduct));
Routes.get("/checkout/review", navigable(review, { prefetch: false }));
Routes.get("/shop", navigable("Shop@index"));    // or @Navigable() on a decorated method
Routes.get("/api/bell", island(bell));           // fills <span data-natsu-island="/api/bell">
```

```html
<main id="main" data-natsu-region>…</main>
<footer id="site-footer" data-natsu-region>…</footer>
```

That is all an app writes on the server. `src/navigate.ts` holds the rest; it
runs inside `Assets.middleware()`, which is what makes the order right with no
rule to follow: after the asset rewrite, so a part links its whole page's CSS
chunk, and inside `compress()`, which still sees a string. How to turn it on
and what to change in an app: `v2/docs/page-navigation.md`.

**Every page with a head** gets the runtime's `<script src nonce defer>`
before the head's first deferred script (one with a `src`, or a module), or
before `</head>`, with the nonce the response's CSP lets scripts run by,
read after any PageCache fill so it is this visitor's. **Every page with a
region** also gets `<meta name="natsu" content="doc.shell">` beside it
(`data-prefetch="off"` with `navigate.prefetch: false`). A page PageCache
answered and handed to `assets.markRewritten(ctx, page)` is read once while
it is kept, and each answer is built from its pieces with the tags in
place. The two hashes are what a swap cannot change:

| Hash | Over | So a real load when |
| --- | --- | --- |
| `doc` | the build (a hash of the manifest) and CSP, CSP-Report-Only, Referrer-Policy, Permissions-Policy, COOP, COEP (`documentHeaders` adds more), nonces left out | a deploy, an ad network allowed on one page only, a checkout origin in `form-action` |
| `shell` | every byte outside the head and the regions, less the script list and nonces, plus the region ids, and the head's scripts less natsu's lazy stylesheet loaders | a signed-in header, a re-minted CSRF token in the sign-out form, a banner |

**A navigation** is a GET carrying `Natsu-Nav: <doc>.<shell>` (and
`Natsu-Prefetch: 1` for a hover prefetch). natsu deletes both headers before
any route runs, so neither a handler, a render nor a PageCache key can see
them, and ignores them on any other method, on a browser navigation
(`Sec-Fetch-Mode: navigate`, `Sec-Fetch-Dest: document`) and when malformed.
Every answer varies on `Natsu-Nav`; parts and 204s are `private, no-store`
and carry none of the document headers (the runtime reads them with
`fetch`; they are never a document, and the key proved those headers equal
to the ones the document on screen has); Set-Cookie always passes through.

| Answer | When |
| --- | --- |
| `200` (or the page's 403/404/500), `Natsu-Part: 1`: the head less its scripts, and the regions, all less their `<noscript>`s; the scripts in `Natsu-Scripts`, the head's nonces in `Natsu-Nonce` | the page has regions and both hashes match |
| `204`, `Natsu-Location: <url>` | the route redirected; a target on the same site is sent as a path (`/.//x` for one that starts with `//`), one that is not http(s) is a reload |
| `204`, `Natsu-Reload: route` | the route is not `navigable()` (its handler never ran), or it called `ctx.nav.reload()` |
| `204`, `Natsu-Reload: document` / `shell` | a hash differs |
| `204`, `Natsu-Reload: regions` | the page has no usable region (none, no id, nested, unclosed, in the head, holding a declarative shadow root) |
| `204`, `Natsu-Reload: response` | not a page: JSON, a download, a static file, no route |
| `204`, `Natsu-Reload: inline-script` | a region holds a script that would not run when swapped in |
| `204`, `Natsu-Reload: markup` | a script comes after svg or math that holds HTML (a `<foreignObject>`, a `<title>` with tags), which the scanner does not follow |
| `204`, `Natsu-Prefetch: skip` | a prefetch the route or `ctx.nav.skip()` refused |

Nothing in a part's markup is trusted, because a browser can read a page
differently from the scanner (a stray end tag, foreign content), and markup
that slipped into a page must not ride along into trust. The part holds no
`<script>` at all: `Natsu-Scripts` lists every `<script src>` outside the
head and the regions that a browser runs, one entry of URL-encoded
attributes each, the runtime's own left out. The scanner reads a page as a
browser's tokenizer does (attribute values, comments bogus or not, raw text
and a script's `<!--<script>` escapes) and tracks template contents and svg
and math as the tree builder opens and closes them, so a script that never
runs on a full load (in a template, a noscript, an attribute value, an svg,
or one the page ends inside) is never listed; a random-page fuzzer checks
that against Chromium. Under a nonce CSP an entry gets a `nonce` key (the
runtime gives that script the document's nonce) only if the page gave it
this response's nonce; one without is dropped under `'strict-dynamic'` (a
script the runtime makes would run whatever its host) and listed without
the key otherwise, so the CSP's host list decides, as on a full load. A
page listing more than a header carries is a full load. In the part's head
a nonce keeps its value when it is this response's and is removed when not
(bare ones too); the response's nonces go in `Natsu-Nonce`, and the runtime
trusts an element only by a value no markup could know in advance.

An island fetch (`Natsu-Island: 1`) reaches only a route made with
`island()`, whose answer says `Natsu-Island: 1` back; any other route
answers `204` without running, so an attribute slipped into user content
cannot pull a page's forms and CSRF token into another page.

**In a handler**, `ctx.nav` refuses, it never changes what is drawn:

```ts
if (flashed && ctx.nav.skip()) return;                    // a prefetch must not eat the flash
if (ctx.nav.stale(decision.responseHeaders)) return;      // CSP differs: leave before fetching data
ctx.nav.shown(() => ctx.deleteCookie("flash"));           // only once the visitor sees this page
```

On a request that is not a navigation `skip`, `reload` and `stale` return
false and `shown` runs at once. A route's CSP has to be on the response by
the time `Assets.middleware()` sees it (set by the handler, by middleware
registered after Assets, or by one that sets it before calling `next()`);
in development a page whose scripts carry nonces without one is named. In
development every refusal is logged with its reason, and a shell change
with the first line that changed.

**In the browser** the runtime (`src/client/navigate.ts`, under 4 KB
brotli; its types, `NatsuClient` and the event details, in
`src/client/types.ts`) is built by `Assets.build()` as the classic entry
`natsu-navigate`, readable and with console lines saying why a visit was a
full load when `General.development` is on. A page without the key never
swaps, but `natsu.mount` and islands work there too; a second copy of the
runtime on a page stays out. A page script that keeps state or listeners
writes them as a mount, and runs `defer`, after the runtime:

```js
natsu.mount("[data-clock]", (el, signal) => {
  const timer = setInterval(() => tick(el), 1000);
  el.addEventListener("click", onClick, { signal });
  return () => clearInterval(timer);       // the region is being swapped out
});
```

A mount runs on every match now and on every match in a region swapped in,
while the page shown lists the script that registered it; a swap stops it
when its element goes (page code may have moved it out of its region, a
portal to `<body>` say), when page code has taken the element out, or, for
one in the shell, when a page that does not list its script is shown.
Every script the document runs counts toward a safe swap: inline, module,
`defer` or `async`, in the head or the body, and one a loader adds later
(the document's scripts are read as the runtime runs, as each visit starts
and after the new regions' mounts, so one that takes its own tag out still
counts). One that never
calls `natsu.mount` (found by `document.currentScript`, or for a module or
a later call by the stack) makes every later visit a full load, so an
unconverted page behaves as it always did. A script a swap created that has
not called it once it has run gets its page loaded for real: it may be
waiting for a `DOMContentLoaded` that never comes again, and a page swapped
in with it would stay dead. Until it has run it does not count: a visit
that starts while it still loads (Back, pressed at once) stays a swap, and
it counts from the next visit on; a visit to a page that lists it waits for
it. Left out are the runtime, a tag with
`data-natsu-once`, data blocks, `nomodule` and any other type the browser
does not run (neither counted nor waited for), and a classic head script
that blocks the parser. A head script runs once per document, as the shell
does, so its mounts apply on every page whatever the page lists, and so do
those of a script a loader created, which no page lists. A script already
on the page, a loader's included, is never created again.

The runtime takes a plain left click on a link to this site and the submit
of a GET form, and leaves the rest to the browser: a modifier (on a submit
button too), a target other than `_self` (the element's own, else the
first `<base target>`), `download`, a file, a link inside
`contenteditable`, `data-natsu-reload`, and a form whose `accept-charset`
is not UTF-8. A form's URL and query are the browser's own: no action is
the page's own URL (never the `<base href>`), no field to send is
`action?`, a file goes as its name, a line break as CRLF.

The runtime takes nothing from a part's markup on trust. It creates the
page's scripts from `Natsu-Scripts` (each entry one tag's URL-encoded
attributes, its `src` resolved against the part's URL, the boot nonce where
the entry has a `nonce` key, `async = false` so they run in order), keeps
in the head only the nonces `Natsu-Nonce` vouches for (a new element with
one gets the boot nonce). The server leaves every `<noscript>` out of a
part, since DOMParser reads its content with scripting off, as markup (a
`</div>` in it would let the rest out), and a part DOMParser cannot read
(Trusted Types) or that still holds a `<noscript>` is a full load; a region
with a declarative shadow root, which DOMParser would leave inert, is
never sent as a part. An island is fetched on this origin only, with
`Natsu-Island: 1`, and filled only from a `200` `text/html` answer that
says `Natsu-Island: 1` back, which only an `island()` route sends; only the
answer to its latest fetch goes in.

Scroll is kept per history entry, and written into it once a scroll
settles (200 ms) and at `beforeunload` and `pagehide`, so Back, Forward, a
reload and a return after the document is gone come back to it. Every
scroll the runtime makes is a jump, whatever `scroll-behavior` says. Each
page shown is numbered and every entry made from it carries the number,
the browser's own entry for a hash link included, so a popstate between
them is a scroll, never a fetch; an entry a script pushed with no state
gets an id, and a scroll, of its own. Back or Forward ends any visit on its
way, as does a newer visit, during a stylesheet load, a view transition or
its scripts alike: an overtaken visit swaps nothing, leaves nothing behind
and fires no `natsu:load`. A hash link's own jump does not, as a browser
lets a load go on past it. While a Back or Forward to another page is on
its way, nothing is written into the entry in the address bar, and a link
or form is read against the page still on screen and its `<base href>`; a
page the back/forward cache restores meanwhile loads its URL for real.

A pointer resting 65 ms on a link prefetches the part (a finger too, unless
the browser takes the touch to pan or the page scrolls), two at a time,
never on Save-Data or 2G or when the meta says `data-prefetch="off"`
(`navigate.prefetch: false`). A click within ten seconds uses the answer,
yielding a frame first so the click paints at once; a prefetched redirect
or reload is acted on as it is, and anything else (a skip, a 404 part)
stops hovers asking until then. A path answered with `Natsu-Reload: route`
or `response`, or with no `natsu-` header at all (another server behind
the same proxy), is a full load, never prefetched, for the rest of the
document.

Also on `natsu` (a global): `visit(url, { history, scroll })`, `refresh()`
(after an action; scroll and focus kept; a real load is `location.reload()`
and a redirect shows its page from the top, as a reload would),
`prefetch(url)`, `island(el)`. A redirect hop carries no scroll.
Events on `document`: `natsu:visit` (cancelable; a cancelled Back or
Forward loads the page for real), `natsu:before-swap`, and `natsu:load`,
once per page shown, at boot too, with `detail: { url, regions }`.
Attributes: `data-natsu-reload` (a real load for a link, a form or
everything inside; on `<html>`, for every visit from that document),
`data-natsu-prefetch` (hover prefetch below it), both on when present and
off when `"false"` or `"off"`; `data-natsu-once`;
`data-natsu-island="<url>"`; and `<html data-natsu-transition>` for a view
transition. While a visit takes longer than 300 ms, `<html>` carries
`data-natsu-loading`, which any full load clears.

`bun run test:e2e` drives Chromium against a natsu app built for it
(`tests/fixtures/navigate/app.ts`: Assets with `navigate: true`, PageCache,
a nonce CSP with `'strict-dynamic'`, two layouts), and prints the bytes and
times of a full load against a soft visit.

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
