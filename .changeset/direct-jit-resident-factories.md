---
'@mica-js/compiler': minor
---

缩短 direct JIT 的编译与执行时间：在有界 LRU 中复用未绑定的驻留分片工厂，保留每个实例独立的绑定；支持同帧调用同步函数、直编引脚采样和意图写入，以及在发布边界安全续跑。不能直编的操作仍走原回退路径。

`DirectJitFrame` 的 `stateDirty` 和 `memoryDirty` 现在也可用 `Int32Array`，自定义宿主应按索引访问这些位图。
