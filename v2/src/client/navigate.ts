// placeholder: replaced by the client runtime
/// <reference lib="dom" />
// Stand-in so Assets.build() has an entry to bundle while the real runtime (spec N2) is written.
(globalThis as { natsu?: unknown }).natsu ??= {};
