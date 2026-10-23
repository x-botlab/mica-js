---
'@mica-js/ir': minor
'@mica-js/device': minor
'@mica-js/core': patch
---

实现 Provider 生成、依赖跟踪与缓存（#60）：`ir.provider` 声明固定 key/参数/结果布局、生成期受追踪读取与产物可引用引用；`gen.readBytes`/`readState`/`readArray` 登记实际覆盖的版本单元（state/array 使用整资源单元），产物经既有 `validateIR`、imports 白名单与解释器执行。`dispatch` 作为终结指令按规范化 key 复用或按需重生成产物，每次派发校验全部依赖，缓存按实例隔离。新增 `IRProviderError` 与可区分的声明/读取/生成/产物/依赖错误码；生成产物写入自身读依赖时明确拒绝（运行中恢复属于 #61）。device 的 `api.ir.provider` 与 core 的调度接入同步可用。
