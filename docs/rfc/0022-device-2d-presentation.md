# 器件二维展示

- Start Date: 2026-11-15
- Reference Issues: —（尚未关联 issue）
- Implementation PR: —（二维展示与实例音频已在本地实现；尚未关联 PR）

规定统一器件的静态二维几何、底图资源、可选 Canvas2D 动态展示入口、局部输入和实例音频。模型接口由 [RFC 0021](./0021-device-model-api.md) 提供。实例音频复用 [RFC 0016](./0016-widget-audio-api.md)，将其订阅适配为生命周期事件；该扩展随融合运行时在本地实现。MUST / MUST NOT 为强制要求，SHOULD 为推荐，MAY 为可选。

## 声明

### 二维展示声明与静态几何

```ts
interface Point2D {
  readonly x: number;
  readonly y: number;
}
interface Rect2D extends Point2D {
  readonly width: number;
  readonly height: number;
}
interface PinGeometry2D {
  readonly position: Point2D;
  readonly outward: Point2D;
  readonly label?: { readonly position: Point2D; readonly visible?: boolean };
}
interface Geometry2D {
  readonly sizing: 'physical' | 'flexible';
  readonly bounds: Rect2D;
  readonly bodyBounds: Rect2D;
  readonly bodyImage?: string;
  readonly pins: Readonly<Record<string, PinGeometry2D>>;
  readonly designator?: Point2D;
}
interface View2DDefinition {
  readonly geometry: Geometry2D | string;
  readonly entry?: string;
}
```

- 根字段 `view2d` 使用 `View2DDefinition`，`geometry` 必填，可内联几何或引用包根相对 JSON；`entry` 为可选的包根相对 `.js` 路径，声明的文件均须列入发布清单。
- 局部坐标 `x` 向右、`y` 向下；物理器件以 mm 表达长度。
- `bounds` 是绘图范围，`bodyBounds` 是本体范围；绘图内容 MUST 落在 `bounds` 内，本体范围用于布局检查。
- `bodyImage` 为包根相对的 PNG 或自包含静态 SVG 路径，MUST 列入发布文件清单；缺省表示无底图图片。
- 宿主将整张底图连同透明留白映射到 `bounds`，局部位置与尺寸由几何决定，图片像素尺寸不改变物理尺寸。
- 所有坐标有限，宽、高为正；`outward` 为非零向量，宿主归一化后用于引脚辅助线与标签朝向。
- `pins` 与器件引脚 ID 集合完全一致；空引脚器件使用空映射。
- 引脚标签缺省按宿主缩放策略自动放置；显式 `label.position` 覆盖位置，`label.visible` 缺省 `true`。
- 物理器件的局部原点由作者确定，摆放位置映射该原点；自由尺寸对象将 `bounds` 左上角映射到摆放原点，旋转均绕摆放原点顺时针进行。
- `physical` 的尺寸由封装定义，编辑器只改变位置与旋转；相机缩放保持物理尺寸和连接身份。
- `flexible` 以 `bounds` 为原始逻辑区域，实例尺寸定义其在场景中的布局区域；宿主用同一变换映射绘制、锚点和输入。
- `designator` 缺省为本体左上角；位号文字与可见性由宿主管理。
- 壳体、焊盘及丝印由底图图片提供，引脚连接锚点、标签和位号由宿主使用同一份几何绘制。

### 展示入口

下列 `Methods`、`ModelClient`、`Disposable` 和 `Event` 见 [RFC 0021](./0021-device-model-api.md)。

```ts
interface ViewAssets {
  read(path: string): Promise<Uint8Array>;
  loadImage(path: string): Promise<ImageBitmap>;
}
interface ViewAudioStream extends Omit<WidgetAudioStream, 'onDrain' | 'onStatus'> {
  readonly onDidDrain: Event<void>;
  readonly onDidChangeStatus: Event<WidgetAudioStreamStatus>;
}
interface ViewAudio extends Omit<WidgetAudioApi, 'onStateChange' | 'createStream'> {
  readonly onDidChangeState: Event<WidgetAudioState>;
  createStream(options: WidgetAudioStreamOptions): ViewAudioStream;
}
interface ViewInput {
  readonly type: 'pointerdown' | 'pointerup' | 'pointermove';
  readonly position: Point2D;
  readonly button: number;
  readonly buttons: number;
}
interface View2DContext<P, M extends Methods, E extends Readonly<Record<string, Value>>> {
  readonly mode: 'edit' | 'run';
  readonly props: Readonly<P>;
  readonly geometry: Geometry2D;
  readonly model: ModelClient<M, E> | undefined;
  readonly assets: ViewAssets;
  readonly audio: ViewAudio;
  invalidate(): void;
}
interface View2D {
  initialize?(): void | Promise<void>;
  renderOverlay?(context: OffscreenCanvasRenderingContext2D): void;
  input?(event: ViewInput): void | Promise<void>;
  dispose?(): void;
}
type View2DFactory<P, M extends Methods, E extends Readonly<Record<string, Value>>> = (
  context: View2DContext<P, M, E>,
) => View2D;
```

- `view2d.entry` 可选；仅需固定外观的器件由宿主按几何和底图显示，编辑选择、摆放与接线由宿主处理。
- 声明 `view2d.entry` 时，其默认导出同步 `View2DFactory`；工厂注册监听、建立局部数据并发起资源准备。
- 模型存在时，运行上下文提供绑定到所属实例的代理；编辑态及无模型器件的 `model` 为 `undefined`。
- `ViewAudio` 引用的 `WidgetAudio*` 类型见 [RFC 0016](./0016-widget-audio-api.md)；事件订阅返回 `Disposable`。
- `initialize` 在模型就绪后执行；编辑态同样可执行此回调准备纯展示资源。
- `input` 接收指针按下、松开和移动；`position` 为局部坐标，`button` 与 `buttons` 沿用 DOM 的按钮编号和当前按下按钮位掩码。
- `renderOverlay` 绘制发光点、按帽及屏幕内容等运行可见部分，并叠加在底图之上。
- 底图与动态覆盖使用相同的局部原点、几何和变换，动态部件可包含运行中仍应保留的静态轮廓。
- 绘制回调同步执行，仅读取最后可用展示数据；模型计算与动作 MUST NOT 由绘制调用驱动。
- 宿主负责底图图片的加载、缓存与释放；`dispose` 释放作者自行加载的位图、订阅等展示资源。

### 分层与显示

| 层                             | 责任方                 | 编辑态         | 运行态                         |
| ------------------------------ | ---------------------- | -------------- | ------------------------------ |
| 底图                           | 器件提供图片，宿主绘制 | 声明图片时显示 | 文档全局开关与实例覆盖共同决定 |
| 动态覆盖                       | 器件                   | 默认初始表现   | 反映模型与局部交互数据         |
| 接线、引脚、网标与电源符号辅助 | 宿主                   | 显示           | 隐藏                           |
| 位号                           | 宿主                   | 显示           | 文档开关决定                   |
| 选择、吸附与命中辅助           | 宿主                   | 按编辑状态显示 | 按运行工具状态显示             |

- 隐藏底图只改变合成结果，不停止模型、事件处理或动态覆盖。
- 隐藏底图后，仍有可见动态覆盖的器件继续以 `bounds` 接收业务输入。
- 完全隐藏的器件不保留空白命中框，仍可通过对象列表选择并打开 HTML 视图。

## 运行时

### 实例音频

- 运行态 `audio` 属于实例及其当前挂载代次，宿主配置决定可用性；编辑态为 `unavailable`。
- 宿主持有并激活浏览器音频上下文；等待用户手势或浏览器挂起时为 `suspended`，运行时为 `running`，缺省配置或初始化失败时为 `unavailable`。
- 隐藏底图、动态覆盖或关闭 HTML 视图保持音频会话；仿真暂停冻结声音和 PCM 消费并保留缓冲，恢复后继续。
- 重置、替换展示或销毁实例清空旧会话，旧句柄以 `disposed` 结束；音频播放及背压不控制仿真步进。
- 音频桥接失败以 `audio/failed` 报告，同一桥接操作首次失败上报；销毁后到达的失败作为过期结果清理。

### 绘制与尺寸

- 宿主校验底图资源后解码并绘制；路径、文件摘要或图片解码失败时明确报告展示准备失败。
- 宿主在每次动态绘制前清空覆盖层，设置局部坐标到位图的变换并隔离绘制上下文。
- `invalidate()` 标记动态覆盖需要重绘；同一帧重复失效合并，底图由宿主独立缓存。
- 编辑属性、布局尺寸或有效显示精度变化时，宿主重建相应展示或使相关层失效。
- 宿主根据相机缩放与像素密度选择绘图精度；资源额度不足时降低绘图精度并报告，不改变几何或电气连接。
- `loadImage` 返回调用方持有的位图，使用结束调用 `close()`；过期异步结果必须释放。
- 局部资源的访问范围为锁定包根；属性文件在工厂前准备，解释见 [RFC 0020](./0020-unified-device-package.md)。

### 命中与交互

- 编辑态输入用于选择、摆放与接线；运行态命中器件时可同时更新宿主当前器件并交付交互，选择本身不调用模型。
- 提供 `input` 的可见展示统一以 `bounds` 进行矩形命中；范围内的留白、光晕等区域同样接收业务指针事件。
- 未提供 `input` 的展示作为纯展示，宿主仍处理编辑态的选择、摆放与接线。
- 输入坐标由宿主应用逆变换，得到器件局部位置；输入阈值和捕获在屏幕空间判断。
- 同一展示的事件与输入按交付顺序调用；异步业务由展示自行安排，模型方法响应与宿主控制独立处理。
- 宿主向展示交付指针按下时捕获当前指针，将后续移动和松开交付给该展示；捕获期间坐标可超出 `bounds`。
- 同一展示最多接受一条按下指针序列，该序列结束前不向它交付其他指针的业务事件；不同展示可以各自捕获指针。
- 捕获期间发生 `pointercancel`、意外 `lostpointercapture` 或窗口失焦时，宿主归一为一次 `pointerup`：位置使用最近局部坐标，`button` 使用该序列按下时的值，`buttons` 为 `0`，随后结束捕获。
- 正常松开或取消已经结束的序列，其后续丢失捕获通知不重复交付 `pointerup`；取消后的业务处理仍由展示使用既有输入回调决定。
- 展示开始关闭、移除或故障处理时先停止业务输入，再释放捕获；此后的原生取消事件被丢弃，清理不补发业务输入或直接修改模型动作。
- 展示自行根据局部坐标判断有效业务区域，将按下、松开和移动转换为本实例的普通模型方法调用；局部界面变量仅作为视觉预览，权威结果来自模型。
- 引脚拾取按屏幕距离处理；多个引脚候选重叠时提供放大或候选选择，MUST NOT 按扩大命中框的先后顺序猜测引脚。
- 引脚名称按显示精度呈现，悬停或选择可突出完整网络；字体和线宽变化保持锚点坐标不变。
- 导线显示宽度与命中宽度分别处理，吸附使用原始锚点，不将细脚距量化到粗网格。
- 本体重叠作为可观察的布局诊断；标注与业务命中范围不扩大器件的物理本体范围。

## 校验

| 诊断码                      | 条件                                            |
| --------------------------- | ----------------------------------------------- |
| `view2d/invalid-geometry`   | 几何、范围或方向非法                            |
| `view2d/pin-mismatch`       | 展示引脚与器件声明不一致                        |
| `view2d/unsupported`        | 器件缺少二维几何，禁止加入 2D 场景              |
| `view2d/render-failed`      | 底图解码或绘制失败，动态绘制异常或返回 thenable |
| `view2d/input-failed`       | 输入回调异常                                    |
| `view2d/resolution-limited` | 显示精度因资源额度降低                          |
| `layout/body-overlap`       | 本体区域重叠，提示定位范围                      |

## 示例

完整 `view2d` 声明见 [器件清单示例](./examples/0020-device-package.json)，同时包含几何路径与可选脚本入口。下列为 `views/2d/geometry.json` 的全字段内容；6 mm 轻触开关底图包含壳体、焊盘及丝印，按帽由动态覆盖绘制，四个端子分别保留身份，固定导通支路由模型表达。

```json
{
  "sizing": "physical",
  "bounds": { "x": -1, "y": -1, "width": 8, "height": 8 },
  "bodyBounds": { "x": 0, "y": 0, "width": 6, "height": 6 },
  "bodyImage": "assets/body.svg",
  "pins": {
    "a1": {
      "position": { "x": -0.5, "y": 1 },
      "outward": { "x": -1, "y": 0 },
      "label": { "position": { "x": -0.8, "y": 0.5 }, "visible": true }
    },
    "a2": {
      "position": { "x": -0.5, "y": 5 },
      "outward": { "x": -1, "y": 0 },
      "label": { "position": { "x": -0.8, "y": 5.5 }, "visible": true }
    },
    "b1": {
      "position": { "x": 6.5, "y": 1 },
      "outward": { "x": 1, "y": 0 },
      "label": { "position": { "x": 6.6, "y": 0.5 }, "visible": true }
    },
    "b2": {
      "position": { "x": 6.5, "y": 5 },
      "outward": { "x": 1, "y": 0 },
      "label": { "position": { "x": 6.6, "y": 5.5 }, "visible": true }
    }
  },
  "designator": { "x": 0, "y": -1 }
}
```

## 范围

- 器件模型与调用语义由 [RFC 0021](./0021-device-model-api.md) 规定。
- 属性、入口与包资源由 [RFC 0020](./0020-unified-device-package.md) 规定。
- 摆放、运行显示配置与电气连接由 [RFC 0024](./0024-fused-schematic-format.md) 规定。
- 运行初始化、生命周期和故障由 [RFC 0025](./0025-fused-runtime.md) 规定。
- 振荡器、PCM 缓冲、数据传输与音频参数校验由 [RFC 0016](./0016-widget-audio-api.md) 规定。

## 关联

- [RFC 0023](./0023-device-html-ui.md)：独立于场景绘制的器件 HTML 视图。
