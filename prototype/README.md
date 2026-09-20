# natsu v2 prototype

End-to-end proof of the rework: `Bun.serve` + uwu-template precise-targeting
hydration + a WebSocket carrying patches, driven by the decorator API.

```bash
bun install
bun run server.ts     # open the printed URL
```

The whole client is one line:

```ts
import { live } from "uwu-template/live";
live();
```

`live()` hydrates the server markup, opens the socket, reconnects with
backoff, and resyncs after a gap. The runtime is 8.8 KB minified.

## What `e2e.mjs` asserts

It drives a real browser against a running server and checks the behaviours the
design depends on, including the precise-targeting claims — a MutationObserver
counts what actually changed in the DOM:

- a server-side write reaches the DOM with no reload and no polling
- renaming one row's field causes **zero** node insertions or removals, only
  `characterData` and `attributes` mutations
- sibling rows keep their exact DOM nodes
- growing a list adds one row and leaves the existing rows' nodes alone
- an attribute-bound value updates its element rather than a text range
- a bound input writes back to the server
- a read-only field refuses a client write
- a region rendered from plain data is never mutated (partial hydration)

```bash
npm i playwright
node e2e.mjs          # needs a running server
```

This directory is a prototype, not the shipping framework. See `../DESIGN.md`.
