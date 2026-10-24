---
'@mica-js/ir': minor
---

新增 JIT 小循环展开 pass（#157），消除短循环的回边检查与控制流开销：

- `jit/passes/loop-unroll.ts`：用 `cfg.ts` 的自然循环与 `range.ts` 的区间分析识别常量迭代次数的规范计数循环（头块 + 单 latch、唯一前驱边、唯一出口）。0–4 次迭代完全展开；8 次 → 2×4、16 次 → 4×4 部分展开；迭代体超过 50 条指令、体含宿主指令/`checkpoint`/可抛值错误操作、或非可归约循环一律不展开。
- 展开保持步数与可观测语义：被消去的头块分支在每个副本原位留下 `step = 1` 的 `check`，克隆指令保留原 `step`/`loc`（每个副本分配新的 location id，`stepsAfter` 因此仍然正确），归纳变量在完全展开时替换为常量，`stepObserver`/预算协议看到完全相同的步序列。
- 代码大小由「每次展开消耗函数预算」控制：单函数增长额度为 `max(128, 函数指令数 × 20%)`，超出时从完全展开降级为部分展开，再不行则不展开。
- `jit/passes/pipeline.ts`：流水线顺序变为 `sccp → gvn → range → licm → unroll → dce`，让 DCE 清理展开后不可达的原循环块；`IRJITOptimization` 新增 `unroll` 开关（默认开启），pass matrix 随之增加一行。
- `jit/cfg.ts`：`dominanceFrontiers` 忽略不可达前驱，支持「保留死块交给 DCE」的变换。
- 测试：`passes/loop-unroll.test.ts` 覆盖 0–4 次完全展开、8/16 次部分展开、大小/预算降级、宿主与可抛体拒绝，并与参考解释器逐值逐步对比（含 `stepObserver` 与预算耗尽位置）。
- 基准：`bench/loops.bench.ts` 对比 `unroll` 开关的循环吞吐（本机约 +10–15%）；M3 基准的客体块是直线代码、没有 IR 循环，生成的代码逐字节不变。
