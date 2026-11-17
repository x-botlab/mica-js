# @mica-js/editor

独立组合根的编辑器。原理图工厂提供 URI 加载、器件解析、Canvas 渲染、编辑、撤销与重做；画布工厂提供 widget 合成、布局编辑和仿真会话。两个工厂分别拥有服务容器和内部实现。

## 融合工作台

`@mica-js/editor/fused` 提供 React 19 工作台，直接编辑融合 `.sch` v2 文档。器件底图、逐引脚接线与动态覆盖共用实例坐标；主线程处理文档和交互，模型与 `view2d.js` 分别运行在现有 `SandboxWorker` 中。进入 Run 自动启动，返回 Edit 释放运行会话；下次运行从初态开始。

```typescript
import { createWorkbench } from '@mica-js/editor/fused';
import '@mica-js/editor/fused/style.css';

const workbench = await createWorkbench({
  container,
  document,
  saveDocument: async (snapshot) => host.save(snapshot),
  assetProvider,
  deviceProvider,
  programs,
  accessProvider,
  viewBaseUrlTemplate: 'https://${id}.views.example.com/v1/',
  theme: {
    appearance: 'dark',
    colors: {
      accent: '#7c3aed',
      'accent.foreground': '#ffffff',
      'canvas.background': '#141821',
    },
  },
});

await workbench.save();
await workbench.dispose();
```

宿主直接传入 `FusedDocument`，自行维护项目身份和存储。`getDocument()` / `onDidChangeContent` 提供当前快照；可选的 `saveDocument(snapshot)` 完成后标记对应版本已保存，缺失时 `save()` 明确拒绝。器件 Provider 返回锁定发布版本的 `PackageFiles`，工作台校验文件清单和摘要。

`assetProvider.select({ kind, formats, signal })` 打开宿主资产库 UI，返回 `{ id, name }` 或以 `undefined` 取消；`name` 包含文件扩展名。`read(id, signal)` 返回二进制，编辑器不枚举资产。普通资源仅支持 `asset` / `package`；`program` 另支持 `project`，使用 `programs.projects.select({ ...target, templateIds }, signal)` 选择项目、`resolve(id, target, signal?)` 取得程序产物。项目选择能力可省略，已有引用仍可解析；程序文件集资产使用 ZIP，校验解包后交给模型只读访问。

属性字段以单行显示来源图标、引用名称和默认标记，通过同行图标打开来源菜单或内存装载设置浮层；新内容读取校验成功后才提交，取消和失败保留原值。项目选择的请求包含 `templateIds`，按属性的 `templates` 顺序传递，未声明时为空数组；宿主负责模板展示与项目创建，编辑器只保存返回的项目引用。内置资源从当前器件包选择，项目可独立打开。宿主接口合同见 [RFC 0028](../../docs/rfc/0028-workbench-host-resources.md)。

`contributions.containers`、`views`、`toolbar` 为宿主扩展点，ID 使用宿主命名空间，`mica.*` 保留。视图的 `mount` 接收 DOM 容器与带取消信号的作用域，返回 Disposable。工具条按钮可以执行 `workbench.openContainer`，例如打开器件库并聚焦搜索；编辑器不要求特定的器件库角色。`when` 与 `enablement` 使用 Context Key 条件，宿主通过 `workbench.contextKeys` 注册自己的 Key；内置模式、编辑权限、撤销状态与选择 Key 由工作台维护。

`accessProvider.evaluateDocument` 分别决定编辑和运行权限，`canAddDevice` 决定能否新增指定发布版本。新增、属性修改、通用事务、粘贴、撤销重做与保存均经过文档会话授权。宿主可将包含付费器件的文档整体设为只读，并通过 `onDidChange` 通知授权变化；持久化服务仍应验证最终写入。只读文档中的面板位置调整仅保留在当前工作台会话。

器件声明的 HTML Views 在 Run 中开放。侧栏属性固定在顶部，HTML Views 支持折叠、排序、调整高度与浮动；浮动面板可拖动四条边与四个角调整尺寸，最小 180×100，键盘方向键每次调整 10px、按住 Shift 调整 40px。浮动面板保留所属实例，停靠切换保留同一 iframe 与同一套订阅；折叠只隐藏页面，不卸载。运行结束释放这些环境。

每个视图环境是两个同源（但与工作台隔离）的 frame，两者都是部署目录里的真实文档：可信外层页 `index.html` 只保留生命周期控制通道（加载、主题中继、失败上报）与作者文档写入，并在整个视图生命周期内不变；内层沙箱 frame 加载同一目录的 `content.html`，因此两边的 origin 都是具体值、按精确值校验。编辑器为每个视图创建两条专用 `MessagePort`：一条直连内层作者 frame（`DeviceViewApi` 的 props、模型方法与事件、包资源读取、视图身份与关闭通知），一条直连该环境的 Service Worker（包资源读取）。外层只在内层 frame 报出本次环境令牌后转交端口，自身不转发任何作者调用或包读取。内层 bootstrap 先安装 `acquireDeviceViewApi`、监听器与包资源授权，再向外层宣告就绪；外层随后把作者文档写入 `frame.contentDocument`（`document.open/write/close`），window 与两个 frame 身份都保持不变。作者侧只拿到一次性的 `acquireDeviceViewApi`，拿不到 `MessagePort`、宿主代理或编辑器 DOM；包资源只有授予该环境的页面与它用令牌授权的内层 frame 可读，其它客户端、页面跳转与未声明文件一律拒绝。专用端口与当前视图租约绑定，视图释放或任一端关闭时立即关闭相关订阅与端口，失败后不会重新授予端口；作者文档的跳转或重新加载（重新启动 `content.html` 的 bootstrap）会明确报告 `view/execution-failed`，不会重新打开环境。

工作台主题以计算后的颜色转发给每个环境：`--mica-*` 变量与 `color-scheme` 在任意作者脚本执行前注入内层文档根，之后主题或系统明暗变化就地更新同一文档根，不重载 frame，也不丢失作者输入、模型会话或文档历史。加载期的底色也不会白闪：加载中的视图由容器槽位绘制当前视图背景（`panel.background`，即 `--mica-panel`，同时保留既有加载提示），owner 在加载期间保持透明，frame 在作者文档写入并应用主题前保持隐藏（`visibility`，不卸载、不重建，脚本照常运行），因此浏览器为未着色子文档绘制的白色画布不会被看到；环境报告就绪后 owner 取得当前主题底色并显示 frame。这条链路由 `setTheme` / 主题中继实时重绘，所以外层模块或内层 bootstrap 被延迟时切换主题，显示的始终是最新颜色而不是首次快照。没有转发主题的独立宿主使用完整暗色默认值，示例监视器的 `body` 也使用同一 `--mica-panel`，作者样式加载前后底色一致。

部署时把构建产物 `dist/view-environment/` 中的五个文件（`index.html`、`content.html`、`environment.js`、`environment-sw.js`、`content.js`）部署到 `viewBaseUrlTemplate` 对应目录；需要 HTTPS 或开发用的 `*.localhost` 安全上下文、独立子域名及 Service Worker 支持。宿主构建从源码消费时启用 `micaSandboxPlugins()`；发布包已内联 worker 脚本与内层 bootstrap。

### 主题与颜色 Token

信息容器固定在活动栏首位。当前模式只有属性视图时，容器头部合并为“属性”及其操作，内容始终展开，保留收起整个侧栏的操作；包含器件视图时，头部显示“信息”，各视图保留自己的标题并支持折叠。最后一个展开的视图填满剩余高度，其后的折叠标题随之推到底部，保持视图顺序；空间不足时在容器内滚动。已打开的浮动视图隐藏头部入口，关闭后重新显示入口。折叠、停靠和浮动均不改变可用视图的计数；属性视图固定在首位。

电源、接地端子和网络标签的符号、文字与默认偏移使用场景单位，已放置内容与幽灵预览均随画布缩放。导线预览、提交和器件移动使用共用的正交路由；端子、网标与器件放置一次后返回选择工具，Esc 取消放置且不写入文档。

工作台界面使用简体中文。工具条固定在画布左上角，模式切换位于最左侧，选中背景以胶囊滑动，并尊重系统的减少动态效果设置。宿主按钮与内置按钮共用实际宽度测量：依次使用图标与文字、仅图标、部分按钮进入“更多工具”的方式收纳；下拉菜单始终显示完整文字。编辑模式下双击器件会选中器件并展开属性侧栏；窄屏侧栏从顶部覆盖画布，通过向右箭头收起。

融合工作台默认使用中性暗色，以黑、白、灰区分背景、面板、操作与接线。`theme` 接受 `'dark'`、`'light'`、`'system'`，或 `{ appearance, colors }`；只有显式选择 `system` 才跟随系统主题。`colors` 按语义 Token 覆盖基础色板，覆盖值不会因系统明暗切换而丢失。

```typescript
workbench.setTheme({
  appearance: 'dark',
  colors: {
    accent: '#7c3aed',
    'accent.foreground': '#ffffff',
    'panel.background': '#23212c',
    'canvas.background': '#15131b',
    'canvas.wire': '#b6d7a8',
    'canvas.pin': '#c4b5fd',
  },
});
```

`setTheme` 即时更新画布、工具条、侧栏和浮动面板，不修改文档、撤销历史或运行会话。`getTheme` 返回当前只读配置快照。Token 名与覆盖值由 TypeScript 约束；未知 Token、空值和无效 CSS 颜色会明确报错。可使用在宿主容器可解析的 CSS 变量，例如 `var(--app-accent)`。

| Token                                           | 用途                         |
| ----------------------------------------------- | ---------------------------- |
| `workbench.background` / `workbench.foreground` | 工作台背景和主要文字         |
| `workbench.mutedForeground`                     | 次要文字和图标               |
| `panel.background`                              | 侧栏、面板标题与模式背景     |
| `border`                                        | 工具条、输入框与面板边框     |
| `accent` / `accent.foreground`                  | 主操作、活动模式及其前景     |
| `selection.background`                          | 活动项与悬停背景             |
| `focus.border`                                  | 键盘焦点                     |
| `canvas.background` / `canvas.grid`             | 画布底色和网格               |
| `canvas.foreground`                             | 引脚名、位号、网标与参考符号 |
| `canvas.wire` / `canvas.pin`                    | 接线与引脚锚点               |
| `canvas.selection`                              | 选择边框、选中接线与预览     |
| `error.foreground`                              | 故障提示                     |
| `shadow`                                        | 浮动表面的阴影颜色           |

`WorkbenchColorToken` 与 `WorkbenchThemeColors` 提供 Token 类型；`WORKBENCH_DARK_COLORS`、`WORKBENCH_LIGHT_COLORS` 和 `WORKBENCH_THEME_CSS_VARIABLES` 提供默认色板及 CSS 变量映射。器件底图与动态业务图形由器件作者绘制，工作台主题不改写这些资源；HTML 视图不同，环境会把同一组语义 Token 作为 `--mica-*` 变量注入作者文档根，作者用 `var(--mica-bg)` 之类的写法即可跟随工作台明暗。示例监视器就是这样去掉硬编码暗色的。

可运行的按钮、LED 与 HTML 监视器示例：先构建 SDK 依赖及编辑器，再运行 `pnpm --filter @mica-js/playground dev:workbench`，打开 `http://127.0.0.1:5193/workbench.html`。示例宿主提供宽度、主题、强调色和付费授权切换，以及保存、重开和器件库扩展。

## 使用

```ts
import '@mica-js/editor/style.css';
import {
  createSchematicEditor,
  type IDeviceLibrary,
  type IFileSystemProvider,
} from '@mica-js/editor';

export async function mount(
  container: HTMLElement,
  uri: string,
  fileSystem: IFileSystemProvider,
  deviceLibrary: IDeviceLibrary,
) {
  const editor = await createSchematicEditor({ container, uri, fileSystem, deviceLibrary });
  const subscription = editor.onDidChangeContent((document) => {
    // Integrators decide how and when to persist each committed snapshot.
    console.log(document);
  });
  return async () => {
    subscription.dispose();
    await editor.dispose();
  };
}
```

`uri` 必须为绝对 URI。工厂读取并解析文档、准备其中引用的器件、挂载视图后返回；首次加载缺失器件会拒绝创建。内置符号不请求 library。初始化失败会释放已构造的服务。可选 `readOnly` 禁止交互和命令修改，可选 `theme` 配置颜色。

内容事件在编辑、撤销、重做提交后发送快照，首次加载不发送；订阅返回 Disposable。文件系统只读，保存、序列化和修改状态由集成方维护。

命令通过类型映射约束名称、参数及返回值。修改命令使用一个参数对象，无参数命令省略第二个参数；底层文档命令保留为内部实现。

```typescript
await editor.executeCommand('schematic.setProperty', {
  symbolId,
  key: 'resistance',
  value: 1000,
});
await editor.executeCommand('schematic.setProperties', {
  symbolId,
  values: { resistance: 2200 },
  remove: ['tolerance'],
});
await editor.executeCommand('schematic.placeDevice', { deviceId: 'demo:resistor' });
await editor.executeCommand('schematic.undo');
```

`setProperties` 将整组设置及重置作为一步撤销；重置使用 `remove`，保留属性值 `null` 自身的含义。器件、导线、选择、工具及视图操作见导出的 `ISchematicCommandMap`。

文档命令按调用顺序执行。命令失败拒绝 Promise，队列继续接受后续命令。关闭后禁止执行命令，正在等待器件解析的编辑不会再提交；重复关闭返回同一个 Promise。关闭只移除编辑器自己的 DOM 和内部资源，保留宿主容器与 provider。

原理图器件拖动按细网格间距吸附（`gridSize / gridSubdivisions`，默认 5 页面单位）；预览与提交使用同一位置，未拖动的轴保持原坐标。引脚连接处分支数超过 2（包含引脚短线）时自动绘制连接圆点，使用当前预览几何，不向文档新增 junction 记录。

## 画布编辑器

`createCanvasEditor({ container, uri, fileSystem, deviceLibrary, widgetLibrary, readOnly? })` 加载一个 `.cnv` 文档，准备关联原理图、描述和资源，创建内部 sandbox 后挂载画布。门面与原理图一致：`uri`、`state`、`onDidChangeContent`、`executeCommand` 和 `dispose`。

画布支持单个 widget 选中、拖动、角点调整尺寸、任意角度旋转、删除与撤销重做。拖动选中框顶部引线末端的圆形手柄可绕 widget 中心旋转，手柄大小、引线长度和命中范围不随缩放变化。旋转保留按下时的角度偏移，拖动仅预览，松开指针提交一次可撤销的修改；Escape、失焦、指针取消、丢失捕获、外部文档修改或切换到仿真模式会取消编辑预览。旋转后仍可沿 widget 自身轴线调整尺寸并拖动位置；尺寸手柄在悬停与拖动时显示随 widget 角度变化的方向指针。仿真模式将局部坐标的交互事件交给 widget；文档编辑在编辑模式执行。只读选项禁止文档修改，仍允许仿真交互。

滚轮以指针位置为中心缩放视图，范围为 10%–800%；鼠标中键拖动或按住空格后左键拖动可平移视图。这些操作在编辑、仿真和只读模式均可用。视图变化只保留在当前编辑器实例中，不修改文档、不进入撤销历史，也不触发 `onDidChangeContent`。

| ID                                             | 参数与行为                                                          |
| ---------------------------------------------- | ------------------------------------------------------------------- |
| `canvas.setProperty` / `canvas.removeProperty` | `{ instanceId, key, value? }`，设置或重置 widget 属性               |
| `canvas.setProperties`                         | `{ instanceId, values, remove? }`，批量设置及重置，一步撤销         |
| `canvas.setBinding`                            | `{ instanceId, port, target }`，目标为 `{ symbol, port }` 或 `null` |
| `canvas.setSchematic`                          | `{ path, bindings? }`，切换或解除关联，见下文                       |
| `canvas.addWidget` / `canvas.removeWidget`     | 添加或移除 widget                                                   |
| `canvas.setPlacement` / `canvas.setZ`          | 修改位置、尺寸、角度或绘制顺序                                      |
| `canvas.undo` / `canvas.redo`                  | 撤销或重做一个文档修改                                              |
| `canvas.setMode`                               | `{ mode: 'edit' \| 'simulation' }`；切换会重建初始运行状态          |
| `canvas.run` / `canvas.pause`                  | 开始或暂停固定步长仿真                                              |
| `canvas.step` / `canvas.reset`                 | 执行一个固定步长或重建初始运行状态                                  |
| `canvas.zoomIn` / `canvas.zoomOut`             | 以视口中心为锚点放大或缩小视图                                      |
| `canvas.fitView` / `canvas.resetView`          | 适应全部旋转边界或恢复 100% 视图                                    |

完整参数和返回值见导出的 `ICanvasCommandMap`。

可选 `voltageReferences: { VCC: 5 }` 为同名原理图网络配置固定板级电压，接地网络保持 0 V。电源标记只命名网络，电压由该选项显式提供。

Canvas Editor 自动为 Widget 音频创建并管理 `AudioContext`，无需宿主传入音频对象。`canvas.run` 恢复播放；`canvas.pause`、重置和切回编辑模式会暂停音频，单步保持静音。浏览器可能要求用户手势：建议从点击事件直接调用运行命令；自动运行被阻止时，在运行中的画布内点击或按键可再次解锁。浏览器不支持 Web Audio 时仍可使用编辑器，只是不播放声音；音频初始化或恢复错误通过 `onDidError` 报告。替换运行时或销毁编辑器会释放对应音频上下文。

工厂选项 `stepMs` 同时设置每步仿真时长与目标帧周期，单位为毫秒，默认 `20`（50 FPS）；例如 `createCanvasEditor({ ...options, stepMs: 10 })` 对应每步 10 ms、目标 100 FPS。值必须为有限正数，转换后至少为 1 ps，且不得超过运行时时间范围。单步命令也使用此步长，创建后不能动态修改。

运行会话负责唯一帧调度器，默认以 20 ms 固定步长推进仿真，目标帧率为 50 FPS。调度按单调时钟的绝对时间目标对齐，扣除执行耗时；单步过慢时跳过错过的时隙，不并发、不积压补步，因此过载时仿真慢于实时。暂停时仍按该节奏刷新 widget 而不推进仿真时间。话题数据通过两个 guest 之间的直连 RPC 通道传递，editor 配置绑定，不在 UI 线程转发 payload。位置、旋转和层级只属于编辑器；改变执行输入时先建立候选会话，全部准备成功后替换旧会话。文档与历史在准备失败时保持原值。

library 的代码只在 sandbox 中执行，资源由 editor 通过只读文件系统预先读取。关闭 editor 会取消时钟、移除视图，并释放内部运行实例、RPC、bitmap 和 sandbox；外部 provider 保留宿主所有权。

内部服务通过构造参数装饰器注入，使用此包的 TypeScript 配置启用 `experimentalDecorators`。DI 容器和服务标识保留在包内，应用通过具体编辑器工厂创建实例。

## 宿主集成

- `getDocument()` 返回只读文档快照；`onDidChangeContent` 只在提交、撤销及重做后发送，拖动预览不触发。
- `getSelection()` / `setSelection()` 与 `onDidChangeSelection` 用于对象树、搜索和编辑视图联动。原理图按目标类型区分器件、导线等对象；画布目标为 `{ kind: 'widget', id }`，当前一次选择一个 widget。
- `onDidClick`、`onDidDoubleClick`、`onDidContextMenu` 携带目标（空白为 `null`）、文档坐标 `position`、CSS 客户端坐标 `clientPosition`、按钮、修饰键及编辑模式。点击导致的选中变化先通知，重复点击相同对象仍发送点击事件；拖动、尺寸调整、旋转及平移不作为点击。
- 双击沿用浏览器语义，允许此前已发送单击通知。右键事件供宿主定位菜单，仿真交互通知与 widget 运行时输入分开处理。
- `getProperties(id)` 返回属性名称、类型、有效值、默认值、覆盖值、覆盖状态及只读状态。面板在选中变化和内容变化时刷新；修改通过类型化命令提交。
- `getState()` / `onDidChangeState` 提供只读、模式和撤销重做状态；`onDidError` 提供来源及原始错误。命令失败同时拒绝 Promise，宿主可统一展示反馈。
- 事件订阅返回 Disposable，宿主卸载面板时释放订阅；编辑器关闭时释放自身订阅和事件。

```typescript
const refresh = () => {
  const selection = editor.getSelection();
  const document = editor.getDocument();
  renderObjectTree(document, selection);
};
const subscriptions = [
  editor.onDidChangeContent(refresh),
  editor.onDidChangeSelection(refresh),
  editor.onDidDoubleClick((event) => openDetails(event.target)),
  editor.onDidError(({ error }) => showError(error)),
];
refresh();
// On host unmount:
subscriptions.forEach((subscription) => subscription.dispose());
```

### 话题绑定及原理图关联

`canvas.getBindings(instanceId)` 返回 widget 端口的当前目标和器件端口候选。候选包含兼容状态及不兼容原因，编辑器在提交时重新校验方向、负载类型和投递语义。绑定目标使用器件实例 ID 与端口名，运行时负责话题路由。

```typescript
await canvas.executeCommand('canvas.setBinding', {
  instanceId,
  port: 'press',
  target: { symbol: symbolId, port: 'in' },
});
await canvas.executeCommand('canvas.setSchematic', {
  path: 'circuits/main.sch',
  bindings: 'clear',
});
await canvas.executeCommand('canvas.setSchematic', { path: null });
```

`projectRoot` 可指定项目根目录的绝对 URI，关联路径相对该根目录解析；省略时使用画布 URI 所在目录。切换默认 `bindings: 'preserve'`，保留并校验原绑定；选择 `clear` 清空全部绑定，解除关联也会清空绑定。路径、绑定、资源和候选运行时全部准备成功后提交，一步撤销恢复原关联及绑定；失败时文档与活动运行时保持原状态。只读或仿真模式下拒绝文档修改。

## Provider 契约

本包导出以下 provider 类型：

- `IFileSystemProvider` 复用只读 HostFs 的 `read(uri)`，以绝对 URI 读取完整字节内容，失败拒绝 Promise。
- `IDeviceLibrary.resolve(id)` 返回 `IDeviceDescription | undefined`。
- `IWidgetLibrary.resolve(id)` 返回 `IWidgetDescription | undefined`；它与现有 WidgetProvider 结构兼容。

`id` 是文档中的完整标识，例如 `demo:button`，不是 URI。两个 library 只提供 `resolve`；未找到返回 `undefined`，加载失败拒绝 Promise。

描述对象均为自包含的 `definition` 与 `code`，不引用外部资源：

| 描述                 | 元数据                                    | 代码约定                                         |
| -------------------- | ----------------------------------------- | ------------------------------------------------ |
| `IDeviceDescription` | `IDeviceDefinition`：SDK `DeviceMetadata` | 自包含 SDK ESM，具名导出 `model` 与同步 `create` |
| `IWidgetDescription` | 复用现有 WidgetModule 的 definition       | 自包含 ESM，默认导出现有 WidgetFactory           |

`IDeviceDefinition` 复用 `@mica-js/sdk/metadata` 的 `DeviceMetadata`。SDK 将 DDL 编译为共享器件模型，并与同步适配器打包成 `device.js`；画布会话在内部 sandbox 中装载 `model` 和 `create`，使用 `createDeviceLibrary` / `createBoard` 运行。元数据用于符号、属性与话题绑定校验，解析阶段不执行代码。字段及 JSON Schema 见 [device.json 格式](../../docs/formats/device.md)，作者构建入口见 [SDK](../sdk/README.md)。

新版 `symbol.graphics` 按声明绘制线段、折线、矩形、圆、圆弧和文本；`bounds` 用于选择区域，`symbol.pins` 指定接线锚点、方向与标签，`annotations.designator` 指定位号位置和对齐。图元坐标随器件平移和旋转，填充与描边使用编辑器主题。省略 `symbol` 时，根据顶层引脚合成符号。属性面板数据保留必填性、分组、排序和编辑器提示，枚举选项使用 `values` 与 `editor.labels`。

内部解析服务在实例范围内合并相同 ID 的并发解析并缓存成功结果；未找到和失败结果允许重试。解析只获取描述，不执行代码。已返回的描述在该实例内按稳定只读值使用；重新创建实例会重新解析。Provider 由宿主拥有，编辑器只释放自己的解析缓存。

## 开发

文档契约来自 `@mica-js/document/schematic`；历史管理、命中测试与拖动预览由本包内部持有。

测试使用依赖包的发布入口，首次在干净检出中运行前需先构建依赖。

```powershell
pnpm --filter @mica-js/editor... build
pnpm --filter @mica-js/editor typecheck
pnpm --filter @mica-js/editor test
pnpm --filter @mica-js/editor build
```
