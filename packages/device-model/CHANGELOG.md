# @mica-js/device-model

## 0.8.0

### Minor Changes

- 1153f68: 增量绑定 Direct JIT 函数表，复用已校验的块，并在器件模型入口公开 `validateJitFunctions`。外设 JIT 合批支持通过 `JitBatchMark.fill16` 填充连续的小端 16 位字，合批未获准时按原指令执行。SDK 同步暴露扩展后的器件接口。

## 0.7.2

### Patch Changes

- 37fb24a: Add Direct JIT timing admission and cross-instance artifact reuse.

  - `@mica-js/simulator`: add opt-in `directTiming` with `service`/`blocked` declarations and translation markers `markDirectSpan`/`markDirectLoop`; expose Direct span/loop execution metrics and rejection statistics. Marked spans fuse a proven pure prefix before an ordinary terminal write, and marked loops fold complete rounds before a normal boundary round.
  - `@mica-js/compiler`: add `compileDirectJit.createArtifactCache()`, `createSession(binding, cache?, artifactCache?)`, `clearArtifactCache()`, and `artifactCacheStats()`. The bounded artifact cache shares instruction templates, constants, resistor slots, and shard source/factory LRU entries across sessions; stats report hits, compiles, entries, source units, and evictions.
  - `@mica-js/device-model`: reuse structurally equal JIT function tables and cheap-shape-gated validated bound blocks. Object identity remains the fast path; structural digests only filter candidates before full IR confirmation.
  - Add opt-in `shareDirectArtifacts` (default `false`), `translationIdentity` with dependency-range validation, and `directTier.promoteAfter` for per-PC generic-to-Direct promotion. Omitting `directTier` keeps the existing immediate-Direct behavior.
  - Compile generic instruction bodies lazily on first generic execution, so Direct-resident code does not pay for unused generic compilation.

## 0.7.1

### Patch Changes

- ee48660: 绑定校验只对已通过 `validateDeviceIR` 缓存命中的器件采用单次结构遍历；未缓存器件保持“独立结构校验 → 器件校验 → 绑定”的原顺序，结构无效块不会校验或缓存器件。JIT 块继续对用户枚举要求默认分支、内置枚举仍可穷尽；绑定失败补跑独立遍历并保持原有首个诊断与 locateError 语义。快照、缓存、冻结结果与最终绑定身份不变。

## 0.7.0

### Minor Changes

- 42ac451: 新增 `buildJitFunctions` 与 `JitFunctionBuilder`，允许为单个 JIT 入口构建同步函数；导出 `validateDeviceIR`。减少嵌套区域和复杂分支的重复校验，降低大型器件模型的冷启动开销，保留原有校验语义。

## 0.6.0

### Minor Changes

- 8439e45: 对全部可发布包统一推进一个 minor 版本，用一次发布会话走完 `release.yml` 的 OIDC 信任发布流程。

  - 每个包各发布一个新版本，使 npm trusted publishing 在 11 个包上逐一完成校验；此前 `@mica-js/scene-3d` 因包名在 registry 中不存在而无法走 OIDC，首次版本由人工发布补位。
  - `@mica-js/simulator` 的 2.1.1 在改动前未进入 registry，本次随 minor 推进覆盖该版本。
  - 本 changeset 只做版本推进，不包含源码或行为变更。

## 0.5.0

### Minor Changes

- New architecture for mica simulator and refactoring of editor package
