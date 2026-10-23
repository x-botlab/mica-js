---
'@mica-js/ir': minor
---

新增内部存储与 Provider 运行时快路径：`storageInternals` 符号暴露记录级 typed view / `DataView`、存储 `epoch` 与写挂起计数、`advanceScalar`，`ProviderRuntime` 增加 `cacheEpoch`。这些接口仅供 JIT 直接访问底层字节并做 O(1) 缓存校验，不从包入口导出，公开行为保持不变。
