# @mica-js/core

Mica 各包共享的虚拟时间、RPC、日志与生命周期基础设施。文档格式与原理图、画布模型由 `@mica-js/document` 提供。

## 主要入口

- `@mica-js/core`：整数皮秒时间工具与包版本。
- `@mica-js/core/rpc`：基于 `MessagePort` 的双向 RPC。
- `@mica-js/core/logging`：日志契约。
- `@mica-js/core/lifecycle`：事件订阅与资源释放。
