---
'@mica-js/ir': minor
'@mica-js/simulator': patch
---

放宽可观测等价约束：检查点粒度从「每条指令」改为「tick 边界」（默认），让 JIT 可以跨指令、跨派发边界优化。

- **检查点协议**：新增 `CheckpointGranularity`（`'per-instruction' | 'per-tick' | 'per-safepoint'`，见 `types.ts`）与 `jit.checkpointGranularity`（默认 `'per-tick'`）。默认模式下一次 `execute` 是一个检查点：region 可以把提升后的存储、步数计数器与 `ctl.suspended`/epoch 留在局部变量里跨派发复用，tick 中间的派发可能被完全优化掉；`'per-instruction'` 关闭这些跨边界优化，让每个 MIR 块可观测（单步调试）。三种模式下 tick 结束时的存储、epoch、Provider 缓存、步数与任何错误字段仍逐项一致；`maxSteps` 有界时每一步都是检查点，引擎自动退回逐块计步。
- **region 提升扩展到数组与字节区间**：常量下标的数组元素（翻译后的寄存器堆）与常量偏移的 `bytes` 区间（GPIO 的 ODR/DIR）现在提升为 region 级共享局部量。提升是保守的：只要同一资源在 region 内出现动态下标/偏移访问、重叠的常量区间、浮点区间或 `bytes.copy`/`fill`，整个资源留在存储里（`region.test.ts` 覆盖这几种拒绝路径）。
- **region 成员局部量上提**：成员的 SSA 局部量与临时量改为在 region 帧里只声明一次，成员重入不再重复初始化（大 artifact 上尤其明显）。
- **跨块批处理**：步数计数器改为 region 局部累加，在每次出口、host 指令与错误展开前写回；`ctl.suspended` 与两个 epoch 在 region 入口读入、`materialize` 之后重新读取。
- **`validatedEpoch` 只在含 `checkpoint` 的成员入口写回**（该字段只是检查点的快速路径提示，陈旧只会多走一次依赖校验）。
- **`@mica-js/simulator` teaching MCU**：每个 artifact 只保留一个边界块（后继 PC 作为值传递），因此 artifact 可被结构化而不是退化成 `switch (pc)`；pin 内存发布移到 artifact 让出时（tick 边界），不再每个客体基本块发布一次；`r0 & 1` latch 到 ODR 仍然每块执行。
- **性能**（`teaching-mcu.performance.test.ts`，本机）：teaching ISA 批处理 170–182 → 486–505 M inst/s，M3 批处理 480–495 → 583–595 M inst/s；测试新增 450 M inst/s 门槛，并对度量取「多轮中位数的最小值」以抵抗同机并行测试的干扰。
- **测试**：`parity-fuzz.test.ts` 说明并按三种粒度运行差分测试（含 unbounded budget 的批处理路径）；`region.test.ts` 新增提升选择与生成代码形状的断言。
