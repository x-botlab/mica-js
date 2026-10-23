---
'@mica-js/simulator': minor
---

新增 `@mica-js/simulator`：把原理图里的器件实例跑在一条虚拟时钟上。`createDeviceSimExecutor({ devices })` 返回 `DeviceSimExecutor`：`loadSchematic(document)` 按符号建实例并跑 `initialize`（先建后换，失败保留旧运行时），`advance(delta)` **同步**推进时间片并返回 `{ from, to, executed, reason }`，`getTopics()` 给出每个实例的端口，`onPublish` / `deliver(target, payload)` 与画布互投载荷，`deliver` 延迟到下一次 `advance` 开头以保持同一时刻的调用顺序，`reset()` 重建实例、`dispose()` 幂等释放。取值统一为方法（`getState()` / `getSimTime()` / `getSchematic()` / `getTopics()`），`loadSchematic` 只接收已解析的 `SchematicDocument`。引脚、网络与电气求解尚未接入，属于下一里程碑。
