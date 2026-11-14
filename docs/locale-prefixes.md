# Language prefixes

`app.localePrefixes({ prefixes: ["fr"], exclude: ["/auth/", "/sitemap.xml"] })` serves every route a second time under
each prefix. `/fr/servers/12` runs the `/servers/:id` route:

- the app sees the request without the prefix (`ctx.path` is `/servers/12`), so routes, middleware and path checks
  do not change;
- `ctx.locale` is `"fr"` (undefined on a bare URL), the app picks its texts from it;
- `ctx.localize("/me")` gives `/fr/me`, for URLs built outside HTML (JSON, scripts, mail).

The answer keeps the visitor in their language: same-site `<a href>` and `<form action>` in HTML, `Location` and
`natsu-location` get the prefix. Rewriting skips excluded paths, paths with a file extension, targets that already carry
a prefix and any `<a>`/`<form>` with `hreflang` or `data-locale="off"` (a language switcher). Links are rewritten
inside the middleware chain, before compression; a page a middleware answers by itself is rewritten at the end of the
request if its body is still text.

The default language keeps the bare URLs. Excluded paths are not served under a prefix at all (a 404), which suits an
OAuth callback or a feed whose URL is registered elsewhere.

Pages from `mountPages` follow the prefix too: the default canonical is the public URL plus the path with its prefix
(`https://site/fr/about`), the page cache keys `/fr/about` and `/about` apart, and `<page canonical="{{...}}">` names
another address (a path or a URL), for a page shown in a language it is not written in yet.
