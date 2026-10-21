# @mica/schematic-editor

原理图与 2D 视图的 Canvas 编辑器，渲染 `@mica/core/schematic` 的文档。

## 入口

- 包根导出主题（`SchematicTheme`、`DARK_SCHEMATIC_THEME`、`LIGHT_SCHEMATIC_THEME`、`resolveSchematicTheme`、`themeToCssVariables`）、视口（`ViewportState`、`ViewportLimits`、`DEFAULT_VIEWPORT_LIMITS`、`resolveViewportLimits`）与控制器/编辑器类型。
- 场景构建、Canvas 渲染器与输入状态机为内部模块。

## 宿主 API

```ts
import { mountSchematicEditor } from '@mica/schematic-editor';

const editor = mountSchematicEditor({
  container, // 必填；编辑器只往里 append 自己的 root
  schematic, // 必填；SchematicDocument
  view, // 可选；.view 文档，仅作为渲染覆盖
  devices, // 可选；DeviceSymbolProvider
  theme, // 可选；Partial<SchematicTheme>
  display, // 可选；Partial<DisplayOptions>
  tolerance, // 可选；命中/几何容差（页面单位）
  historyLimit, // 可选；撤销栈上限
  zoomLimits, // 可选；{ minScale, maxScale }，默认 0.25–4
  readOnly, // 可选；禁用内建交互与属性编辑，controller 仍可写
  toolbar, // 可选；默认 true
  propertiesPanel, // 可选；默认 true
  onChange, // (state: EditorState) => void
  onSelectionChange, // (selection: EditorSelection[]) => void
  onToolChange, // (tool: EditorTool) => void
  onError, // (error: SchematicError | undefined) => void
  onViewportChange, // (viewport: ViewportState) => void
});
```

返回值 `MountedSchematicEditor`：

| 成员                                       | 说明                                                                   |
| ------------------------------------------ | ---------------------------------------------------------------------- |
| `controller`                               | 无 DOM 的 `SchematicEditorController`，可直接驱动文档                  |
| `root` / `canvas` / `propertiesPanel`      | 三个可定位的 DOM 节点                                                  |
| `setSchematic(document, { keepHistory? })` | 换文档；默认清空历史并重新适应内容，`keepHistory` 时作为一次可撤销编辑 |
| `setView(view \| undefined)`               | 换只读视图覆盖                                                         |
| `setTheme(partial)` / `getTheme()`         | 增量换主题 / 读回当前主题                                              |
| `setDisplayOptions(patch)`                 | 网格、吸附、引脚标签、网格尺寸                                         |
| `setTool(tool)`                            | `select` / `wire` / `power` / `ground` / `label` / `text`              |
| `fitToContent()` / `zoomTo(scale)`         | 视图缩放，`zoomTo` 会夹到 `zoomLimits`                                 |
| `getViewport()` / `setViewport(state)`     | 读回/恢复缩放与平移；恢复时按画布中心夹取比例                          |
| `toJSON()`                                 | 序列化为 `.sch` JSON                                                   |
| `resize()` / `invalidate()`                | 容器显隐后重新测量 / 只重绘不改布局                                    |
| `undo()` / `redo()`                        | 历史                                                                   |
| `dispose()`                                | 解绑监听、断开 `ResizeObserver`、移除 root                             |

回调时序：控制器发状态 → 面板/工具条/错误提示更新 → `onSelectionChange` / `onToolChange` / `onError`（仅在变化时）→ `onChange(state)` → 重绘 → `onViewportChange`（仅在视口变化时）。

编辑错误：编辑器内建交互（拖拽、工具栏、属性面板）产生的错误不会抛给宿主，只会触发 `onError` 并写入 `state.lastError`；但直接调用 `controller.dispatch()` 等方法时仍会抛出 `SchematicError`，宿主自行 `try/catch` 即可（`onError` 同样会先触发）。

## 控制器

`SchematicEditorController` 不依赖 DOM，可单独用于批量编辑或 Node 环境：

- 读状态：`state`、`document`、`view`、`renderView`、`selection`、`tool`、`display`、`canUndo`、`canRedo`。
- 视图与工具：`setTool`、`setSelection`、`setDisplayOptions`、`setView`、`reset`、`replace`。
- 编辑：`dispatch`、`transaction`、`undo`、`redo`、`moveSelectionBy`、`rotateSelection`、`deleteSelection`、`addWire`、`connectWireAt`、`moveReferenceBy`、`setSymbolProperty`、`removeSymbolProperty`、`renameDesignator`、`renameNet`。
- 查询：`inspect`、`topology`、`hitTest`、`subscribe`。

## 开发

```bash
pnpm --filter @mica/schematic-editor run dev        # 打开 demo 预览
pnpm --filter @mica/schematic-editor run test
pnpm --filter @mica/schematic-editor run typecheck
pnpm --filter @mica/schematic-editor run build
```
