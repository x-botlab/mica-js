# @mica-js/schematic-editor

原理图与 2D 视图的 Canvas 编辑器，渲染 `@mica-js/core/schematic` 的文档。

## 入口

- 包根导出主题（`SchematicTheme`、`DARK_SCHEMATIC_THEME`、`LIGHT_SCHEMATIC_THEME`、`resolveSchematicTheme`、`themeToCssVariables`）、视口（`ViewportState`、`ViewportLimits`、`DEFAULT_VIEWPORT_LIMITS`、`resolveViewportLimits`）与控制器/编辑器类型。
- 场景构建、Canvas 渲染器与输入状态机为内部模块。

## 宿主 API

```ts
import { mountSchematicEditor } from '@mica-js/schematic-editor';

const editor = mountSchematicEditor({
  container, // 必填；编辑器只往里 append 自己的 root
  schematic, // 必填；SchematicDocument
  view, // 可选；.view 文档，仅作为渲染覆盖
  devices, // 可选；DeviceSymbolProvider
  theme, // 可选；Partial<SchematicTheme>
  display, // 可选；Partial<DisplayOptions>
  tolerance, // 可选；命中/几何容差（页面单位）
  historyLimit, // 可选；撤销栈上限
  createDesignator, // 可选；(device, document) => string，完全接管新器件位号；默认用器件定义里的 designatorPrefix
  zoomLimits, // 可选；{ minScale, maxScale }，默认 0.25–4
  readOnly, // 可选；禁用内建交互，controller 仍可写
  toolbar, // 可选；默认 true，画布右上角的悬浮工具条
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
| `root` / `canvas`                          | 画布容器与 canvas；编辑器只输出这两个 DOM 节点                         |
| `setSchematic(document, { keepHistory? })` | 换文档；默认清空历史并重新适应内容，`keepHistory` 时作为一次可撤销编辑 |
| `setView(view \| undefined)`               | 换只读视图覆盖                                                         |
| `setTheme(partial)` / `getTheme()`         | 增量换主题 / 读回当前主题                                              |
| `setDisplayOptions(patch)`                 | 网格、吸附、引脚标签、网格尺寸与网格细分                               |
| `setTool(tool)`                            | `select` / `wire` / `power` / `ground` / `label` / `text`              |
| `placeDevice(device)`                      | 抓取一个器件：下一次点击画布插入它，位号自动分配（见下）               |
| `cancelPlacement()`                        | 取消抓取，文档不变                                                     |
| `fitToContent()` / `zoomTo(scale)`         | 视图缩放，`zoomTo` 会夹到 `zoomLimits`                                 |
| `getViewport()` / `setViewport(state)`     | 读回/恢复缩放与平移；恢复时按画布中心夹取比例                          |
| `toPage(clientPoint)` / `toScreen(point)`  | 客户端坐标 ↔ 页面坐标，宿主定位浮层时用                                |
| `toJSON()`                                 | 序列化为 `.sch` JSON                                                   |
| `focus()`                                  | 把键盘焦点交还画布（宿主点完自己的按钮后调用）                         |
| `resize()` / `invalidate()`                | 容器显隐后重新测量 / 只重绘不改布局                                    |
| `undo()` / `redo()`                        | 历史                                                                   |
| `dispose()`                                | 解绑监听、断开 `ResizeObserver`、移除 root                             |

回调时序：控制器发状态 → 工具条与光标更新 → `onSelectionChange` / `onToolChange` / `onError`（仅在变化时）→ `onChange(state)` → 重绘 → `onViewportChange`（仅在视口变化时）。

编辑错误：所有被拒绝的编辑都会写入 `state.lastError` 并触发 `onError`，内建交互不会中断页面；直接调用 `controller.*` 时错误仍会抛出，宿主 `try/catch` 即可（`onError` 会先触发）。

## 宿主 UI 合同

编辑器只内建**画布**与**右下角悬浮工具条**；属性面板、器件库、文件操作、错误提示都由宿主实现，以便与宿主的外观保持一致。

| 宿主 UI        | 读                                  | 写                                                                                         |
| -------------- | ----------------------------------- | ------------------------------------------------------------------------------------------ |
| 工具条（可选） | `state.tool`、`state.placingDevice` | `setTool()` / `placeDevice()` / `cancelPlacement()`（`toolbar: false` 时自建）             |
| 撤销 / 重做    | `state.canUndo` / `state.canRedo`   | `undo()` / `redo()`                                                                        |
| 缩放 / 适应    | `onViewportChange`、`getViewport()` | `zoomTo()` / `fitToContent()` / `setViewport()`                                            |
| 网格与吸附     | `state.display`                     | `setDisplayOptions()`                                                                      |
| 属性面板       | `state.inspector`                   | `controller.setSymbolProperty` / `removeSymbolProperty` / `renameDesignator` / `renameNet` |
| 错误提示       | `state.lastError`、`onError`        | —                                                                                          |

`state.inspector` 的渲染约定（参考实现见 [apps/playground](../../apps/playground/src/components/property-panel.tsx)）：

- `kind === 'wire'`：只读信息（`id`、`netName`、`points`）。
- 其它情况是 `SymbolInspector`：`role` 决定标题，`designator`（仅器件）与 `net`（网标/电源/地）可编辑，`x`/`y`/`rotation` 只读。
- `properties` 是 `PropertyField[]`：字段直接对应器件声明（#7）——`type` 为 `string` / `integer` / `number` / `boolean` / `color` / `enum` / `image` / `binary`，并带上 `title`、`description`、`options`、`min` / `max` / `exclusiveMin` / `step` / `unit`、`maxLength`、`alpha`、`maxBytes` / `maxPixels` 等约束；`value` 缺省表示继承 `defaultValue`，`value === null` 表示显式 null（仅 `nullable` 属性）。清空输入 → `removeSymbolProperty`，写值 → `setSymbolProperty`（越界或类型不符会被拒绝并写入 `state.lastError`）。
- `image` / `binary` 的值是资源引用 `{ "src", "mode" }`：`file` 是工程根相对 POSIX 路径，`inline` 是 base64，`store` 是宿主资源标识；编辑器只传递引用，读取与预览由宿主负责。
- 属性面板只在单选时有内容；多选、空选、选中交点时为 `undefined`（交点没有可编辑字段）。

### 网格与吸附

`DisplayOptions` 里两个数各管一件事：

| 选项               | 默认 | 作用                                       |
| ------------------ | ---- | ------------------------------------------ |
| `gridSize`         | `10` | 吸附步长（页面单位），也决定每格的大小     |
| `gridSubdivisions` | `2`  | 每格画几条可见网格线，`1` 表示只画吸附网格 |

```ts
editor.setDisplayOptions({ gridSubdivisions: 4 }); // 更密的视觉网格，吸附仍按 gridSize
```

强调线每 5 格一条（`gridSize * 5`）。缩得太小时渲染器会自动丢细分、再拉大强调间距，避免糊成一片灰。

### 器件放置

编辑器不内建器件库，器件列表由宿主提供，编辑器只负责「抓取」：

```ts
deviceList.addEventListener('click', (event) => {
  editor.placeDevice('mylib:stm32f103'); // 下一次左键点击就会放下它
});
```

- 抓取后画布光标变为十字，幽灵随指针移动（只吸附网格；`builtin:label` / `power` / `ground` 仍吸附引脚并自动引出一段导线）。
- 空格旋转幽灵，`Esc` 或再次点击列表项调 `cancelPlacement()` 取消。
- 放下后自动切回 `select`，一次抓取只放一个器件；需要连续放置时由宿主在 `onChange` 里重新调用 `placeDevice`。
- 位号来自**器件定义**：`createDeviceRegistry` 里的 `designatorPrefix`（如 `U` / `R` / `DS`），取该前缀下最小的未占用编号；器件没声明时回退到 `U`。宿主也可以用 `createDesignator(device, document)` 完全接管命名规则。
- 非法的器件引用（缺少 `pkg:id` 形式）会直接抛 `SchematicError`，且不会进入抓取态。

### 指针与键盘

- 单击引脚（整条引脚线，不只是端点）直接以引脚端为起点开始画导线；`Esc` 取消。
- 画导线时指针靠近已有导线会吸附到线上（优先引脚、锚点与导线端点），落点垂直于该导线，因此可以直接点出 T 型连接；落点落在导线内部时编辑器会拆开宿主导线并生成交点，落在已有交点上则把新导线加入该交点。
- 单击器件、网标、电源/地或文本的实体选中它（不会误开始画导线）；从网标、电源/地拖拽时，与它们的锚点相连的导线端点会同步跟随，交点在仍位于线上时保持在原处。
- 拖动导线段沿其法线移动（吸附网格）；与之平行的整段连续线段一起移动，端点连着引脚、锚点、交点或别的导线时保持不动，导线自动折出 dogleg，一次拖动只有一步历史；拖动后不再经过的交点会从该导线解绑（少于两条导线时移除）。
- 拖动器件时按落点吸附网格（`snap` 关闭时自由拖动），拖动位号、框选空白、双击或 `Enter` 结束导线、`Delete` 删除、空格或 `R` 旋转、`F` 适应内容、`Ctrl/Cmd+Z` 撤销、`Ctrl/Cmd+Shift+Z` 重做、滚轮缩放、中键或空格拖拽平移。
- `Esc` 同时作用于放置模式与正在绘制的导线；宿主在自己的 UI 里抓取器件时（焦点不在编辑器内），编辑器会在 document 上兜底监听 `Esc`。

## 控制器

`SchematicEditorController` 不依赖 DOM，可单独用于批量编辑或 Node 环境：

- 读状态：`state`、`document`、`view`、`renderView`、`selection`、`tool`、`display`、`canUndo`、`canRedo`。
- 视图与工具：`setTool`、`placeDevice`、`cancelPlacement`、`nextDesignator`、`setSelection`、`setDisplayOptions`、`setView`、`reset`、`replace`。
- 编辑：`dispatch`、`transaction`、`undo`、`redo`、`moveSelectionBy`、`rotateSelection`、`deleteSelection`、`addWire`、`connectWireAt`、`moveWireSegment`、`previewWireSegment`、`moveReferenceBy`、`setSymbolProperty`、`removeSymbolProperty`、`renameDesignator`、`renameNet`。
- 查询：`inspect`、`topology`、`hitTest`、`subscribe`。

## 开发

```bash
pnpm --filter @mica-js/playground dev                  # 浏览器 playground（示例与用法）
pnpm --filter @mica-js/schematic-editor run test
pnpm --filter @mica-js/schematic-editor run typecheck
pnpm --filter @mica-js/schematic-editor run build
```

可运行的示例、宿主侧器件列表与事件回调演示见 [apps/playground](../../apps/playground)。
