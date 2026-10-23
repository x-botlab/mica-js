---
'@mica-js/widget': minor
---

`WidgetHost` 接管 canvas 文档与实例协调（#118）：新增 `document`、`loadDocument(source)`、`applyCommand(command)`、`onDocumentChange(listener)` 与 `WidgetHostOptions.catalog`，宿主只声明 `.cnv` 文档与命令，按 id 比对文档后挂载、卸载、改尺寸、改属性并重排层顺序。`applyCommand` 同步提交快照与广播、协调在后台串行执行且不回滚文档；`loadDocument` 等首批实例挂载完成后 resolve。两条入口都会跑 `validateCanvasBindings`（未提供 catalog 时跳过引用校验），error 级诊断抛 `SchematicError` 且不改变任何状态。`WidgetLayers` 顺序即 `document.widgets` 顺序，`set-z` 只重排并新增 `{ type: 'reordered' }` 通知，不重新挂载。

`mount` / `unmount` / `update` / `setProperties` 从公开接口移除并降为内部实现，`WidgetMountSpec` 与 `WidgetSize` 不再导出；实例级协调改由文档驱动，`WidgetMountCancelledError` 的清理语义（同步预留 id、释放 guest 会话、不产生诊断）保持不变。
