---
'@mica-js/compiler': minor
'@mica-js/device-model': minor
'@mica-js/sdk': minor
'@mica-js/simulator': minor
---

增量绑定 Direct JIT 函数表，复用已校验的块，并在器件模型入口公开 `validateJitFunctions`。外设 JIT 合批支持通过 `JitBatchMark.fill16` 填充连续的小端 16 位字，合批未获准时按原指令执行。SDK 同步暴露扩展后的器件接口。
