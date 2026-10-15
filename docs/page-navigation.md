# Page navigation

With page navigation on, a click on a link of your site fetches only the
parts of the next page that change, and a small script swaps them in. The
server still renders every page in full, as it does for anyone (and
PageCache still keeps it); natsu cuts the finished page on the way out. No
page is ever rendered in the browser, and anything the swap cannot prove
safe becomes an ordinary page load.

## Turn it on

1. Give `Assets` the option and build as usual:

   ```ts
   const assets = new Assets({ outDir, styles, rewrite, navigate: true });
   await assets.build();             // also builds the runtime, natsu-navigate
   app.use(assets.middleware());
   ```

2. Mark the parts of your layout that change from page to page as regions:
   an element with an `id` and `data-natsu-region`.

   ```html
   <main id="main" data-natsu-region>…</main>
   <footer id="site-footer" data-natsu-region>…</footer>
   ```

   Everything else in the body (the header, the menus) is the *shell*. A
   visit swaps the regions and keeps the shell, so the shell must be the same
   on both pages; when it is not (a signed-in header, a banner), the visit is
   a full load.

3. Let the routes answer navigations. A route that does not opt in answers a
   visit with a full load, and its handler never runs for it, so a GET with
   side effects never runs twice.

   ```ts
   Routes.get("/products/:id", navigable(showProduct));
   Routes.get("/checkout/review", navigable(review, { prefetch: false })); // no hover prefetch
   Routes.get("/shop", navigable("Shop@index"));                           // a controller by name

   @Controller("/blog")
   class Blog {
     @Navigable()
     @Get("/:slug")
     post(ctx: Context) { … }
   }
   ```

   Mark the handler the route is registered with: a wrapper of your own
   around a `navigable()` handler hides the mark unless the wrapper is
   `navigable()` too. Leave out pages that must load for real: checkout
   steps that hand over to a payment page, OAuth callbacks, links from
   emails that carry one-time tokens. Page files (`mountPages`) are
   navigable on their own; such a page says `<page navigate="off">`, and
   its forms still post with the runtime.

That is all. Every page now goes out with the runtime's
`<script src="/_a/natsu-navigate.….js" defer>` in its head, and every page
with a region with `<meta name="natsu" content="…">` next to it.

A visit starts from a plain left click on a link to your site, or from the
submit of a GET form. The browser keeps the rest, as it would without
natsu: a click with Ctrl, Shift, Meta or Alt (on a submit button too, which
opens the result in a new tab or window), a link or form with a target
other than `_self` (its own, or the page's first `<base target>`), `download`, a
link to a file (an extension other than `.html`), a link inside an editor
(`contenteditable`), and a form whose `accept-charset` is not UTF-8. A
form's URL and query are built as the browser builds them: no action is
the page's own URL (never the `<base href>`), no field to send is
`action?`, a file goes as its name and a line break as CRLF. Scroll comes back on Back, Forward and a reload, and
every scroll the runtime makes is a jump, whatever `scroll-behavior` says.

## Page scripts

A page that is swapped in does not run the scripts of a full load again, so
a script that sets up listeners or timers writes them as a *mount*:

```js
natsu.mount("[data-clock]", (el, signal) => {
  const timer = setInterval(() => tick(el), 1000);
  el.addEventListener("click", onClick, { signal }); // removed when the region goes
  return () => clearInterval(timer);                 // the region is being swapped out
});
```

- A mount runs for every element that matches now, and for every match in a
  region swapped in later, while the page on screen lists the script that
  registered it. It stops when its region goes (also when your code moved
  the element out of it, a modal portalled to `<body>`), or, on an element
  of the shell, when a page that does not list the script is shown. A
  script that a loader creates (`document.createElement("script")`) is
  listed by no page, so its mounts apply everywhere.
- Load page scripts with `defer` (or as modules), at the end of the body or
  in the head: the runtime is placed before the head's first deferred
  script, so `natsu` exists when they run. A classic script without `defer`
  runs before the runtime; guard it with `window.natsu &&`.
- Call `natsu.mount` at the top level of the script. Every script the page
  runs counts, inline, module, `defer` or `async`, and one that never calls
  it makes the next visit a full load, so a page you have not converted
  keeps behaving as it always did (the console names the script). A page
  swapped in whose new script has not called it once it has run (one that
  waits for `DOMContentLoaded`, which a swap never fires again) is loaded
  again, for real, so it works as it does on a full load; Back pressed
  while it still loads stays a swap, and it counts from the next visit
  on. A script that
  needs no mount (analytics, a tag manager, a polyfill) says so with
  `data-natsu-once`; a script that such a script adds later counts too,
  from the next visit on, so tag it where it is created. A script that
  removes its own tag still counts. Left out: data
  blocks, `nomodule` and any other type the browser does not run (a consent
  manager's `type="text/plain"`), and a classic script in the head without
  `defer` or `async`, which runs once per document like the shell. A
  script already on the page, one a loader added included, never runs
  twice.
- Scripts inside a region do not run when the region is swapped in, so a
  page with one is a full load: move it after the region. Data blocks
  (`type="application/json"`, JSON-LD) are fine.

Also on `natsu` (a global): `visit(url, { history, scroll })`, `refresh()`
(draw the current page again after an action, scroll and focus kept; when
it cannot swap it reloads, as `location.reload()` does, and a redirect to
another page shows that page from its top), `prefetch(url)` and
`island(el)` (only the answer to an island's latest fetch goes in). Events on `document`: `natsu:visit`
(cancelable; a cancelled Back or Forward loads the page for real),
`natsu:before-swap`, and `natsu:load`, once per page shown (at boot and
after each visit) with `detail: { url, regions }`.

In TypeScript, the types are in natsu's `src/client/types.ts`
(`NatsuClient`, `NatsuVisitOptions`, `NatsuVisitDetail`,
`NatsuLoadDetail`); a type import of that file also declares the `natsu`
global and the events. They are not exported from natsu's main entry, which
would bring the DOM's types into server code.

Attributes:

| Attribute | Effect |
| --- | --- |
| `data-natsu-reload` on a link, a form or any ancestor | always a real load; on `<html>`, for every visit from that page |
| `data-natsu-prefetch` on a link or any ancestor | when links below it are fetched ahead: `"hover"` (the default), `"viewport"`, `"none"` (see Prefetch) |
| `data-natsu-once` on a script | needs no mount (see above) |
| `data-natsu-island="/url"` | fill the element from an island route (below) |
| `data-natsu-transition` on `<html>` | swap inside a view transition (or `navigate.transition` for every page) |

## Prefetch

A link is fetched ahead of its click, so the click swaps at once. When:

| `data-natsu-prefetch` | Fetched |
| --- | --- |
| `"hover"`, or nothing | when a pointer rests 65 ms on the link (a finger too) |
| `"viewport"` | once the link is on screen, in idle time; and on hover |
| `"none"` (or `"off"`) | never |

The attribute counts on the link or any ancestor, so a whole menu says it
once: `<nav data-natsu-prefetch="viewport">`. `navigate.prefetch` sets what
a link that says nothing gets, for the whole site (below).

What is fetched ahead is a part, with `Natsu-Prefetch: 1`, which a route can
refuse (`navigable(h, { prefetch: false })`, `ctx.nav.skip()`). A click within
ten seconds uses it. Two are fetched at a time and five kept, so links in
view stop being fetched once five answers are waiting: they never push out
the one a pointer is resting on. Nothing is fetched ahead on Save-Data or a
2G connection, and nothing for being in view on 3G either.

## Back and Forward

Back or Forward to a page this tab swapped in shows it at once from the part
it was shown from, for ten seconds after that part was asked for; later, it
is asked again. A click on a link always asks again (unless a hover just
fetched it). A page with live data is never kept, since it may have changed
while nothing watched it, and any submit or action lets every kept part go.

## Loading bar

While a visit takes longer than 150 ms, `<html>` carries
`data-natsu-loading`, and a 2px bar shows at the top: `<natsu-bar>`, an
element the runtime adds to the body. Its default style lives in
`@layer natsu`, so any rule of yours wins:

```css
natsu-bar { --natsu-bar: rebeccapurple; height: 3px; } /* restyle */
natsu-bar { display: none; }                          /* or turn it off */
```

It grows without a step and fades out when the page is in; under
`prefers-reduced-motion` it only appears and goes. The style comes from a
constructed stylesheet, which a `style-src` CSP does not block.

## View transitions

Off by default. `navigate: { transition: true }` swaps every page inside a
view transition, as `<html data-natsu-transition>` does on the pages that
carry it; style it with the usual `::view-transition-*` rules. A visitor who
prefers reduced motion never gets one, nor does a tab in the background.

## Islands

A page that is the same for everyone can be kept by PageCache and shared,
except for the few things that are the visitor's own (a notification bell,
an account menu). Draw those as islands: an empty element the runtime fills
after the page loads.

```ts
Routes.get("/api/bell", island(bell));
```

```html
<span data-natsu-island="/api/bell"></span>
```

The runtime fetches the URL with `Natsu-Island: 1` and fills the element
only from an answer that says `Natsu-Island: 1` back, which only an
`island()` route sends; any other route is refused before its handler runs.
Islands are fetched from your own site only. If your pages show HTML your
users wrote, strip `data-natsu-*` attributes from it in your sanitizer.

### Live islands

An island can be live on its own. Give `island()` the tags its answer
depends on, and when one is invalidated the runtime fetches that island
again and redraws only it; the page around it, a playing video, an open
menu, all stay as they are.

```ts
Routes.get("/api/bell", island(bell, { tags: (ctx) => [`bell:${userOf(ctx)}`] }));

// wherever a notification is written:
invalidate(`bell:${userId}`);
```

The tags travel signed in a `Natsu-Live` header on the island's answer, the
same way a page's travel in its `natsu-live` meta, so a visitor can only
watch what the server handed them. A tag the page itself depends on still
redraws the page. Live islands need the live socket (`/_uwu/socket`),
which page files with a live source already open.

## Links in page files

In a page file (`pages/**/*.uwu`), write links to other pages with uwu's
`@href`. The value is the URL as it ships, holes and all:

```html
{{#each products}}
  <a @href="/p/{{vendor}}/{{slug}}" data-natsu-prefetch="viewport">{{name}}</a>
{{/each}}
```

It is drawn as a plain `<a href="/p/acme/shoe">` (with uwu's `data-uwu-link`
marker), so it works without script, can be opened in a new tab, and is
what a crawler sees. natsu checks it when it compiles the pages: some page
file must answer the path (here `pages/p/[vendor]/[slug].uwu`). Each hole
stands for one value, so it fits a `[param]` or a fixed segment; the query
and the hash are free, and a trailing slash is fine. A link no page
answers stops the compile (and `compilePages` for a deploy) with its file
and line:

```
pages/index.uwu:12: @href="/prodcuts/{{slug}}" matches no page: no file under pages/ answers /prodcuts/:… (pages of that depth: /jobs/:id, /p/:slug)
```

so renaming or deleting a page file shows every link that pointed at it.
The holes are data the page reads like any other: inside the each above,
the `products` source is asked for `vendor` and `slug`.

A link to something that is not a page file (a controller route, a file,
another site) is a plain `href`; it swaps all the same when its route is
`navigable()`. `@href` must start with `/`: a link whose whole URL is data
cannot be checked, so it is a plain `href` too.

## Content-Security-Policy

Page navigation works under a nonce CSP, `'strict-dynamic'` included. The
runtime's tag takes the nonce your CSP lets scripts run by, and the scripts
of a swapped-in page are created by the runtime only from a list the server
sends in a header, each with the document's nonce only if the server saw
this response's nonce on it. Nothing written in a page's markup ever
becomes a trusted script.

- Set the CSP header before `Assets.middleware()` reads the answer: in the
  handler, or in a middleware that sets it before calling `next()`. A CSP
  added after the route has answered is one Assets never saw; the
  runtime's tag then has no nonce and the browser blocks it (pages still
  load, just never swap). In development natsu logs this.
- Under Trusted Types (`require-trusted-types-for 'script'`) the runtime
  cannot parse a part, so every visit is a full load and islands keep the
  content the server drew; nothing breaks.

## PageCache

A page served from PageCache gets its navigation key and runtime tag per
answer, with each visitor's own nonce. Hand the page PageCache gave back to
Assets, so the kept page is read once instead of on every answer:

```ts
const page = await pages.serve(key, [nonce, csrf], render);
if (page?.prepared) assets.markRewritten(ctx, page);
return page?.body;
```

How a kept page carries tags and is let go when its data changes is in
[page-cache.md](page-cache.md).

A part (the answer to a visit) is never kept by PageCache and never cached
by a browser or CDN (`private, no-store`, `Vary: Natsu-Nav`).

## In a handler

`ctx.nav` refuses; it never changes what is drawn, because the page drawn
for a visit is the page PageCache may keep for everyone.

```ts
if (flashed && ctx.nav.skip()) return;               // a prefetch must not use up the flash
if (ctx.nav.stale(decision.responseHeaders)) return; // CSP differs: leave before fetching data
ctx.nav.shown(() => ctx.deleteCookie("flash"));      // only once the visitor sees this page
if (needsFullLoad) ctx.nav.reload("reason");         // a real load
```

On a request that is not a navigation, `skip`, `reload` and `stale` return
false and do nothing, and `shown` runs at once.

## Options

```ts
navigate: {
  prefetch: "viewport",                  // links in view too ("hover" is the default, "none" only links that ask)
  // prefetch: false,                    // none at all, and the server refuses any that comes
  transition: true,                      // every swap inside a view transition
  inject: false,                         // link assets.url("natsu-navigate") yourself
  documentHeaders: ["x-frame-options"],  // more headers a page must share to swap
}
```

## Why was it a full load?

In development the server logs every refusal with its reason, and the
runtime logs it in the browser console. The answer's `Natsu-Reload` header
says which:

| Reason | Meaning | What to do |
| --- | --- | --- |
| `route` | the route is not `navigable()`, or called `ctx.nav.reload()` | wrap the handler it is registered with |
| `shell` | the markup outside the regions differs (the log shows the first line that does) | move what differs into a region, or accept a full load there |
| `document` | a deploy, or the CSP or another document header differs | expected; nothing |
| `regions` | no region, one without an id or end tag, nested regions, a region in the head, or a declarative shadow root in a region | fix the markup |
| `inline-script` | a region holds a script that would not run when swapped in | move it after the region |
| `markup` | a script comes after svg or math that holds HTML (a `<foreignObject>`, a `<title>` with tags in it), which natsu cannot read as surely as a browser | keep svg titles to plain text, or accept a full load there |
| `response` | not a page: JSON, a download, a static file, no route | expected; nothing |

A redirect is followed by the runtime (`Natsu-Location`), softly when it
stays on your site. In the browser, a page whose scripts never called
`natsu.mount` makes the next visit a full load, and the console names the
scripts; a page swapped in with a new script that never called it is
loaded again, for real, at once. A path whose answer carried no `natsu-`
header at all (another server behind the same proxy, a blog say) is a full
load from then on.

## What to check after turning it on

- Click through the site with the browser's network panel open: visits show
  as `fetch` requests answered `200` with `Natsu-Part: 1`.
- In development, read the server log and the console for full loads you did
  not expect.
- A page that loads again right after a visit (a `fetch`, then a document
  load of the same URL), or whose listeners stop working after one, has a
  script that is not a mount yet; in development the console names it
  (keep its log across loads to see it).
