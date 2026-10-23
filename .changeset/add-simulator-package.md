---
'@mica-js/simulator': minor
---

新增 `@mica-js/simulator`：把原理图里的器件实例跑在一条虚拟时钟上。`createDeviceSimExecutor({ devices })` 返回 `DeviceSimExecutor`：`loadSchematic(document)` 按符号建实例并跑 `initialize`（先建后换，失败保留旧运行时），`advance(delta)` **同步**推进时间片并返回 `{ from, to, executed, reason }`，`getTopics()` 给出每个实例的端口，`onPublish` / `deliver(target, payload)` 与画布互投载荷，`deliver` 收 `unknown`（端口类型由器件层校验）并延迟到下一次 `advance` 开头以保持同一时刻的调用顺序，`reset()` 用缓存的模块重建实例、`dispose()` 幂等释放——两者都是同步的，除 `loadSchematic` 外整个接口不返回 promise。取值统一为方法（`getState()` / `getSimTime()` / `getSchematic()` / `getTopics()`），`loadSchematic` 只接收已解析的 `SchematicDocument`。`getTopics()` 的每一项带 `symbol`（绑定用的符号 id）与 `designator`（位号，符号没写时回退到 id），宿主可以按位号渲染端点。`DeviceSimExecutor` 结构上满足 `@mica-js/widget` 的 `WidgetHostSimulation`，可以直接作为 `WidgetHostOptions.simulation` 挂到 `WidgetHost` 上，仿真与宿主跑在同一个 JS 线程。引脚、网络与电气求解尚未接入，属于下一里程碑。
