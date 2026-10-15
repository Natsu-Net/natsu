# Installable app (PWA)

With `pwa` on, a natsu site installs as an app: a manifest, a service worker,
a "needs network" message instead of a broken page when the visitor is
offline, and a toast when a deploy is ready. It builds on page navigation, so
`navigate` must be on too.

```ts
const assets = new Assets({
  outDir, styles, rewrite,
  navigate: true,
  pwa: {
    manifest: {
      name: "Bytesforge",
      short_name: "Bytesforge",
      theme_color: "#0b1020",
      background_color: "#09090b",
      icons: [
        { src: "/icons/192.png", sizes: "192x192", type: "image/png" },
        { src: "/icons/512.png", sizes: "512x512", type: "image/png" },
        { src: "/icons/maskable.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
      ],
    },
    offline: ["/", "/store", /^\/legal\//],
    offlineWhen: (ctx) => !ctx.request.headers.get("cookie")?.includes("sid="),
    cache: ["/_i/"],
    text: { offline: "This page needs a network connection.", retry: "Retry", update: "A new version is available.", reload: "Reload" },
  },
});
```

| Option | What it does |
| --- | --- |
| `manifest` | served at `/manifest.webmanifest`; `id`, `start_url` and `scope` default to `/`, `display` to `standalone` |
| `offline` | paths (exact strings or regexes) whose page may be kept for offline viewing |
| `offlineWhen` | a further check per request; keep it to visitors who are not signed in, so no one's own page is kept |
| `cache` | more URL prefixes whose files never change under the same name (the chunk path, `/_a/`, is always one) |
| `text` | the words of the offline message and the update toast |

## What goes out

Every page gets `<link rel="manifest">`, `<meta name="theme-color">` and a
second small script, `natsu-pwa`, after the navigation runtime with the same
nonce and `data-natsu-once`. A part carries the same head tags, so a swap
keeps them.

## The worker (`/sw.js`)

Served with `no-cache` and rebuilt with every deploy (its cache is named after
the build), so a deploy is a new worker.

- Files under the chunk path and `cache` prefixes: from the cache first, else
  the network, kept only when answered `immutable` (a fallback page for a
  missing file never is).
- A page load: always the network. A page answered `200` with
  `Natsu-Offline: 1` (a listed path, a GET that `offlineWhen` let through) is
  kept; one that is no longer marked is dropped. Offline, a kept page is shown
  from the cache, any other gets a small offline page (`503`).
- A soft visit's part of a listed page is marked too, and the worker fetches
  that page's full document in the background to keep it.
- Posts, other origins and every other request are left to the network.
- A new build's worker drops the older builds' caches when it takes over.

## In the page

- A soft visit or a form post that fails on the network fires `natsu:offline`
  (cancelable, `detail: { url, post }`). The pwa script lets a visit to a kept
  page go on (the worker shows it); otherwise it cancels the event and shows
  `<natsu-offline>`: the message and a Retry button. The visitor stays on the
  page they were on. It hides again when the browser is back online.
- When a new worker is installed and waiting, `<natsu-toast>` offers Reload;
  a click hands control to the new worker and reloads once.

Both are styled from a sheet in `@layer natsu`, so any rule of the page wins;
the colours come from `--natsu-pwa-bg`, `--natsu-pwa-fg`, `--natsu-pwa-line`
and `--natsu-pwa-accent`.

## Content-Security-Policy

The worker and the manifest are same-origin files: `default-src 'self'`
covers them, or name them with `worker-src 'self'` and `manifest-src 'self'`.
The offline page lives inside the worker, so no nonce is needed for it.
