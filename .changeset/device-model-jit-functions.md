---
'@mica-js/device-model': minor
---

新增 `buildJitFunctions` 与 `JitFunctionBuilder`，允许为单个 JIT 入口构建同步函数；导出 `validateDeviceIR`。减少嵌套区域和复杂分支的重复校验，降低大型器件模型的冷启动开销，保留原有校验语义。
