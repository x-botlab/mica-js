# @mica-js/widget

## 0.1.2

### Patch Changes

- @mica-js/core@0.3.1

## 0.1.1

### Patch Changes

- Updated dependencies [dea8509]
  - @mica-js/core@0.3.0

## 0.1.0

### Minor Changes

- 9ea9858: 新增 `@mica-js/widget`：Widget 定义、`WidgetProvider` 接口、静态 provider 与包加载（含路径校验、内容哈希、缓存）。`@mica-js/core/canvas` 增补 `PAYLOAD_TYPES`、`parsePayloadType`、`isAssignable` 与 `PayloadType` 导出，供 widget 端口类型校验复用。
- 1a53efa: `WidgetHost` 接管 canvas 文档与实例协调（#118）：新增 `getDocument()`、`loadDocument(document)`、`applyCommand(command)`、`onDocumentChange(listener)` 与 `WidgetHostOptions.catalog`，宿主只声明 `.cnv` 文档与命令，按 id 比对文档后挂载、卸载、改尺寸、改属性并重排层顺序。`loadDocument` 只接收解析好的 `CanvasDocument`，文本由调用方先用 `parseCanvas` 解析（宿主仍会重新校验，坏文档抛同类 `SchematicError`）。`applyCommand` 同步提交快照与广播、协调在后台串行执行且不回滚文档；`loadDocument` 等首批实例挂载完成后 resolve。两条入口都会跑 `validateCanvasBindings`（未提供 catalog 时跳过引用校验），error 级诊断抛 `SchematicError` 且不改变任何状态。`WidgetLayers` 顺序即 `document.widgets` 顺序，`set-z` 只重排并新增 `{ type: 'reordered' }` 通知，不重新挂载。当前快照与图层存储统一通过 `getDocument()` / `getLayers()` 读取，接口上不再暴露 `document` / `layers` 字段。

  `mount` / `unmount` / `update` / `setProperties` 从公开接口移除并降为内部实现，`WidgetMountSpec` 与 `WidgetSize` 不再导出；实例级协调改由文档驱动，`WidgetMountCancelledError` 的清理语义（同步预留 id、释放 guest 会话、不产生诊断）保持不变。

- 03577fe: 新增 `WidgetHost.reset()`（#101）：丢弃全部实例、同步清空 `layers` 后，按当前文档在**同一条**协调队列里重新 `mount`，让 widget 回到初始状态。每次挂载都会重新调用工厂（新闭包、新画布、新订阅、初始 props），promise 在全部实例重新挂载后 resolve；`props` / `assets` 重新合并与预取。重置与其它协调共用一条队列，不会与进行中的挂载交错；失败只上报 `widget/runtime-failed`，不 reject。

  **重置不重新求值模块**：guest 保留已求值的工厂与定义，`load` 对同一 widget 幂等，因此不会再次 `import`。这与 #2 的约定一致——模块顶层只放共享常量与纯函数，实例状态全部放在工厂闭包内；顶层若有状态属于 widget 自身 bug，运行时不为它兜底。guest 新增 `reset-runtime` 方法，只卸载 session（释放画布、清订阅、丢弃工厂实例），不终止 guest，也不清模块缓存。

  资源属性（`{ src, mode }`）发生变化时改为**重挂载**该实例：字节只在挂载时预取，`set-properties` 不携带资源，若只推属性 guest 会在 `api.assets.readBinary` 上拿到「未预取」。没有新资源时属性变化仍只发 `set-properties`，不打断实例。

- 3c5fd48: 新增 `WidgetHost` 与 guest 运行时（#98）：单个 `@mica-js/sandbox` 承载全部 widget 实例，widget 代码经 `load` 注入、在 guest 内以 blob URL + `import()` 求值；每实例一块 `OffscreenCanvas`，按 `dpr` 缩放并以 `widget:frame` 事件转移 `ImageBitmap`；`invalidate()` 在同一 tick 内合并为一帧。宿主侧提供惰性启动、实例生命周期、`WidgetLayers` 位图缓存（新帧关闭旧帧）与 `WidgetDiagnostic` 上报，失败被限制在单个实例内。`instanceId` 在 `mount()` 入口同步预留，并发挂载同一 id 只启动一次；挂载期间被 `unmount()` 的实例以 `WidgetMountCancelledError` reject 并清理 guest 会话。
- e62fa7d: `WidgetHostOptions.simulation`（`WidgetHostSimulation`）把宿主接到仿真上：`onPublish` 给出的 `target` 与实例 `bindings` 里的端点相同时，宿主向对应端口 `deliver(payload, simTime)`，一个端点绑了多个实例就逐个投递；widget 发布的端口有绑定则调用 `simulation.deliver(binding, payload)`，未绑定的端口仍只在宿主侧走 `onPublish`。转发失败上报 `widget/deliver-failed`，不影响 `onPublish` 派发；`dispose()` 退订。接口只有 `onPublish` / `deliver` 两个同步方法，`DeviceSimExecutor`（`@mica-js/simulator`）结构上直接满足，宿主与仿真跑在同一个 JS 线程。

### Patch Changes

- Updated dependencies [9ea9858]
- Updated dependencies [f6c9dac]
- Updated dependencies [d699e7f]
- Updated dependencies [c5b688e]
- Updated dependencies [645e731]
  - @mica-js/core@0.2.0
