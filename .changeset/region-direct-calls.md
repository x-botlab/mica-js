---
'@mica-js/ir': minor
---

新增区域间直接调用（#156），去掉热循环跨区域时的 `TAIL` 蹦床往返：

- `jit/codegen/emit.ts`：区域出口的缓存命中不再先返回 `TAIL` 再交给 `runTail` 从驱动循环重新进入，而是直接 `handle.fn(state.regionIndex, ...)` 进入目标区域（`inlineTail`）。被调用区域的序言照旧刷新 epoch 表与晋升值，`rt.depth` 在返回后恢复；超过 `REGION_DIRECT_CALL_DEPTH`（8 层）时退回蹦床，保证 JS 栈有界。调用前把 `L` 置为 `-1`，callee 抛错时不会把调用方的位置追加进调用栈，可观测语义与改动前一致。
- `jit/region.ts`：新增区域身份 `regionKeyOf`（provider + 排序后的 artifact 索引）、出口采样表 `RegionExitProfile` 与 `recordRegionExit`（8 个槽位、计数饱和、预算有界）以及直接调用深度常量；`CompiledRegion` 增加 `runtime`、`key` 与 `directCallDeps`。
- `jit-runtime.ts`：`regionExit` 采样入口 + 反向依赖图 `#regionDependents`（区域 key → 调用方集合）。某个出口目标达到 `REGION_DIRECT_CALL_THRESHOLD`（256 次）后重编译该区域，用 top-4 热目标生成字面值 guard（`key`、storage epoch、cache epoch 都是常量，任何一项不匹配就回退到 jump cache / `materialize`）；重编译后立即刷新所有依赖它的区域，避免继续引用旧的成员布局。区域重编译上限为 2 次/区域，刷新不占额度，环状依赖由 `seen` 集合截断。
- `IRJITOptimization` 新增 `regionDirectCall` 开关（默认开启），关闭后区域行为与 #154 完全一致；`jitInternals` 增加 `regionRebuilds` 与 `regionDirectCalls` 诊断。
- 测试：`region.test.ts` 覆盖区域身份、采样饱和/预算、40 块环分裂成多个区域后跨区域直调（含与参考解释器逐值逐步对比）、区域源码体积增长 < 10%、以及直接调用路径上 trap 的错误码/步数/调用栈与参考一致。
- 基准：`bench/m3.bench.ts` 的 jit-default 从约 97 M inst/s 提升到 115–127 M inst/s。
