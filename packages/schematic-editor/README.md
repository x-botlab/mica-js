# @mica-js/schematic-editor

原理图编辑器：把 `@mica-js/core/schematic` 的 `.sch` 文档渲染成可编辑的 Canvas 画布。只负责画布本身，属性面板、器件库、文件操作等 UI 由宿主实现。

## 安装

```bash
pnpm add @mica-js/schematic-editor @mica-js/core
```

## 快速上手

```ts
import { mountSchematicEditor } from '@mica-js/schematic-editor';

const editor = mountSchematicEditor({
  container: document.querySelector('#host')!, // 编辑器只往里 append 自己的 root
  schematic, // SchematicDocument（.sch）
  devices, // 可选：DeviceSymbolProvider，画布按它合成器件外形
  onChange: (state) => renderStatus(state),
});

editor.placeDevice('stm32-package:stm32g431rbt6-lqfp64'); // 抓到光标上，下一次点击落地
editor.fitToContent();
// 卸载：editor.dispose()
```

## 挂载选项

| 选项               | 说明                                                                               |
| ------------------ | ---------------------------------------------------------------------------------- |
| `container`        | 必填；宿主提供的容器元素                                                           |
| `schematic`        | 必填；`SchematicDocument`                                                          |
| `devices`          | `DeviceSymbolProvider`，缺失时画布无法合成器件外形                                 |
| `theme`            | `Partial<SchematicTheme>`，默认深色                                                |
| `display`          | `Partial<DisplayOptions>`：网格、吸附、引脚标签、网格尺寸与细分                    |
| `tolerance`        | 命中/几何容差（页面单位）                                                          |
| `historyLimit`     | 撤销栈上限                                                                         |
| `createDesignator` | `(device, document) => string`，接管新器件位号；默认为器件的前缀策略               |
| `zoomLimits`       | `{ minScale, maxScale }`，默认 `0.25`–`4`                                          |
| `readOnly`         | 禁用内建交互，`controller` 仍可写                                                  |
| `toolbar`          | 是否渲染画布右上角的悬浮工具条，默认 `true`                                        |
| 回调               | `onChange` / `onSelectionChange` / `onToolChange` / `onError` / `onViewportChange` |

回调时序：控制器发状态 → 工具条与光标更新 → `onSelectionChange` / `onToolChange` / `onError`（仅变化时）→ `onChange(state)` → 重绘 → `onViewportChange`（仅视口变化时）。

编辑错误：被拒绝的编辑写入 `state.lastError` 并触发 `onError`，内建交互不会中断页面；直接调用 `controller.*` 时错误仍会抛出（`onError` 先触发）。

## 返回值

| 成员                                        | 说明                                                                   |
| ------------------------------------------- | ---------------------------------------------------------------------- |
| `controller`                                | 无 DOM 的 `SchematicEditorController`                                  |
| `root` / `canvas`                           | 编辑器创建的两个 DOM 节点                                              |
| `setSchematic(document, { keepHistory? })`  | 换文档；默认清空历史并重新适应内容，`keepHistory` 时作为一次可撤销编辑 |
| `setTheme(partial)` / `getTheme()`          | 增量换主题 / 读回当前主题                                              |
| `setDisplayOptions(patch)`                  | 网格、吸附、引脚标签、网格尺寸与细分                                   |
| `setTool(tool)`                             | `select` / `wire` / `power` / `ground` / `label` / `text`              |
| `placeDevice(device)` / `cancelPlacement()` | 抓取一个器件 / 取消抓取                                                |
| `fitToContent()` / `zoomTo(scale)`          | 适应内容 / 按比例缩放（夹到 `zoomLimits`）                             |
| `getViewport()` / `setViewport(state)`      | 读回/恢复缩放与平移                                                    |
| `toPage(point)` / `toScreen(point)`         | 客户端坐标 ↔ 页面坐标，宿主定位浮层时用                                |
| `toJSON()`                                  | 序列化为 `.sch` JSON                                                   |
| `focus()`                                   | 把键盘焦点交还画布                                                     |
| `resize()` / `invalidate()`                 | 容器显隐后重新测量 / 只重绘不改布局                                    |
| `undo()` / `redo()` / `dispose()`           | 历史 / 解绑监听并移除 root                                             |

## 宿主 UI 合同

编辑器只内建**画布**与**悬浮工具条**；其余 UI 由宿主读状态、写方法：

| 宿主 UI     | 读                                  | 写                                                                                         |
| ----------- | ----------------------------------- | ------------------------------------------------------------------------------------------ |
| 工具条      | `state.tool`、`state.placingDevice` | `setTool()` / `placeDevice()` / `cancelPlacement()`（`toolbar: false` 时自建）             |
| 撤销 / 重做 | `state.canUndo` / `state.canRedo`   | `undo()` / `redo()`                                                                        |
| 缩放 / 适应 | `onViewportChange`、`getViewport()` | `zoomTo()` / `fitToContent()` / `setViewport()`                                            |
| 网格与吸附  | `state.display`                     | `setDisplayOptions()`                                                                      |
| 属性面板    | `state.inspector`                   | `controller.setSymbolProperty` / `removeSymbolProperty` / `renameDesignator` / `renameNet` |
| 错误提示    | `state.lastError`、`onError`        | —                                                                                          |

`state.inspector` 的渲染约定（参考实现见 [apps/playground](../../apps/playground/src/components/property-panel.tsx)）：

- `kind === 'wire'`：只读信息（`id`、`netName`、`points`）；选中交点、多选或空选时为 `undefined`。
- `SymbolInspector`：`role` 决定标题，`designator`（器件）与 `net`（网标/电源/地）可编辑，`x` / `y` / `rotation` 只读。
- `properties` 是 `PropertyField[]`，直接对应器件声明（#7）：`type` 为 `string` / `integer` / `number` / `boolean` / `color` / `enum` / `image` / `binary`，并带 `title`、`description`、`options`、`min` / `max` / `exclusiveMin` / `step` / `unit`、`maxLength`、`alpha`、`maxBytes` / `maxPixels` 等约束。`value` 缺省表示继承 `defaultValue`，`null` 表示显式空值（仅 `nullable` 属性）。
- `image` / `binary` 的值是资源引用 `{ src, mode }`；编辑器只传递引用，读取与预览由宿主负责。

### 网格与吸附

| 选项               | 默认 | 作用                                   |
| ------------------ | ---- | -------------------------------------- |
| `gridSize`         | `10` | 吸附步长（页面单位），也决定每格大小   |
| `gridSubdivisions` | `2`  | 每格画几条可见网格线，`1` 只画吸附网格 |

强调线每 5 格一条；缩得太小时渲染器会自动丢掉细分，避免糊成一片。

### 器件放置

编辑器不内建器件库：

- 抓取后光标变为十字，幽灵随指针移动（只吸附网格；`builtin:label` / `power` / `ground` 仍吸附引脚并引出一段导线）。
- 空格旋转幽灵，`Esc` 或 `cancelPlacement()` 取消；放下后自动切回 `select`，一次抓取只放一个。
- 位号来自器件定义的 `designatorPrefix`（取该前缀下最小的未占用编号，未声明时回退 `U`），也可用 `createDesignator` 完全接管。
- 非法器件引用直接抛 `SchematicError`，不进入抓取态。

### 指针与键盘

- 单击引脚（整条引脚线）以引脚端起笔；画导线时吸附到附近导线并垂直落下，可直接点出 T 型连接（落在导线内部会拆线建交点）。
- 单击器件、网标、电源/地、文本会选中实体，不会误起笔；拖动网标、电源/地时，相连导线按「沿导线方向只改长度、有垂直位移则折一段」跟随。
- 拖动导线段沿法线移动并吸附网格，平行连续段一起移动，端点连着引脚/锚点/交点/导线时保持不动并折出 dogleg；一次拖动一步历史。
- 拖动器件按落点吸附网格，单轴拖动时另一轴不动；位号可拖动。
- `Delete` 删除、空格或 `R` 旋转、`F` 适应内容、`Enter`/双击结束导线、`Esc` 取消、`Ctrl/Cmd+Z` 撤销、`Ctrl/Cmd+Shift+Z` 重做、滚轮缩放、中键或空格拖拽平移。
- 宿主在自己的 UI 里抓取器件时（焦点不在编辑器内），编辑器会在 document 上兜底监听 `Esc`。

## 控制器

`SchematicEditorController` 不依赖 DOM，可单独用于批量编辑或 Node 环境：

- 读状态：`state`、`document`、`selection`、`tool`、`display`、`canUndo`、`canRedo`。
- 工具：`setTool`、`placeDevice`、`cancelPlacement`、`nextDesignator`、`setSelection`、`setDisplayOptions`、`reset`、`replace`。
- 编辑：`dispatch`、`transaction`、`undo`、`redo`、`moveSelectionBy`、`rotateSelection`、`deleteSelection`、`addWire`、`connectWireAt`、`moveWireSegment`、`previewWireSegment`、`moveReferenceBy`、`setSymbolProperty`、`removeSymbolProperty`、`renameDesignator`、`renameNet`。
- 查询：`inspect`、`topology`、`hitTest`、`subscribe`。

## 内部结构

| 目录                   | 职责                                                                         |
| ---------------------- | ---------------------------------------------------------------------------- |
| `controller/`          | 会话状态与命令桥接：选择、工具、历史、inspector                              |
| `editor/interactions/` | 指针与键盘状态机：`input.ts` 分发，`move` / `segment` / `wire` / `placement` |
| `editor/snapping/`     | 吸附与放置辅助（节点、导线本体、网格、label stub），无 DOM 的纯函数          |
| `render/`              | 场景构建（`scene.ts`）与 canvas 绘制（`canvas-renderer.ts`）                 |
| `styles/`              | 编辑器自带的极少量 CSS（工具条与画布容器）                                   |

## 开发

```bash
pnpm --filter @mica-js/playground dev                    # 浏览器 playground
pnpm --filter @mica-js/schematic-editor run test
pnpm --filter @mica-js/schematic-editor run typecheck
pnpm --filter @mica-js/schematic-editor run build
```

可运行示例、宿主侧器件列表与事件回调演示见 [apps/playground](../../apps/playground)。

## 相关提案

- 原理图格式：[#6](https://github.com/x-botlab/mica-js/issues/6)
- 属性定义：[#7](https://github.com/x-botlab/mica-js/issues/7)
