---
'@mica-js/ir': minor
---

feat(ir): 内联与 Tier-2 分层重编译

- 新增 `inline` 优化 pass：按被调函数大小、调用点热度（Tier-1 剖析）与静态循环深度选择内联；递归 SCC 与含 `dispatch` / 失效 `checkpoint` 的被调函数不内联。
- MIR 位置表新增虚拟内联帧（`locs.parent` 与 `locs.inlineFrames`）。内联后的错误 `location` 与 `callStack` 沿父链逐层展开，与参考解释器逐帧一致；步段仍按调用者计算 `stepsAfter`，步数与未内联时相同。
- 新增 `jit.tierUpThreshold`（非负安全整数，默认 1000；`0` 表示首次编译直接产出 Tier-2）。Tier-1 函数序言与堆帧层都会计数，达到阈值后同步重编译为带内联和偏置布局的 Tier-2；当前激活继续在 Tier-1 中执行，之后的调用进入 Tier-2。
- `jit.artifactWarmup` 现在真正生效：Provider 产物先在堆帧层执行 K 次，随后编译（`0` 表示首次派发即编译）。产物同样保存 Tier-1/Tier-2 两层编译结果。
- `jit.optimizations.inline` 可关闭内联；pass matrix 与 parity fuzz 新增 Tier-2、`tierUpThreshold: 0/1` 及关闭内联的配置。
- 已知限制：没有 OSR。只运行一次的长循环函数不会在运行中升级；DBT 负载的产物会被反复执行，不受影响。
