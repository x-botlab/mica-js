---
'@mica-js/compiler': minor
'@mica-js/simulator': minor
---

Add incremental Direct JIT sessions with a fixed dispatcher, per-batch route installation and resident shard reuse. The simulator now translates and dispatches Direct code on demand instead of rebuilding a whole program, reports route/shard/dispatch diagnostics, and can opt into validated cross-window instruction-body sharing through `shareDirectBodies` and `markDirectBodyShareable`.
