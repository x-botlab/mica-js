# @mica-js/canvas-editor

画布编辑器：把 `@mica-js/core/canvas` 的 `.cnv` 文档与 `WidgetLayers` 的位图合成到一块 Canvas 上，并把用户操作翻译成 `CanvasCommand`。只负责**呈现**与**交互**，属性面板、绑定面板、组件插入面板由宿主实现。

## 边界

编辑器**不持有文档、不修改文档、不启动 sandbox**：

- 文档由宿主传入；命令应用后宿主再把新快照交给 `setDocument()`。
- 编辑模式只产出 `CanvasCommand`（`set-placement` / `remove-instance`），通过 `onCommand` 上抛。
- 运行模式只把命中实例的输入通过 `dispatch` 转发，不产生任何命令。
- widget 的挂载、帧生成与 sandbox 生命周期属于 `@mica-js/widget` 的 `WidgetHost`。
- 视口与选择是编辑器状态，**不写入文档**。

`mountCanvasEditor` 保持这些边界；可选的组合层 `createCanvasScene` 只把已有的 `WidgetHost` 与编辑器接起来，文档和 sandbox 仍归宿主所有。

## 安装

```bash
pnpm add @mica-js/canvas-editor @mica-js/core @mica-js/widget
```

## 快速上手

```ts
import { mountCanvasEditor } from '@mica-js/canvas-editor';
import { applyCanvasCommand } from '@mica-js/core/canvas';

const editor = mountCanvasEditor({
  container: document.querySelector('#host')!, // 编辑器只往里 append 自己的 root
  document: canvasDocument, // CanvasDocument（.cnv）
  layers: host.getLayers(), // WidgetHost 的位图层
  onCommand: (command) => {
    canvasDocument = applyCanvasCommand(canvasDocument, command);
    editor.setDocument(canvasDocument); // 回灌快照：选择、视口与进行中的交互都会保留
  },
  onSelectionChange: (ids) => renderSelection(ids),
  dispatch: (instanceId, event) => host.dispatch(instanceId, event),
});

editor.setMode('run'); // 运行模式：只转发输入，不显示选中框与手柄
// 卸载：editor.destroy()
```

`container` 需要有确定的尺寸：编辑器把 root 撑满容器，并按 `devicePixelRatio` 放大画布。

## 组合层（`createCanvasScene`）

`CanvasScene` 把文档、`WidgetHost`（`@mica-js/widget`）与编辑器串成一个整体：命令向下交给宿主，快照向上回灌，发布按绑定反查。宿主仍然拥有文档与 sandbox，场景只负责连线。

```ts
import { createCanvasScene } from '@mica-js/canvas-editor';
import { parseCanvas } from '@mica-js/core/canvas';
import { createWidgetHost } from '@mica-js/widget';

let scene: CanvasScene | undefined;
const host = createWidgetHost({
  provider,
  assets,
  onDiagnostic: (diagnostic) => console.warn(diagnostic.code, diagnostic.message),
  // `WidgetHostOptions.onPublish` 只接受一个回调；场景把它的监听器集合扇出给 `onPublish`。
  onPublish: (publish) => scene?.receivePublish(publish),
});

scene = await createCanvasScene({
  container,
  document: parseCanvas(cnvText), // 已解析的 CanvasDocument；文本由应用侧解析
  host,
  onChange: (document) => persist(document), // 每次提交后写回磁盘
  onSelectionChange: (ids) => renderInspector(ids), // 宿主属性/绑定面板用
  onDiagnostic: (diagnostic) => console.warn(diagnostic.code, diagnostic.message),
});

scene.setMode('run'); // 切到运行模式：先取消交互，再重置全部 widget（见下）
scene.deliver({ symbol: 'mcu', port: 'value' }, '12.34', simTime); // 仿真侧 → widget（按端点扇出）
const off = scene.onPublish((target, payload, simTime) => route(target, payload, simTime));
scene.destroy(); // 只拆编辑器与自己的订阅；host.dispose() 由宿主决定
```

| 成员                      | 说明                                                                           |
| ------------------------- | ------------------------------------------------------------------------------ |
| `document`                | 宿主当前提交的快照                                                             |
| `mode`                    | 当前模式（调用 `setMode` 后立即更新，不等重置完成）                            |
| `setMode(mode)`           | 切换模式并重置全部 widget；回到相同模式直接 resolve，不重置                    |
| `setSelection(ids)`       | 宿主侧（例如图层列表）设置选择；不存在的 id 被丢弃，变化走 `onSelectionChange` |
| `deliver(target, …)`      | 把载荷投递到**所有**绑定该端点的实例；没有命中时什么也不做                     |
| `onPublish(listener)`     | 收到 `(target, payload, simTime)`；返回取消订阅函数                            |
| `receivePublish(publish)` | 接收宿主 `onPublish` 转发来的 `WidgetPublish`，无绑定时上报诊断                |
| `destroy()`               | `editor.destroy()` + 取消订阅；**不会** `dispose()` 宿主                       |

诊断码以 `canvas-scene/` 开头：`command-failed`（宿主拒绝命令）、`unbound-publish`（发布端口没有绑定）、`change-failed`（`onChange` 抛错）、`publish-failed`（监听器抛错）。命令被拒时编辑器不回灌，继续画旧快照。

`createCanvasScene` 是异步的：它先 `await host.loadDocument(options.document)`，再挂载编辑器；`document` 必须是已解析的 `CanvasDocument`（`.cnv` 文本先用 `parseCanvas` 解析），宿主校验失败时直接抛出且不挂载。

**切换模式会重置 widget 状态。** `scene.setMode(next)` 返回 promise，执行顺序固定为：`editor.cancelInteraction()` → `editor.setMode(next)` → `await host.reset()`。`mode` 属性在调用后**立即**是新值（输入路由马上跟着变），promise 在 `host.reset()` 把全部实例按当前文档重建完成后才 resolve。重置会丢弃实例并重建工厂实例，所以按键不会停在按下、数码管不会停在最后一个值；模块本身不重新求值，因此 widget 的实例状态要放在工厂闭包里。切到当前模式则直接 resolve，不做重置；重置失败时 promise reject，场景回退到原模式。选择与视口保持不变（实例 id 未变）。

运行模式下画布仍可浏览：滚轮缩放、`Shift` + 滚轮横向平移、中键或空格 + 左键拖动平移，这些操作不产生命令、也不转发给 widget（详见下方「运行模式」）。

## 挂载选项

| 选项                | 说明                                                              |
| ------------------- | ----------------------------------------------------------------- |
| `container`         | 必填；宿主提供的容器元素，编辑器会在其上设置 `touch-action: none` |
| `document`          | 必填；当前 `.cnv` 快照                                            |
| `layers`            | 必填；`WidgetLayers`，按 `list()` 顺序取位图                      |
| `mode`              | `'edit'`（默认）或 `'run'`                                        |
| `onCommand`         | 编辑产生的命令；编辑器不直接改文档                                |
| `onSelectionChange` | 选择变化（含宿主 `setSelection()` 触发的变化）                    |
| `dispatch`          | 运行模式下命中实例的输入，坐标是实例局部逻辑单位                  |
| `onDiagnostic`      | `CanvasEditorDiagnostic`：上下文缺失、位图绘制失败、宿主回调抛错  |
| `theme`             | `Partial<CanvasTheme>`，默认深色（`gridSize <= 0` 表示不画网格）  |

## 返回值

| 成员                  | 说明                                                        |
| --------------------- | ----------------------------------------------------------- |
| `setDocument(doc)`    | 回灌命令应用后的新快照；保留选择、视口与进行中的交互        |
| `setMode(mode)`       | 切换编辑/运行模式；切换会丢弃进行中的手势且不产生命令       |
| `setSelection(ids)`   | 设置选择；变化时触发 `onSelectionChange`                    |
| `cancelInteraction()` | 取消进行中的拖动/缩放/旋转/平移，不产生命令，几何回到交互前 |
| `state`               | `{ mode, selection, viewport }`，供宿主持久化或调试         |
| `focus()`             | 把键盘焦点交还画布                                          |
| `destroy()`           | 解绑监听、断开 `ResizeObserver`、移除 root 并还原容器样式   |

## 坐标与合成

- 文档坐标是逻辑单位：100 % 缩放下 1 单位 = 1 CSS 像素；`rotation` 为度、顺时针、绕实例中心。
- 画布按 `devicePixelRatio` 放大，绘制变换为 `setTransform(dpr * scale, 0, 0, dpr * scale, dpr * x, dpr * y)`。
- 合成顺序：网格 → 位图（`layers.list()` 顺序；`bitmap === undefined` 的实例画占位框）→ 编辑模式的实例边框 → 选中框 → 手柄。
- 编辑模式给**每个实例**画一圈半透明边框（主题 `theme.outline`，1.5 px，下面垫一层深色描边保证在亮色照片上也看得清）：透明组件本身画不出东西，没有这圈边框就找不到它的位置。运行模式不画，交互动效与选中框一样只在编辑时出现。
- 位图按实例几何绘制：`translate(x + width/2, y + height/2)` → `rotate` → `drawImage(bitmap, -width/2, -height/2, width, height)`。
- 重绘由 `#dirty` 标志 + 单次 `requestAnimationFrame` 合并；触发点只有位图层变化、文档/模式/选择变化、交互步骤与容器尺寸变化，**空闲时不调度帧**。

## 交互键位

### 编辑模式

| 操作                      | 行为                                                                      |
| ------------------------- | ------------------------------------------------------------------------- |
| 单击实例                  | 选中（从最上层开始命中测试，含旋转）                                      |
| `Shift` / `Ctrl` + 单击   | 加入或移出选择                                                            |
| 单击空白                  | 清空选择                                                                  |
| 拖动选中实例              | 移动；松手时每个实例发一条 `set-placement`                                |
| 拖动 8 个手柄             | 缩放；`Shift` 保持宽高比                                                  |
| 拖动旋转手柄              | 旋转；`Shift` 吸附 15°                                                    |
| 方向键 / `Shift` + 方向键 | 移动 1 / 10 单位                                                          |
| `Delete` / `Backspace`    | 每个选中实例一条 `remove-instance`，并清空选择                            |
| 滚轮                      | 以指针为锚点缩放（`0.1`–`8`；`deltaMode` 行/页按 16 px/行与视口高度换算） |
| `Shift` + 滚轮            | 横向平移                                                                  |
| 空格 + 拖动 / 中键拖动    | 平移视口                                                                  |
| `Cmd/Ctrl + A`            | 全选                                                                      |

按下到移动不超过 3 CSS 像素时仍是点击，不会产生位移；拖动过程中的中间几何只存在于预览层，命令只发最终结果。松手坐标即使没有伴随最后一个 `pointermove`（快速甩动），也按松手点提交。

手柄只在**单选**时显示；多选只画选中框。命中测试用文档几何（把指针逆变换到实例局部坐标），不读像素。

同时按下第二个指针会**放弃**当前手势（不产生命令、几何回到交互前），并忽略该指针直到第一个指针抬起。

### 运行模式

- 不产生任何命令，选中框与手柄不显示。
- `pointerdown` / `pointermove` / `pointerup` / `pointercancel` 命中实例后转发实例局部坐标（已扣除位置与旋转，`(0, 0)` 是实例左上角）。
- 按下期间，按下的实例独占移动与抬起事件；抬起后路由立即解除，之后的移动重新命中测试，空白处不转发。
- 键盘事件转发给最近一次命中的实例；只有画布持有焦点时才会收到键事件。
- 浏览画布与编辑模式一致：滚轮以指针为锚缩放、`Shift` + 滚轮横向平移；中键拖动或空格 + 左键拖动平移。这些视口操作**不产生命令，也不转发给 widget**（`WidgetInputEvent` 不含滚轮），中键/空格拖动也不会把按下路由给实例。
- 通过 `CanvasScene` 切换模式会重置 widget（编辑器自身的 `setMode` 只切策略，不碰 widget）。

## 内部结构

| 文件                     | 职责                                                                  |
| ------------------------ | --------------------------------------------------------------------- |
| `src/geometry.ts`        | 命中测试（含旋转）、包围盒、手柄位置、缩放与旋转计算（无 DOM）        |
| `src/viewport.ts`        | `screenToDocument` / `documentToScreen` / 平移 / 缩放与限幅（无 DOM） |
| `src/session.ts`         | 交互状态机：`idle → pressed → dragging/scaling/rotating/panning`      |
| `src/render/grid.ts`     | 网格步长与主/次网格线判定（无 DOM）                                   |
| `src/render/renderer.ts` | 网格、位图、选中框与手柄的 Canvas 绘制                                |
| `src/editor/mount.ts`    | DOM 绑定、rAF 调度、把事件喂给状态机、把命令交给 `onCommand`          |
| `src/scene.ts`           | `createCanvasScene`：文档 ↔ 宿主 ↔ 编辑器与端口投递/发布反查          |
| `src/styles.ts`          | 注入的 `<style>`（画布容器与画布元素）                                |

纯逻辑模块不依赖 DOM，单测跑在 node 环境：

```bash
pnpm --filter @mica-js/canvas-editor run test
pnpm --filter @mica-js/canvas-editor run typecheck
pnpm --filter @mica-js/canvas-editor run build
```

## 相关提案

- 画布格式：[#67](https://github.com/x-botlab/mica-js/issues/67)
- Widget 契约：[#7](https://github.com/x-botlab/mica-js/issues/7)
- Widget 运行时：[#98](https://github.com/x-botlab/mica-js/issues/98)
- 画布编辑器：[#100](https://github.com/x-botlab/mica-js/issues/100)
- 场景组装与 playground demo：[#101](https://github.com/x-botlab/mica-js/issues/101)
