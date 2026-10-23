---
'@mica-js/canvas-editor': minor
---

新增 `createCanvasScene`（#101）：把 `.cnv` 文档、`WidgetHost` 与编辑器组装成一个 `CanvasScene`。`onCommand` 交给 `host.applyCommand` 并把 `host.document` 回灌编辑器（命令失败只上报 `canvas-scene/command-failed`，不回灌、不改变编辑器状态），`host.onDocumentChange` 同样回灌并以快照引用去重，`onChange` 因此对每次提交只触发一次。`deliver` 按端点把载荷扇出给所有绑定该端点的实例，`onPublish` 用 `instanceId` + 端口反查 `CanvasBindingTarget`，无绑定时上报 `canvas-scene/unbound-publish`；`WidgetHost` 的 `onPublish` 只接受一个回调，所以场景自己维护监听器集合并通过 `receivePublish` 接收宿主转发的发布。`setMode('run')` 先取消进行中的交互；`destroy()` 只拆自己的订阅与编辑器，不 `dispose()` 宿主。
