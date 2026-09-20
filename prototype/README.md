# natsu v2 prototype

End-to-end proof of the Bun rework: `Bun.serve` + uwu-template reactive
rendering + a WebSocket carrying patches, driven by the decorator API.

```bash
bun install
bun run server.ts     # open the printed URL
```

The counter increments from the server every 300 ms with no client polling and
no page reload. The button calls a server-side `@Action`.

`e2e.mjs` drives a real browser against a running server and asserts the five
behaviours the design depends on: server push reaches the DOM, a client action
round-trips, a writable field is accepted, a read-only field is refused, and no
reload happens during any of it.

```bash
node e2e.mjs          # needs `npm i playwright` and a running server
```

This directory is a prototype, not the shipping framework. See `../DESIGN.md`.
