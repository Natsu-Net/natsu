# Asset pipeline

`Assets` builds scripts and stylesheets, hashes them into `outDir` and rewrites the paths pages link. Everything on this page is opt-in: an app that sets none of these options behaves as before.

```ts
import { Assets } from "natsu";

export default {
	outDir: ".natsu/assets",
	discover: { templates: ["views"], roots: { "/static/": "public/static" } },
	block: ["https://ads.example.com/*"],
	remote: true,
	mangle: { markup: ["views"], literals: true },
	prefetchChunks: true,
	firstLoad: { inline: true, preload: true },
	prebuilt: true,
};
```

Keep the options in a module (`assets.config.ts`) so the app and the build command read the same object.

## Discovery

`discover.templates` lists template files or directories (`.html`, `.htm`, `.uwu`; change with `extensions`). Every `<script src>` and `<link rel="stylesheet" href>` found is resolved through `discover.roots`, a map from URL prefix to directory, and becomes an entry with a `rewrite` rule, the same as if it were listed by hand under `scripts`, `classicScripts`, `styles` and `rewrite`.

- `type="module"` scripts are bundled and split, other scripts are built as classic scripts, stylesheets become style entries.
- An entry or rewrite rule written by hand always wins over a discovered one.
- A path holding a template expression, a missing file or an unsupported type is left as written and listed in `report.skipped` with the reason.
- `overrides` renames an entry, points it at another file, changes its kind or skips it. `asIs` keeps matching paths untouched.

## Blocklist

`block` is a list of exact strings, prefixes ending in `*`, or regular expressions, matched against the path as the template writes it. A string rule also matches a spelling the browser reads as the same address: capitals in the scheme or host, `&amp;` for `&`, tabs and line breaks, backslashes before the host. The path and query stay literal, so percent-encoding and `./` are not folded; use a regular expression for those. A blocked tag goes out byte for byte: it is not discovered, not fetched, not read, not rewritten and its classes are not renamed. Use it for third-party tags that must load from their own origin.

## Remote files

With `remote` on, an `http(s)://` or `//` script or stylesheet found by discovery is fetched at build, stored in `outDir` under a hashed name and served first-party. The tag is pointed at the copy and loses `integrity` and `crossorigin`.

Every fetched file is pinned by SHA-384 in a lockfile (`natsu-assets.lock.json`, commit it). A normal build fetches nothing new: it refuses a URL with no pin, and fails with `remote asset changed: <url> pinned ... got ...` when the bytes differ from the pin. To accept new or changed files run the pin command and review the lockfile diff.

Limits, all adjustable under `remote`:

| Option | Default | |
| --- | --- | --- |
| `maxBytes` | 5 000 000 | per file |
| `timeoutMs` | 15 000 | per request |
| `maxRedirects` | 3 | each hop is checked again |
| `hosts` | any public host | allow-list of hosts |
| `lockfile` | `natsu-assets.lock.json` | relative to the working directory |
| `cacheDir` | under `outDir` | fetched bodies, safe to delete |

Only `https:` is allowed, addresses that are private, loopback or link-local are refused, and the response type must match the tag. `allowLoopbackHttp` and `allowPrivate` exist for tests. A tag with its own `integrity` is checked against it.

## Class names in scripts

`mangle.literals: true` renames class names inside the built scripts as well as in CSS and markup: `classList` calls, `className`, `querySelector`, `closest`, `matches` and selector strings. A name the rewriter cannot prove is a class keeps its name everywhere, so the result is always consistent. `mangle.readable` keeps readable short names for debugging. `report.mangled.literals` counts the edits.

## Chunks and idle prefetch

Module scripts are split by `Bun.build`. With `prefetchChunks` the build writes a chunk map (`chunks.<hash>.json`) and pages carry `<meta name="natsu-chunks">`. When the browser is idle, the client prefetches the chunks of `mount()` selectors present on the page, at most `prefetchChunks.max` (default 6), never under Save-Data. Pages without a `mount()` get no tag.

## First load

`firstLoad.inline` gives a first visit its CSS inline, up to `maxBytes` (default 14 000), and preloads the stylesheet so the next page links it from cache. A return visit gets plain links. The visit is recognised by a cookie (`natsu-a` by default, `HttpOnly`, `SameSite=Lax`) holding only the public build id; there is no per-visitor state. Documents get `Vary: Cookie`, and the first-visit answer is `cache-control: private, no-cache`.

`firstLoad.preload` adds `<link rel="modulepreload">` for the static imports of the page's module scripts on a first visit.

Inline CSS follows the response's Content-Security-Policy: with a nonce it is used, and when inline styles are not allowed the page keeps its links.

## Head tags

`headTags(ctx)` adds `<link>`, `<meta>` and `<script src>` tags to the head of the answer from a handler: `headTags(ctx).preload("/hero.avif", "image")`. Tags are validated, deduplicated, carried through `PageCache` and applied to navigation answers.

## Binary files

`files` takes fonts, images and other binary files. They are hashed, served with their media type, and `url()` references in a discovered or listed stylesheet are rewritten to the hashed URL when a `rewrite` rule names the file. Already-compressed formats are not compressed again.

## Prebuilt assets

`prebuilt: true` makes `build()` load `<outDir>/natsu-assets.json` instead of building: no `Bun.build`, no source read, no network. The manifest records every file with its SHA-256 and is refused when the natsu version, the options or any file differs; the app then builds as usual, or throws with `prebuilt: { strict: true }`.

Write the manifest at build time:

```sh
bunx natsu-assets build --config assets.config.ts
bunx natsu-assets pin   --config assets.config.ts
bunx natsu-assets check --config assets.config.ts
```

`build` writes the files and the manifest. `pin` also fetches remote files and updates the lockfile. `check` exits 1 when the result differs from the manifest on disk. `--export <name>` picks a named export.

In a Dockerfile:

```dockerfile
COPY . .
RUN bun install --frozen-lockfile && bunx natsu-assets build --config assets.config.ts
CMD ["bun", "run", "app.ts"]
```

Run `pin` on a developer machine and commit `natsu-assets.lock.json`; the image build then needs the network only for files already pinned and fails on any change.

## Limits

- The options fingerprint covers options, not source files: rebuild after changing sources.
- The manifest is checked for integrity, not signed. Treat `outDir` as part of the image.
- A prebuilt set holds at most 5000 files and 256 MB.
- Remote pins that are no longer referenced stay in the lockfile until removed by hand.
- A file under `files` with an unknown extension cannot be restored from a manifest; the app falls back to building.
- First-visit inlining needs a `<head>` and uses the first `</head>`.
