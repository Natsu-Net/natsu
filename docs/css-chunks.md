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
  rewrite: { "/css/site.css": "site" },
  chunking: {
    mode: "families",
    scripts: { "/js/menu.js": "public/js/menu.js" }, // scripts Assets does not build
    prefetch: true,                                  // warm the other families when idle
  },
});
```

The template keeps its one `<link rel="stylesheet" href="/css/site.css">`;
the page goes out with that tag pointing at the core and a copy of it, with
every attribute kept, for each family it needs, right after it.

## How a sheet is cut

Families come from the stylesheet itself (uwu-template's `partitionCSS`):

- A class belongs to the **block** its name starts with: up to `__` or `--`,
  else up to its first `-` (`msged__tab` and `msged--wide` are `msged`,
  `mu-card` is `mu`). `blocks` puts blocks or classes together by hand:
  `blocks: { editor: ["msged", "vars", /^att/] }`.
- A rule can belong to a block when **every selector in its list needs a
  class of that block** in a compound that must match (not inside `:not()`,
  `:is()` or `:has()`, where an alternative could do without it). Such a rule
  can match nothing on a page that has none of those classes.
- A block's rules in one stretch of the sheet make a family; the same block
  written again much later (its responsive overrides at the end of the file)
  starts another. Families smaller than `minBytes` (2048) join the neighbour
  they are written next to, never across two of the files `styles` lists:
  each file is a boundary you drew. At most `maxFamilies` (12) are kept.
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
logical property its physical ones, `all` everything) and could match the
same element, the order would decide which wins. So each family also
**carries a copy of every later rule that could compete with one of its
rules**, from the core or from a family linked before it, and of the rules
those compete with in turn. On any page, whatever families it links, the copy
that comes last is the rule that came last in the source.

"Could match the same element" is judged conservatively: two selectors are
taken never to meet only when their subjects need different element names,
different ids or different pseudo-elements. A rule whose copies alone would
outweigh it (`ruleCopyRatio`, 1) stays in the core, which is where a rule
written far from the rest of its family usually goes, and a family whose
copies would exceed a quarter of its size (`copyRatio`) goes back to the core
whole. Rules in different cascade layers or scopes never compete on order.

This is checked in Chromium (`uwu-template`, `bun run test:browser`): random
sheets made to collide, cut and linked as pages would link them, must compute
the same style for every element and `::before` as the whole sheet.

## What a page links

- The core, always, then each family **one of whose selectors needs only
  classes the page has**, in the markup Assets rewrites.
- The classes its **scripts can write**. Each `<script src>` the page links is
  read if Assets knows it: an entry it built, with every chunk that entry
  imports, statically or dynamically (a page that loads the entry may load any
  of them); a classic script; a vendor file; or a script you name in
  `chunking.scripts` by the path pages link it at. Inline scripts are read
  too. A script reads as writing every word in its strings, template
  literals and regular expressions, except a word right after `.` or `#`
  (a selector it looks for); a literal spliced with a value
  (`"mu-" + kind`, `` `${base}__title` ``) counts as every class with that
  prefix or suffix. Reading too much only links a family a page did not need.
- Every class the `safelist` names, as if every page had it.

A script Assets does not know (another origin, one you did not name) is not
read: name it, or put what it writes in the `safelist`.

**Islands.** An island's answer is a fragment, with no head to link from. When
its markup needs a family, Assets puts stylesheet links at the start of the
answer: the first family it needs and every family linked after it. In the
body they come after every sheet in the head, so whichever of those the page
links already, the last copy of each is in link order and the cascade holds.
The island's own markup may show unstyled until a family it has not seen
loads; `prefetch` makes that rare.

**Visits.** A part is cut from the rewritten page, so its head lists the
chunks a full load of that page links, in the same order, and the runtime's
stylesheet sync keeps the ones already in place.

## Prefetch

With `prefetch: true`, each page also links the families it does not use as
`<link rel="prefetch" data-natsu-prefetch>`, which the browser fetches when
idle, so the first visit to another kind of page finds them cached. A request
with `Save-Data: on` gets the page without them.

## The report

`build()` returns, per sheet, `report.families[name]`: every chunk's name, URL
and size; per family its blocks, rules, copies and the bytes of those copies;
why rules stayed in the core, by reason, with their count and bytes; a few of
the copies made; and how long the cut took.

## Minification

`minify: true` minifies stylesheets and scripts; `minify: { styles: true }` or
`{ scripts: true }` turns on one of them. The CSS minifier only removes
comments and whitespace no grammar reads; a space that is a descendant
combinator, the space after an escaped character, and the spaces around `+`
in a value all stay.

## Which to use

Families pay off when a sheet is organised by area (a file or a stretch per
feature) and visitors move between kinds of page; the core alone is about what
a page needs anyway. Per-page slicing is smaller for one visit to one page.
Both serve the same immutable, hashed chunks and fall back the same way when a
chunk a page links is gone after a deploy: a core asked for under an old name
gets the whole sheet for a few minutes, a family the empty sheet.
