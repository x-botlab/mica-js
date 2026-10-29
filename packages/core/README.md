# @mica-js/core

Mica 仿真内核，提供整数皮秒虚拟时间、确定性事件调度、电气网络求值、连接拓扑与电源域门控。

公共子入口：`@mica-js/core/schematic` 处理 `.sch` 原理图，`@mica-js/core/canvas` 处理 `.cnv` 画布，`@mica-js/core/rpc` 提供基于 `MessagePort` 的双向 RPC，`@mica-js/core/logging` 提供日志契约，`@mica-js/core/lifecycle` 提供资源释放与事件工具。
