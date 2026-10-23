---
'@mica-js/schematic-editor': minor
---

`SchematicEditorController` 的取值属性改为方法（破坏性）：`state`、`renderState`、`document`、`selection`、`tool`、`display`、`canUndo`、`canRedo`、`placingDevice` → `getState()`、`getRenderState()`、`getDocument()`、`getSelection()`、`getTool()`、`getDisplay()`、`getCanUndo()`、`getCanRedo()`、`getPlacingDevice()`。

统一规则：实时读数一律是方法，配置项与纯数据记录（`EditorState`、`options`）仍是字段；同类改动见 `WidgetHost.getDocument()`、`CanvasScene.getMode()`、`CanvasEditor.getState()`。
