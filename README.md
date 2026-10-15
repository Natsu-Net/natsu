# natsu

Bun web framework behind [natsu-net](https://github.com/Natsu-Net/natsu-net) and bytesforge. It renders [uwu-template](https://github.com/Natsu-Net/uwu-template) pages and ships routing, page files, actions, client navigation, live islands, sessions and an asset pipeline with no runtime dependencies besides uwu-template.

## Setup

natsu and uwu-template are installed as sibling checkouts:

```sh
git clone https://github.com/Natsu-Net/uwu-template
git clone https://github.com/Natsu-Net/natsu
(cd uwu-template && bun install)
(cd natsu && bun install)
```

An app depends on it with `"natsu": "file:../natsu"`.

## Scripts

| Command | What it does |
| --- | --- |
| `bun test` | unit and integration tests |
| `bun run test:e2e` | navigation end to end in a real browser |
| `bun run typecheck` | `tsc --noEmit` |
| `bun run bench` | benchmarks |
| `bun run dev` | example app with watch |

## Docs

- [DESIGN.md](DESIGN.md): architecture and the move off Deno
- [docs/page-navigation.md](docs/page-navigation.md): client navigation
- `example/` and `example-pages/`: runnable apps

## v1

The Deno/Oak version lives on the [`v1`](https://github.com/Natsu-Net/natsu/tree/v1) branch.
