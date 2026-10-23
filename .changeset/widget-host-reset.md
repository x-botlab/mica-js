---
'@mica-js/widget': minor
---

新增 `WidgetHost.reset()`（#101）：丢弃全部实例、同步清空 `layers` 后，按当前文档在**同一条**协调队列里重新 `mount`，让 widget 回到初始状态。每次挂载都会重新调用工厂（新闭包、新画布、新订阅、初始 props），promise 在全部实例重新挂载后 resolve；`props` / `assets` 重新合并与预取。重置与其它协调共用一条队列，不会与进行中的挂载交错；失败只上报 `widget/runtime-failed`，不 reject。

**重置不重新求值模块**：guest 保留已求值的工厂与定义，`load` 对同一 widget 幂等，因此不会再次 `import`。这与 #2 的约定一致——模块顶层只放共享常量与纯函数，实例状态全部放在工厂闭包内；顶层若有状态属于 widget 自身 bug，运行时不为它兜底。guest 新增 `reset-runtime` 方法，只卸载 session（释放画布、清订阅、丢弃工厂实例），不终止 guest，也不清模块缓存。
