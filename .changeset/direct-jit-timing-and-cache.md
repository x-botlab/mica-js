---
'@mica-js/compiler': minor
'@mica-js/simulator': minor
'@mica-js/device-model': patch
---

Add Direct JIT timing admission and cross-instance artifact reuse.

- `@mica-js/simulator`: add opt-in `directTiming` with `service`/`blocked` declarations and translation markers `markDirectSpan`/`markDirectLoop`; expose Direct span/loop execution metrics and rejection statistics. Marked spans fuse a proven pure prefix before an ordinary terminal write, and marked loops fold complete rounds before a normal boundary round.
- `@mica-js/compiler`: add `compileDirectJit.createArtifactCache()`, `createSession(binding, cache?, artifactCache?)`, `clearArtifactCache()`, and `artifactCacheStats()`. The bounded artifact cache shares instruction templates, constants, resistor slots, and shard source/factory LRU entries across sessions; stats report hits, compiles, entries, source units, and evictions.
- `@mica-js/device-model`: reuse structurally equal JIT function tables and cheap-shape-gated validated bound blocks. Object identity remains the fast path; structural digests only filter candidates before full IR confirmation.
- Add opt-in `shareDirectArtifacts` (default `false`), `translationIdentity` with dependency-range validation, and `directTier.promoteAfter` for per-PC generic-to-Direct promotion. Omitting `directTier` keeps the existing immediate-Direct behavior.
- Compile generic instruction bodies lazily on first generic execution, so Direct-resident code does not pay for unused generic compilation.
