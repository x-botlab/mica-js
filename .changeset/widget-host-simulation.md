---
'@mica-js/widget': minor
---

`WidgetHostOptions.simulation`（`WidgetHostSimulation`）把宿主接到仿真上：`onPublish` 给出的 `target` 与实例 `bindings` 里的端点相同时，宿主向对应端口 `deliver(payload, simTime)`，一个端点绑了多个实例就逐个投递；widget 发布的端口有绑定则调用 `simulation.deliver(binding, payload)`，未绑定的端口仍只在宿主侧走 `onPublish`。转发失败上报 `widget/deliver-failed`，不影响 `onPublish` 派发；`dispose()` 退订。接口只有 `onPublish` / `deliver` 两个同步方法，`DeviceSimExecutor`（`@mica-js/simulator`）结构上直接满足，宿主与仿真跑在同一个 JS 线程。
