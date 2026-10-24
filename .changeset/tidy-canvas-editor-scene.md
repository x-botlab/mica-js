---
'@mica-js/canvas-editor': minor
---

合并 `createCanvasScene` 与 `mountCanvasEditor` 为单一的 `createCanvasEditor`：编辑器直接接收 `WidgetHost`，在内部通过 `host.getLayers()` 取位图，并把 command 处理、快照回灌、端口投递、发布反查与模式切换收进 `editor/mount.ts`。`createCanvasScene`、`CanvasScene`、`CanvasSceneDiagnostic` 等类型连同 `scene.ts` 一并移除；协调相关的诊断码并入 `CanvasEditorDiagnostic`（`canvas-editor/command-failed`、`change-failed`、`publish-failed`、`unbound-publish`），并新增 `CanvasEditorCoordinationDiagnostic` 与 `CanvasEditorCoordinationDiagnosticCode`。`onChange`、`onSelectionChange` 与宿主 `onPublish` 自动订阅的逻辑保持不变。
