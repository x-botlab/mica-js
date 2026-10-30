# @mica-js/core

Mica 各包共享的文档与宿主基础设施，负责原理图和画布文档、虚拟时间、RPC、日志及生命周期管理。本包提供公共契约和基础工具，不承担编辑器界面或具体器件仿真。

## 主要入口

- `@mica-js/core/schematic`：原理图文档、器件符号与相关模型。
- `@mica-js/core/canvas`：画布文档、widget 实例和绑定类型。
- `@mica-js/core/rpc`：基于 `MessagePort` 的双向 RPC。
- `@mica-js/core/logging`：日志契约。
- `@mica-js/core/lifecycle`：事件订阅与资源释放。
