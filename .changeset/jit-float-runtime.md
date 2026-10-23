---
'@mica-js/ir': minor
---

新增 JIT 浮点运行时 `packages/ir/src/jit/float-runtime.ts`。

文件定义 JIT 统一的浮点值表示：D（JS `number`，仅覆盖位串全小写、NaN 为规范 NaN 的值）与 U（`number | FloatBits`，D 无法表示的大写位串、NaN 载荷以冻结 `FloatBits` 保留），并提供以下辅助：

- 边界转换 `fromBoundary` / `toBoundary` / `toNum`，输出与解释器 `fromNumber` / `toNumber` 逐字符一致；
- 位模式搬运 `fromRaw32` / `fromRaw64` / `raw32` / `raw64`，NaN 载荷不依赖宿主引擎的位模式策略；
- 正确舍入的融合乘加 `fma32`（TwoSum + round-to-odd）与 `fma64`（Boldo–Melquiond 快路径，阈值外回退到 `float-ieee.ts` 的 BigInt 精确实现）；
- 运算表中 `add/sub/mul/div`、`cmp`、`isNaN/isFinite`、`convert.*` 的 JIT 侧参考实现。

该文件仅供 JIT 内部使用，不从 `index.ts` 导出。
