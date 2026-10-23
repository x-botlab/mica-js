---
'@mica-js/ir': patch
---

新增 M3 类 DBT 吞吐基准 `bench/m3.bench.ts`（#150）：16 个预生成的客体基本块组成尾派发环，模型包含 16×u32 寄存器、NZCV 标志位与 256 KiB 字节内存，按周期预算批量调用 `event.at`；基准输出客体 M inst/s、相对参考解释器的倍率以及 ≥72 MHz 目标的达成比例。`bench/` 不进入构建产物。
