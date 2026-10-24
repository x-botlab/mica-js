---
'@mica-js/ir': patch
---

新增区域融合基准 `bench/region-fusion.bench.ts`（#158）：4 个 provider artifact 组成状态机尾派发环，每个状态在入口块、工作块与出口块重复读取共享配置（`state` 标量与常量下标 `array` 表）。热身后 O01 把环融合成一个区域函数，基准对比 `jit.optimizations.loadElim`（O03）开关下同一 op 的 4096 次状态转换吞吐，并断言区域确实由 4 个 artifact 组成、O03 消除了被支配块中的冗余表读取、两种配置与参考解释器逐值逐步一致。`bench/` 不进入构建产物。
