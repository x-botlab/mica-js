---
'@mica-js/widget': minor
---

新增 `WidgetHost` 与 guest 运行时（#98）：单个 `@mica-js/sandbox` 承载全部 widget 实例，widget 代码经 `load` 注入、在 guest 内以 blob URL + `import()` 求值；每实例一块 `OffscreenCanvas`，按 `dpr` 缩放并以 `widget:frame` 事件转移 `ImageBitmap`；`invalidate()` 在同一 tick 内合并为一帧。宿主侧提供惰性启动、实例生命周期、`WidgetLayers` 位图缓存（新帧关闭旧帧）与 `WidgetDiagnostic` 上报，失败被限制在单个实例内。`instanceId` 在 `mount()` 入口同步预留，并发挂载同一 id 只启动一次；挂载期间被 `unmount()` 的实例以 `WidgetMountCancelledError` reject 并清理 guest 会话。
