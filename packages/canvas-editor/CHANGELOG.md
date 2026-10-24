# @mica-js/canvas-editor

## 0.2.0

### Minor Changes

- 923cc9f: 合并 `createCanvasScene` 与 `mountCanvasEditor` 为单一的 `createCanvasEditor`：编辑器直接接收 `WidgetHost`，在内部通过 `host.getLayers()` 取位图，并把 command 处理、快照回灌、端口投递、发布反查与模式切换收进 `editor/mount.ts`。`createCanvasScene`、`CanvasScene`、`CanvasSceneDiagnostic` 等类型连同 `scene.ts` 一并移除；协调相关的诊断码并入 `CanvasEditorDiagnostic`（`canvas-editor/command-failed`、`change-failed`、`publish-failed`、`unbound-publish`），并新增 `CanvasEditorCoordinationDiagnostic` 与 `CanvasEditorCoordinationDiagnosticCode`。`onChange`、`onSelectionChange` 与宿主 `onPublish` 自动订阅的逻辑保持不变。

## 0.1.1

### Patch Changes

- Updated dependencies [dea8509]
  - @mica-js/core@0.3.0
  - @mica-js/widget@0.1.1

## 0.1.0

### Minor Changes

- 0500c70: 新增 `@mica-js/canvas-editor`（#100）：把 `.cnv` 文档与 `WidgetLayers` 位图合成到一块画布，并把指针/键盘操作翻译成 `CanvasCommand`。编辑器不持有文档、不修改文档、不启动 sandbox：编辑模式只通过 `onCommand` 上报 `set-placement` / `remove-instance`，运行模式只通过 `dispatch` 转发命中的实例输入。命中测试、包围盒、手柄、缩放/旋转计算与视口限幅均为无 DOM 的纯模块；重绘由 `#dirty` 标志 + 单次 `requestAnimationFrame` 合并，空闲时不调度帧。
- d5b899c: 新增 `createCanvasScene`（#101）：把 `.cnv` 文档、`WidgetHost` 与编辑器组装成一个 `CanvasScene`。`onCommand` 交给 `host.applyCommand` 并把 `host.getDocument()` 回灌编辑器（命令失败只上报 `canvas-scene/command-failed`，不回灌、不改变编辑器状态），`host.onDocumentChange` 同样回灌并以快照引用去重，`onChange` 因此对每次提交只触发一次。`deliver` 按端点把载荷扇出给所有绑定该端点的实例，`onPublish` 用 `instanceId` + 端口反查 `CanvasBindingTarget`，无绑定时上报 `canvas-scene/unbound-publish`；`WidgetHost` 的 `onPublish` 只接受一个回调，所以场景自己维护监听器集合并通过 `receivePublish` 接收宿主转发的发布。`setMode('run')` 先取消进行中的交互；`destroy()` 只拆自己的订阅与编辑器，不 `dispose()` 宿主。新增 `CreateCanvasSceneOptions.onSelectionChange`，透传 `mountCanvasEditor` 的选择变化，宿主据此驱动属性/绑定面板。`CreateCanvasSceneOptions.document` 只接收解析好的 `CanvasDocument`，`.cnv` 文本由应用侧先用 `parseCanvas` 解析。

  运行模式不再是只读画布：`wheel()` 与编辑模式一致（`Shift` + 滚轮横向平移、普通滚轮以指针为锚缩放），中键或空格 + 左键拖动平移视口。这些视口操作不产生命令、不转发给 widget，中键/空格拖动也不把按下路由给实例；运行模式左键按在实例上仍按原样转发实例局部坐标的 `pointerdown` / `pointermove` / `pointerup` / `pointercancel`。

  `setMode(mode)` 改为返回 `Promise<void>` 并**重置全部 widget**：先 `cancelInteraction()`、再 `setMode`、最后 `await host.reset()`，因此切换模式后 widget 回到初始状态（实例重建；模块只求值一次，实例状态在工厂闭包里）。`getMode()` 立即返回新值，promise 在重置完成后 resolve；切到当前模式直接 resolve 不重置，重置失败则回退模式并 reject。

  编辑模式新增每个实例一圈半透明的强调色边框（新主题 token `outline`，先垫一层深色描边再画主色）：完全透明的 widget 画不出任何像素，没有这圈边框就找不到它的位置。边框画在位图之上、选中框之下，运行模式不画。

  新增 `CanvasScene.setSelection(ids)`：宿主的图层列表可以据此驱动编辑器选择，`onSelectionChange` 照常回报结果；文档里不存在的 id 会被丢掉，避免留下画不出来的选择。

### Patch Changes

- Updated dependencies [9ea9858]
- Updated dependencies [f6c9dac]
- Updated dependencies [d699e7f]
- Updated dependencies [c5b688e]
- Updated dependencies [645e731]
- Updated dependencies [1a53efa]
- Updated dependencies [03577fe]
- Updated dependencies [3c5fd48]
- Updated dependencies [e62fa7d]
  - @mica-js/widget@0.1.0
  - @mica-js/core@0.2.0
