---
'@mica-js/widget': minor
---

新增 `WidgetHost.reset()`（#101）：丢弃全部实例、清空 guest 的模块缓存后，按当前文档重新 `load` + `mount`，让 widget 回到初始状态。`layers` 在调用时同步清空（编辑器立刻画占位框），promise 在全部实例重新挂载后 resolve；`props` / `assets` 重新合并与预取。重置与其它协调共用同一条队列，不会与进行中的挂载交错；失败只上报 `widget/runtime-failed`，不 reject。

guest 新增 `reset-runtime` 方法：卸载所有 session（释放画布、清订阅、丢弃工厂实例）并清空工厂/blob URL 缓存，使下一次 `load` **重新求值模块**——只重建工厂实例会让模块顶层变量（如 `let counter = 0;`）跨重置保留。guest 自身不终止，sandbox 得以复用。
