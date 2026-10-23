# @mica-js/schematic-editor

## 0.2.1

### Patch Changes

- Updated dependencies [dea8509]
  - @mica-js/core@0.3.0

## 0.2.0

### Minor Changes

- 81596f3: `SchematicEditorController` 的取值属性改为方法（破坏性）：`state`、`renderState`、`document`、`selection`、`tool`、`display`、`canUndo`、`canRedo`、`placingDevice` → `getState()`、`getRenderState()`、`getDocument()`、`getSelection()`、`getTool()`、`getDisplay()`、`getCanUndo()`、`getCanRedo()`、`getPlacingDevice()`。

  统一规则：实时读数一律是方法，配置项与纯数据记录（`EditorState`、`options`）仍是字段；同类改动见 `WidgetHost.getDocument()`、`CanvasScene.getMode()`、`CanvasEditor.getState()`。

### Patch Changes

- Updated dependencies [9ea9858]
- Updated dependencies [f6c9dac]
- Updated dependencies [d699e7f]
- Updated dependencies [c5b688e]
- Updated dependencies [645e731]
  - @mica-js/core@0.2.0

## 0.1.1

### Patch Changes

- b98b39d: 修复框选 T 型连接后删除报未知交点：删除导线时已顺带移除的交点不再重复删除，整笔删除不再回滚。
- Updated dependencies [69dc4b0]
  - @mica-js/core@0.1.1

## 0.1.0

### Minor Changes

- 503b44b: 首个公开版本：把 `.sch` 渲染成可编辑的 Canvas 画布，含选择/框选、网格吸附拖动、旋转、导线段改形、导线模式与 T 型接入、位号拖动、只读模式，以及宿主驱动的器件放置与属性面板合同。

### Patch Changes

- Updated dependencies [503b44b]
  - @mica-js/core@0.1.0
