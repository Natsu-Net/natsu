# Page cache

`PageCache` keeps whole rendered pages and shares them between visitors.
A page most visitors see the same way costs a map lookup and a string fill
until it is `fresh` seconds old; for `stale` seconds after that it is still
served while one request draws it again. The pages that page files draw are
kept this way for signed-out visitors on their own; a handler uses it directly:

```ts
const pages = new PageCache({ fresh: 10, stale: 30 });

const page = await pages.serve(key, [nonce, csrf], async ([nonceMark, csrfMark]) => ({
	body: await renderProduct(slug, nonceMark, csrfMark),
	status: 200,
}));
```

The render draws the marks it is handed where the visitor's secrets go, and
each answer is filled with that request's own (see `src/page-cache.ts`).

## Letting pages go when their data changes

On its own a kept page goes when it is old. A page can also say which data
it drew, with the tags `invalidate` takes, so a change lets it go at once:

```ts
const pages = new PageCache({ fresh: 10, stale: 30, invalidate: true });

await pages.serve(key, secrets, async (marks) => ({
	body: await renderProduct(slug, ...marks),
	status: 200,
	tags: [`product:${product.id}`, "catalog"],
}));

invalidate(`product:${id}`);                  // a takedown: the page is deleted
invalidate(`product:${id}`, { soft: true });  // an edit: the old page is served once more while it is redrawn
```

- **A plain invalidation deletes.** The next visitor waits on a new render.
  Use it when the old page must not be shown again: something taken down,
  hidden or moved behind a sign-in.
- **A soft one expires.** The next visitor gets the old page while one
  request draws the new one, within the page's stale time (a cache with
  `stale: 0` deletes instead). Use it for content changes, where a page a
  moment old does no harm.
- **A render under way is not kept** when one of the tags it drew is dropped
  while it runs: it read what was there before. It still answers the
  requests that were waiting on it, and no request after the drop joins it:
  until it ends nobody knows which tags it drew, so the first request after
  any drop draws its own page, and that one is kept instead.
  When a soft drop catches a page mid-render, that render stays the one
  under way: visitors keep getting the old page, and the first one after it
  ends draws the page again, so a burst of edits never stacks up renders of
  the same page.

`invalidate: true` listens for the life of the process, which suits a cache
made once at startup. `pages.listen()` does the same and returns the
function that stops it. Without either, a cache hears nothing, as before.

Invalidations a change feed brings in from other nodes
(`invalidate(tags, { remote: true, soft })`) reach the cache the same way.
To drop pages without going through `invalidate`, call the cache directly:

```ts
pages.dropTags(["product:42"], "delete");  // or "expire"; answers how many pages it let go
pages.expireAll(30);                       // everything old, none served past 30 s from now
```

`expireAll` is for when the cache can no longer tell what changed (a change
feed that lost its connection): every page is answered once more while it is
drawn again, none for longer than the given seconds, and no render under way
is kept.

A page that carries more than 64 tags (`MAX_TAGS`), or one that is not a tag
(`isTag`: letters, digits and `_.:/@+=-`, at most 160 characters), keeps none
and goes only when it is old. Tags are never part of an answer.

## Holding a page longer

A page whose data is tagged can be kept longer than the cache's own times,
since a change reaches it anyway:

```ts
return { body, status: 200, tags, hold: { fresh: 300, stale: 600 } };
```

`hold` is in seconds and replaces `fresh` and `stale` for that page only; a
value that is not a number of seconds falls back to the cache's. Keep the
hold short for a page that also draws untagged data.
