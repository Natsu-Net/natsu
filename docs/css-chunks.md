# CSS chunks

`Assets` cuts each stylesheet in `styles` for the pages that link it, in one
of two ways.

- **`chunking: "page"`** (the default) gives each page the slice of the sheet
  its markup can match, as one chunk named by its hash. It is the least a
  single page can download, and the least that is shared: two kinds of page
  rarely match the same slice, so a visitor downloads most rules again on
  every new kind of page. Classes only a script adds need the `safelist`.
- **`chunking: "families"`** cuts each sheet once, at build, into a **core**
  every page links and a few **families** of rules. A page links the core and
  the families it needs; each chunk is fetched once and kept for a year,
  whatever page needs it next. Pages that need the same families send the
  same links.

```ts
const assets = new Assets({
  outDir: "public/_a",
  styles: { site: ["public/css/base.css", "public/css/editor.css", "public/css/music.css"] },
  scripts: { app: "client/app.ts" },
  rewrite: { "/css/site.css": "site", "/js/app.js": "app" },
  chunking: {
    mode: "families",
    scripts: { "/js/menu.js": "public/js/menu.js" }, // scripts Assets does not build
    samples: ["site/pages"],                           // templates: which base-sheet families pay
    prefetch: true,                                    // warm the other families when idle
  },
});
```

The template keeps its one `<link rel="stylesheet" href="/css/site.css">`;
the page goes out with that tag pointing at the core and a copy of it, with
every attribute kept, for each family it needs, right after it.

## How a sheet is cut

Families come from the stylesheet itself (uwu-template's `partitionCSS`),
read from the class names you wrote (with `mangle`, the chunks are renamed
afterwards):

- A class belongs to the **block** its name starts with: up to `__` or `--`,
  else up to its first `-` (`msged__tab` and `msged--wide` are `msged`,
  `mu-card` is `mu`). `blocks` puts blocks or classes together by hand:
  `blocks: { editor: ["msged", "vars", /^att/] }`.
- A rule can belong to a block when **every selector in its list needs a
  class of that block** in a compound that must match (not inside `:not()`,
  `:is()` or `:has()`, where an alternative could do without it). Such a rule
  can match nothing on a page that has none of those classes.
- A block's rules in one stretch of the sheet make a family; the same block
  written again much later (its responsive overrides) starts another.
- **Areas.** When `styles` joins several files, a file that is mostly
  families (three quarters of its bytes) is an area you split out, and its
  families link as one.
- **Base styles.** A family written among a file's base styles moves only
  when `samples` show that the pages doing without it save more than its
  copies (below) and a request cost the pages that need it. `samples` are
  templates or rendered pages; they default to `mangle.markup`, and the
  classes the `safelist` names count on every sample. Without samples such a
  family stays in the core.
- Families under `minBytes` (2048) go to the core, and at most `maxFamilies`
  (12) are kept.
- Everything else stays in the core: element and attribute selectors,
  `:root`, `@font-face`, `@keyframes`, `@property`, the contents of `@layer`
  and `@scope`, nested rules, unknown at-rules, selectors it does not parse,
  and a whole sheet with `@namespace`.

### The cascade

Families link after the core, always in the order they are written in, so a
page's chunks are the sheet's rules in source order, except that a family's
rules now come after core rules and earlier families' rules that used to
follow them. Where two such rules have equal specificity, set the same
property (a shorthand meets its longhands, `font` meets `line-height`, a
logical property its physical ones, `all` everything) with different
declarations, and could match the same element, the order would decide which
wins. So each family also **carries a copy of every later rule that could
compete with one of its rules**, from the core or from a family linked before
it, and of the rules those compete with in turn. On any page, whatever
families it links, the copy that comes last is the rule that came last in
the source.

"Could match the same element" is judged conservatively: two selectors are
taken never to meet only when their subjects need different element names,
different ids or different pseudo-elements. A family whose copies would
exceed a quarter of its size (`copyRatio`) first leaves in the core each rule
that alone would need more copies than it weighs (`ruleCopyRatio`), and goes
back whole if that is not enough. Rules in different cascade layers or
scopes never compete on order.

This is checked in Chromium (`uwu-template`, `bun run test:browser`): random
sheets made to collide, cut and linked as pages would link them, must compute
the same style for every element and `::before` as the whole sheet.

## What a page links

- The core, always, then each family **one of whose selectors needs only
  classes the page has**, in the markup Assets rewrites.
- The classes its **scripts can write**. Each `<script src>` the page links is
  read if Assets knows it: an entry it built, with every module it imports
  statically or by a plain `import()` (a page that loads the entry may load
  any of them); a classic script; a vendor file; or a script named in
  `chunking.scripts` by the path pages link it at. Inline scripts are read
  too. A script counts as writing every word in its strings, template
  literals and regular expressions, except a word right after `.` or `#` (a
  selector it looks for), module specifiers, and strings that read as
  sentences; a literal spliced with a value (`"mu-" + kind`,
  `` `${base}__title` ``) counts as every class with that prefix or suffix.
  Reading too much only links a family a page did not need.
- What a module loaded through **`mount()`** writes, only on pages whose
  markup may match its selector (below).
- Every class the `safelist` names, as if every page had it.

A script Assets does not know (another origin, one you did not name) is not
read: name it, or put what it writes in the `safelist`.

## `mount()`: modules loaded where they are used

A module an entry imports with `import()` counts for every page that loads
the entry, since nothing says which pages run it. Load it through `mount`
instead, and it counts only where it is used:

```ts
import { mount } from "natsu/src/client/mount.ts";

mount("[data-editor]", () => import("./editor/main.ts"));
```

The module exports `mount(el, signal)`, which may return a cleanup. It runs
once per matching element: at load, in a region a visit swaps in, an island,
a live redraw (through the runtime's `natsu.mount`), and for an element a
script adds later; the signal aborts and the cleanup runs when the element
goes. The module is imported once.

At build Assets reads every `mount("<selector>", () => import("<module>"))`
call whose selector and specifier are plain strings (any other shape counts
as a plain `import()`), and the classes that module and what it imports can
write. A page is credited with those classes when its markup **may** match
the selector: for one selector of the list, every element name, class, id
and attribute name its compounds need appears in the page (pseudo-classes,
combinators and the contents of `:not()`, `:is()` and `:has()` are not
checked, so this matches too often, never too seldom). `report.mounts` lists
each entry's mount sites, the families each one always brings, and the
modules it imports some other way.

**Before a mount runs, its stylesheets are there.** Each core link names a
manifest (`data-natsu-families`, an immutable JSON file fetched once, alongside
the module): the sheet's chunks in link order, and per selector the families
the module's classes can need, each with what else the document must hold
for that. The client links any of those the page lacks, each right after the
chunk of its sheet that links before it, waits for them (four seconds at
most), then mounts. So a mount the server did not expect (an element a
fragment brought, a selector it could not read) still draws styled. New links
carry the core link's nonce, so they apply under a nonce `style-src` as long
as the server's core link carries one. Whenever the head changes, the client
also keeps each sheet's chunks in link order, linking a chunk again at the
end (a copy of a cached sheet applies as it goes in) if a visit left its last
copy before one that links earlier.

**Islands.** An island's answer is a fragment, with no head to link from. When
its markup needs a family, Assets puts stylesheet links at the start of the
answer: the first family it needs and every family linked after it. In the
body they come after every sheet in the head, so the last copy of each is in
link order. The island's own markup may show unstyled until a family it has
not seen loads, and under a nonce-only `style-src` these links do not load
(their nonce is the answer's, not the page's): mount what an island draws, or
allow `'self'` in `style-src`.

**Visits.** A part is cut from the rewritten page, so its head lists the
chunks a full load of that page links, in the same order, and the runtime's
stylesheet sync keeps the ones already in place.

## The other options

- `safelist`: its classes count as present on every page (and every sample).
- `lazyStyles`: not used with families; a family is fetched once and shared,
  so there is no per-page half to defer.
- `rewrite`, `navigate`, `minify` (`{ styles, scripts }` for one of them),
  `mangle`, `wholeStylesheets`: as with per-page slicing.

## Prefetch

With `prefetch: true`, each page also links the families it does not use as
`<link rel="prefetch" data-natsu-prefetch>`, which the browser fetches when
idle, so the first visit to another kind of page finds them cached. A request
with `Save-Data: on` gets the page without them.

## The report

`build()` returns, per sheet, `report.families[name]`: every chunk's name, URL
and size; per family its blocks, rules, copies and the bytes of those copies;
why rules stayed in the core, by reason, with their count and bytes; a few of
the copies made; and how long the cut took. `report.mounts` is described
above.

## Minification

`minify: true` minifies stylesheets and scripts; `minify: { styles: true }` or
`{ scripts: true }` turns on one of them. The CSS minifier only removes
comments and whitespace no grammar reads; a space that is a descendant
combinator, the space after an escaped character, and the spaces around `+`
in a value all stay.

## Which to use

Families pay off when a sheet is organised by area (a file or a stretch per
feature) and visitors move between kinds of page. Per-page slicing is smaller
for one visit to one page. Both serve the same immutable, hashed chunks and
fall back the same way when a chunk a page links is gone after a deploy: a
core asked for under an old name gets the whole sheet for a few minutes, a
family the empty sheet.
