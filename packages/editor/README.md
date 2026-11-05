# @mica-js/editor

独立组合根的编辑器。原理图工厂提供 URI 加载、器件解析、Canvas 渲染、编辑、撤销与重做；画布工厂提供 widget 合成、布局编辑和仿真会话。两个工厂分别拥有服务容器和内部实现。

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

运行会话负责唯一帧调度器，以 25 ms 固定步长推进仿真；暂停时继续刷新 widget 而不推进仿真时间。话题数据通过两个 guest 之间的直连 RPC 通道传递，editor 配置绑定，不在 UI 线程转发 payload。位置、旋转和层级只属于编辑器；改变执行输入时先建立候选会话，全部准备成功后替换旧会话。文档与历史在准备失败时保持原值。

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
