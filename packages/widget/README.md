# @mica-js/widget

Mica Widget 的契约与运行时：Widget 定义、端口/属性描述、把包内脚本解析为 `WidgetModule` 的加载器，以及在沙箱 guest 侧执行脚本、在宿主侧持有 `.cnv` 文档并协调实例与层位图的 `WidgetHost`。

本包把 **Widget 变成纯数据**（定义 + 单文件源码），也负责**把纯数据跑起来**：运行时只认识 `WidgetProvider`；「包」只是分发方式，解析逻辑收敛在 provider 实现里，不向上层泄漏。执行隔离完全交给 `@mica-js/sandbox`，本包不改动它的协议。

## 安装

```bash
pnpm add @mica-js/widget
```

## 公共入口

唯一公开入口为 `@mica-js/widget`，构建生成 `dist/index.js`（ESM）与声明文件。

| 导出                                        | 作用                                                                 |
| ------------------------------------------- | -------------------------------------------------------------------- |
| `WidgetModule`                              | `{ definition, code }`：定义与单文件 ESM 源码                        |
| `WidgetDefinition`                          | `properties`、`ports` 及可选的 `displayName` / `description`         |
| `PropertyDefinition`                        | 属性描述（#7），除 `type` 外字段原样透传                             |
| `PortDefinition`                            | 话题端口描述（#10）：`direction`、`type`，可选 `title`/`description` |
| `WidgetProvider`                            | 唯一方法 `resolve(ref): Promise<WidgetModule \| undefined>`          |
| `createStaticWidgetProvider(modules)`       | 固定模块表，用于内置 Widget 与测试                                   |
| `createPackageWidgetProvider({ files })`    | 读取包并建立 `<包ID>:<widgetID>` 索引                                |
| `loadWidgetPackage(files)`                  | 把单个包的字节来源解析为 `WidgetPackage`                             |
| `PackageFiles` / `WidgetPackage`            | 字节读取抽象与包解析结果                                             |
| `WidgetLoadError`                           | 带 `code`、`packageId`、`path` 的加载错误                            |
| `createWidgetHost({ provider, ... })`       | 创建 `WidgetHost`；沙箱在第一个实例挂载时惰性启动                    |
| `WidgetHost`                                | 持有 `.cnv` 文档、编排实例、投递、输入分发与 `dispose`               |
| `WidgetLayers` / `WidgetLayer`              | 按文档顺序的层位图与 `sequence`，供宿主或编辑器合成                  |
| `WidgetLayerChange`                         | `added` / `updated` / `removed` / `reordered` 订阅事件               |
| `WidgetDiagnostic` / `WidgetDiagnosticCode` | 不打断调用方的失败上报                                               |
| `WidgetInputEvent`                          | 转发给实例的指针 / 键盘事件                                          |
| `WidgetInstanceApi` / `WidgetInstance`      | Widget 工厂收到的实例 API 与可选钩子                                 |
| `WidgetAssetRef`                            | 资源引用 `{ src, mode: 'file' \| 'inline' \| 'store' }`（#7）        |
| `WidgetAssetApi` / `WidgetAssetProvider`    | guest 的 `readBinary` 与宿主侧的资源解析                             |
| `WidgetPublish`                             | `{ instanceId, port, payload, simTime }`                             |
| `WidgetFactory` / `WidgetDeliveryMeta`      | 模块默认导出的工厂类型与端口投递元数据                               |
| `WidgetSandbox` / `WidgetSandboxFactory`    | 可注入的最小沙箱接口（`call` / `on` / `terminate`）                  |
| `WIDGET_RUNTIME_SOURCE`                     | 构建期内联的 guest 运行时 ESM 源码                                   |

`PayloadType` 由 `@mica-js/core/canvas` 提供，本包不重复定义。

## 快速上手

```ts
import { createPackageWidgetProvider } from '@mica-js/widget';

const provider = await createPackageWidgetProvider({
  files: {
    label: 'gauge-package',
    async read(path) {
      return readFromDisk(`node_modules/gauge-package/${path}`);
    },
  },
});

const widget = await provider.resolve('gauge-package:brightness');
if (widget === undefined) {
  // 未知引用：调用方决定回退策略，这里不抛错。
} else {
  // widget.definition 是纯数据；widget.code 交给沙箱执行。
}
```

包只在构造 provider 时读取；之后每次 `resolve` 都命中内存索引，不再访问文件系统。坏包在构造阶段抛 `WidgetLoadError`，未知引用返回 `undefined`。

## 运行时（`WidgetHost`）

`WidgetHost` 持有画布文档（`.cnv`，见 `@mica-js/core/canvas`）：宿主只声明文档、提交命令，实例的增删改由 host 协调。

```ts
import { createStaticWidgetProvider, createWidgetHost } from '@mica-js/widget';

const host = createWidgetHost({
  provider: createStaticWidgetProvider({ 'gauge:brightness': widgetModule }),
  onDiagnostic: (diagnostic) => console.warn(diagnostic.code, diagnostic.message),
});

const gaugeId = '2b6f0d1e-6f0a-4a7a-9a39-0d3c5a1f7c11';

await host.loadDocument({
  version: 1,
  widgets: [
    {
      id: gaugeId,
      widget: 'gauge:brightness',
      x: 120,
      y: 64,
      width: 160,
      height: 48,
      rotation: 0,
      properties: { color: '#22AA55FF' },
    },
  ],
});

host.applyCommand({ type: 'set-z', instanceId: gaugeId, z: 0 });
host.applyCommand({
  type: 'set-placement',
  instanceId: gaugeId,
  placement: { x: 120, y: 64, width: 320, height: 96, rotation: 0 },
});

host.layers.subscribe((change) => {
  // { type: 'added' | 'updated' | 'removed', instanceId } | { type: 'reordered' }
});
host.deliver(gaugeId, 'brightness', 0.42, 1280);
host.dispatch(gaugeId, { type: 'pointerdown', x: 12, y: 8 });

const layer = host.layers.get(gaugeId);
// { instanceId, width, height, dpr, bitmap, sequence }

await host.dispose();
```

### 文档与接口

```ts
interface WidgetHost {
  readonly document: CanvasDocument;
  loadDocument(document: CanvasDocument): Promise<void>;
  applyCommand(command: CanvasCommand): void;
  onDocumentChange(listener: (document: CanvasDocument) => void): () => void;
  reset(): Promise<void>;
  deliver(instanceId: string, port: string, payload: unknown, simTime: number): void;
  dispatch(instanceId: string, event: WidgetInputEvent): void;
  readonly layers: WidgetLayers;
  resize(dpr: number): void;
  dispose(): Promise<void>;
}
```

`document` 初始是空文档 `{ version: 1, widgets: [] }`；`loadDocument` 只接收解析好的 `CanvasDocument`（`.cnv` 文本请先用 `@mica-js/core/canvas` 的 `parseCanvas` 解析），`applyCommand` 接受 `@mica-js/core/canvas` 的 `CanvasCommand`。宿主仍会重新校验传入的文档，坏文档抛 `SchematicError` 且不改变已挂载的实例。实例级操作（挂载、卸载、改尺寸、改属性）不再公开，`WidgetMountSpec` / `WidgetSize` 也随之从公开类型中移除。

### 重置（`reset()`）

`reset()` 让**全部 widget 回到初始状态**，供宿主在切换编辑/运行模式时调用：

1. 同步清空 `#instances` 与 `layers`（编辑器立刻画占位框）；
2. 在协调队列里先调用 guest 的 `reset-runtime`：卸载所有 session（释放画布、清订阅），**工厂与定义保留**，模块不会被重新求值；
3. 再按**当前文档**重新 `load` + `mount` 每个实例，`props` / `assets` 重新合并与预取；resolve 时全部实例已重新挂载。

要点：guest 本身不重启（iframe/worker 保留），所以重置比销毁重建便宜得多；`reset()` 与 `applyCommand` / `loadDocument` 共用同一条协调队列，不会与进行中的协调交错；重置失败只上报 `widget/runtime-failed`，不 reject，随后的重挂载照常进行。

**实例状态写在工厂闭包里。** 重置只重建实例，不会重新求值模块，所以 `export default` 之外的状态（`let counter = 0;` 这类）在重置后保持原样——那是未定义行为。模块顶层是共享常量与纯函数的位置，实例状态属于工厂作用域（见 x-botlab/mica-js#2）。

### 校验

两条入口都先跑 `parseCanvas` 的结构校验（仅 `loadDocument`）或 `applyCanvasCommand` 的结构校验（仅 `applyCommand`），再跑 `validateCanvasBindings(document, { catalog })`；出现 error 级诊断时抛 `SchematicError`，文档与实例都不改变。`applyCommand` 的顺序固定为「应用命令 → 校验绑定 → 提交快照」，因此被拒绝的命令不会留下半成品状态。

`WidgetHostOptions.catalog`（`CanvasBindingCatalog`，来自 `@mica-js/core/canvas`）提供 widget 定义与原理图符号，用来校验引用、属性名、端口方向与载荷类型。**未提供 `catalog` 时跳过引用校验**，只保留结构与绑定形状校验，行为与未接入注册表的宿主一致。

### 协调语义

- **按 id 比对**：文档新增的 id → 挂载；消失的 id → 卸载；几何变化 → `resize`；属性变化 → `set-properties`；无变化不动 guest。
- **几何比较**用 `x`、`y`、`width`、`height`、`rotation` 五项判定是否变化，但只有 `width` / `height` 会推给 guest：`x` / `y` / `rotation` 只影响合成位置，已经在文档里，层只需要尺寸。
- **属性比较**是浅比较：键集合相同且每个键 `Object.is` 相等才算没变化。文档拥有属性值，嵌套对象只有被整体替换才算改动；键集合参与比较，因为缺失的键回落到定义默认值，而显式 `undefined` 会覆盖默认值。
- **资源属性变化会重挂载**：guest 只在挂载时收到预取好的字节，所以属性里出现新的 `{ src }` 时宿主按「卸载 + 挂载」处理，让新资源随挂载送达；没有新资源时仍只发 `set-properties`。
- **顺序**：`layers.list()` 的顺序等于 `document.widgets` 的顺序。`set-z` 只重排层表，不重新挂载，并以 `{ type: 'reordered' }` 通知订阅者。
- **几何与位图分离**：几何变化同步改 layer 的 `width` / `height`（`sequence` 不变），新位图异步到达后再递增 `sequence`。
- **串行化**：协调走单条内部队列。多次 `applyCommand` 不会并发调用 guest，队列每轮都以**最新快照**为准，因此中间态会被合并，不会出现重复挂载或漏掉卸载。层订阅者在 `layers.subscribe` 回调里同步 `applyCommand` 也被允许：这次提交只把工作排到正在运行的队列上，不会另起一条协调循环。
- **`applyCommand` 同步、协调异步**：文档快照与 `onDocumentChange` 立即更新；挂载、`resize`、`set-properties` 在后台进行。协调失败只经 `onDiagnostic` 上报（`widget/mount-failed`、`widget/render-failed` 等），**不回滚文档**；失败的实例不在 `layers` 里，下一次提交会重试。
- **`loadDocument` 异步**：等首批实例挂载完成后才 resolve。单个 widget 挂载失败不会让 promise reject，只上报诊断。
- **实例移除是同步的**：快照提交时立即丢掉被移除实例的 layer 与记录，因此「挂载还在途中就被移除」能在当下取消，而不必等协调队列腾出空位。

### 执行模型

- 全部实例共用一个 `createSandbox()`；widget 代码以文本经 guest 方法 `load` 注入，guest 用 blob URL + `import()` 求值一次并缓存默认导出的工厂。`reset-runtime` 只丢弃 session，工厂缓存保留，因此模块不会再次求值。
- 每个实例有自己的 `OffscreenCanvas`（`round(width * dpr) × round(height * dpr)`），2D 上下文按 `dpr` 缩放，widget 始终使用逻辑尺寸绘制。
- guest 自建画布，通过自定义事件把 `ImageBitmap` **转移**给宿主，不使用沙箱的 `GuestSurface`：一个 guest 一块整幅表面的模型没有 surface 标识，多个实例分不清来源。
- 事件使用 `widget:` 命名空间：`widget:frame`、`widget:publish`、`widget:error`、`widget:asset-failed`。沙箱保留了 `mica:` 前缀（guest 侧 `mica:` 事件会被丢弃，`sandbox.on('mica:...')` 会抛错），因此不能使用 `mica:widget-frame`。
- 只在需要时提交：`invalidate()`、首次挂载、`resize`、`set-properties`；同一 tick 内多次 `invalidate()` 合并为一帧。

### 属性默认值

`definition.properties[*].default` 在挂载时与传入 props 合并：文档里出现的键优先，未出现的键回落到默认值。只有描述符自身声明了 `default` 才填入，因此 `default: null` 与「未声明 default」可区分。默认值按实例深拷贝并递归 `Object.freeze`，widget 既改不动定义，也不会把改动串到其它实例；`set-properties` 同样重新合并。

### 资源预取（`api.assets`）

guest 无网络、无 DOM，因此资源由宿主在**挂载时**预取。`WidgetHostOptions.assets` 提供读取来源：

```ts
import { createWidgetHost } from '@mica-js/widget';

const host = createWidgetHost({
  provider,
  assets: {
    async resolve(ref) {
      // mode 为 'inline' 时在这里完成 base64 解码，guest 只会看到字节。
      return loadBytes(ref.src);
    },
  },
});
```

宿主遍历合并默认值后的 props（含对象与数组里的嵌套值），收集所有形如 `{ src, mode }` 的引用，逐个 `resolve` 后把 `src → Uint8Array` 随 `mount` 请求一起发给 guest；同一个 `src` 只读一次。单个资源失败只上报 `widget/asset-failed` 并跳过该资源，实例照常挂载；没有配置 `assets` 时不做任何预取，也不报错。预取发生在挂载时：属性改动引入新的 `{ src }` 时宿主会重挂载该实例，让新资源随挂载送达。

widget 通过 `api.assets.readBinary(src)` 读取：

```js
const bytes = await api.assets.readBinary(api.props.texture.src);
```

每次调用返回**副本**，widget 可以随意修改。未预取的 `src`（没有来源、读取失败，或挂载后才出现且还没重挂载）会被 reject，并在同一实例、同一 `src` 的首次失败时上报一条 `widget/asset-failed`。**这个 Promise 必须由 widget 自己 `catch`**：不 await 也不 catch 会在 guest worker 里留下 unhandled rejection。

### `publish` 携带 `simTime`

`api.publish(port, payload, simTime?)` 的第三个参数是 widget 做出反应时的仿真时刻，`onPublish` 回调因此总能读到 `simTime`。当前宿主没有仿真时钟，未显式传入时填 `0`；接入仿真后由 widget 传入当时的 `simTime`。

### 启动时机

`createWidgetHost()` 同步返回，sandbox 在**第一个实例挂载时**才启动，同一次协调里的并发挂载共享这一次启动。没有实例的宿主不必承担 iframe + worker 的启动成本；挂载本身是异步的，因此懒启动对调用方不可见。

### 层（`WidgetLayers`）

`layers.list()` 按 `document.widgets` 顺序返回（即绘制顺序），`get()` 返回**同一份活对象**：尺寸变化立即改变 `width`/`height`（位图异步到达，`sequence` 不变），新帧到达时 `sequence` 递增并把上一帧 `close()`。实例被移除时关闭当前帧，`dispose` 关闭全部帧。`list()` 顺序即合成顺序，`set-z` 之后无需重新合成位图。

### 诊断

失败通过 `onDiagnostic` 上报，不抛给调用方；`loadDocument` 只在文档或绑定校验失败时 reject，`applyCommand` 只在命令被拒绝时抛错。重复实例、未知实例、未知 widget 这类校验失败只上报并返回。

| `code`                      | 场景                                                       |
| --------------------------- | ---------------------------------------------------------- |
| `widget/runtime-failed`     | sandbox 启动失败或运行中终止（层被清空）                   |
| `widget/unknown-widget`     | provider 未注册该引用，或引用不是 `<包>:<widget>`          |
| `widget/instance-exists`    | 同一 `instanceId` 已被占用（重复预留）                     |
| `widget/instance-not-found` | 对未挂载实例调用实例作用域方法                             |
| `widget/mount-failed`       | 工厂或 guest `mount` 抛出                                  |
| `widget/render-failed`      | `render` 抛错，或 `resize` / `set-properties` 调用失败     |
| `widget/deliver-failed`     | 订阅回调、输入回调或 `deliver` 调用抛错                    |
| `widget/asset-failed`       | 资源预取失败，或 widget 读取了未预取的资源（实例继续运行） |

`instanceId` 在挂载入口**同步预留**，所以同一 id 不会被两个挂载尝试同时占用。若实例在挂载完成前从文档里消失（或宿主被 `dispose()`），该次挂载以 `name === 'WidgetMountCancelledError'` 的 `Error` 结束，并清理 guest 侧已创建或即将创建的会话——不会留下无 layer 的「已挂载」假象，也不会误删同一 id 的新记录。挂载由文档驱动，因此这类取消不再向调用方 reject，也不产生诊断：新快照就是结果。

### 崩溃与重建

sandbox 终止时不自动重建实例：`dispose()` 主动终止沙箱；其它终止在**下一次调用**被发现（`SandboxHandle` 没有终止事件），此时清空 `layers` 并上报 `widget/runtime-failed`。之后的 `loadDocument` / `applyCommand` 会启动新的 sandbox 并重新 `load`，但只会挂载当次协调涉及的实例——自动重建整套视图留给后续增强。

### 编写 widget

```js
export default function indicator(api) {
  let value = 0;
  api.subscribe('brightness', (payload) => {
    value = Number(payload) || 0;
    api.invalidate();
  });

  return {
    render(ctx) {
      ctx.fillStyle = api.props.color ?? '#22AA55FF';
      ctx.fillRect(0, 0, api.width * value, api.height);
    },
    input(event) {
      if (event.type === 'pointerdown') api.publish('clicked', { x: event.x, y: event.y });
    },
    dispose() {},
  };
}
```

`render`、`input`、`dispose` 都可省略，纯逻辑 widget 不提供 `render`。工厂抛错、`render` 抛错、订阅回调抛错都在实例边界捕获：该实例停止渲染，其余实例继续工作。

## 类型

```ts
interface WidgetModule {
  readonly definition: WidgetDefinition;
  readonly code: string;
}

interface WidgetDefinition {
  readonly properties: Readonly<Record<string, PropertyDefinition>>;
  readonly ports: Readonly<Record<string, PortDefinition>>;
  readonly displayName?: string;
  readonly description?: string;
}

interface PropertyDefinition {
  readonly type: string;
  readonly default?: unknown;
  readonly [key: string]: unknown;
}

interface WidgetAssetRef {
  readonly src: string;
  readonly mode: 'file' | 'inline' | 'store';
}

interface WidgetAssetProvider {
  resolve(ref: WidgetAssetRef): Promise<Uint8Array>;
}

interface WidgetPublish {
  readonly instanceId: string;
  readonly port: string;
  readonly payload: unknown;
  readonly simTime: number;
}

interface PortDefinition {
  readonly title?: string;
  readonly description?: string;
  readonly direction: 'input' | 'output';
  readonly type: PayloadType;
}

interface WidgetProvider {
  resolve(ref: string): Promise<WidgetModule | undefined>;
}
```

属性描述沿用 #7，本包只合并 `properties[*].default`，其余字段原样保留、不解析语义；`ports[*].type` 必须是 `@mica-js/core/canvas` 中 `PAYLOAD_TYPES` 的成员。`properties` 与 `ports` 都是无原型对象（`Object.getPrototypeOf` 为 `null`），定义里的 `__proto__` 键会被忽略，不会变成记录的原型或幽灵成员。

## 包格式

`loadWidgetPackage` 只读取三类路径，从不遍历目录：

1. `package.json`；
2. 清单 `widgets[*].path` 声明的 Widget 描述 `.json`；
3. 与描述同目录同名的 `.js` 实现。

```json
{
  "name": "gauge-package",
  "version": "1.0.0",
  "widgets": {
    "brightness": {
      "path": "widgets/brightness.json",
      "displayName": "亮度指示",
      "description": "亮度条指示"
    }
  }
}
```

- `name` 必填且为 kebab-case（`[a-z0-9][a-z0-9-]*`），同时也是包 ID；`version` 必填且非空。
- `widgets` 可省略，省略视为空索引；键是稳定 Widget ID，同样使用 kebab-case。
- 条目必须有 `path`，可选 `displayName` / `description`；后者写入 `WidgetDefinition`。
- 路径必须是包内相对 POSIX 路径：绝对路径、盘符、反斜杠与 `..` 片段一律报 `widget/invalid-manifest`。
- 实现路径由描述路径把 `.json` 换成 `.js` 得到；缺少实现报 `widget/no-implementation`。
- 实现源码按原样交给调用方，本包不解析、不执行、不做静态检查（`widget/not-self-contained` 为保留错误码，留给执行侧使用）。
- `contentHash` 是「按 Widget ID 排序的 `[id, 源码]` 对经 `JSON.stringify` 后」的 SHA-256 十六进制；id 参与哈希，因此内容在 Widget 之间移动、或新增空实现文件都会改变哈希，可用于判断包内容是否变化。

## 错误

`WidgetLoadError` 的 `code` 是稳定契约，`packageId` 与 `path` 指向出错的包和包内路径：

| `code`                      | 场景                                               |
| --------------------------- | -------------------------------------------------- |
| `widget/package-not-found`  | `package.json` 缺失或不可读                        |
| `widget/invalid-manifest`   | 清单或 `widgets` 索引非法、路径越界、描述文件缺失  |
| `widget/invalid-definition` | 描述不是对象/非法 JSON，或 `ports` 类型不合法      |
| `widget/no-implementation`  | 同名 `.js` 实现缺失或不可读                        |
| `widget/not-self-contained` | 保留错误码；加载器不检查源码，供执行侧（沙箱）使用 |
| `widget/load-failed`        | 其它加载失败（例如环境缺少 `crypto.subtle`）       |

## 边界

- 加载器不执行源码、不创建 Worker；执行与隔离由 `WidgetHost` 交给 `@mica-js/sandbox`，本包不改动它的协议。
- 不解析实现源码：`import`、`export` 是否合法留给 guest 的 `import()` 决定，加载器只负责取字节与纯数据定义。
- 只合并属性默认值，不解析其它字段语义、不建立端口连接、不持久化实例配置。
- 不做话题路由：`publish` 只经 `onPublish` 交给调用方（带上 widget 给出的 `simTime`，缺省 `0`），`deliver` 的 `simTime` 由调用方提供。
- 不做资源缓存或动态 IO：资源只在挂载前预取一次，guest 侧没有网络与 DOM；`readBinary` 只读预取结果。
- **不按端口声明校验 `publish` / `subscribe`**：这两个方法目前接受任意端口名，`WidgetDefinition.ports` 在运行时基本未被使用。因此 widget 可以伪造任意端口的消息，宿主侧的 `onPublish` 也会原样收到。**#99 必须补上校验**：按该实例解析到的 `definition.ports` 检查 `publish` 的端口存在且 `direction === 'output'`，对未声明的端口丢弃并上报诊断（`subscribe` 同理，方向为 `input`）。校验必须放在 guest 侧（不可信代码就在那里）或以 definition 为准在宿主侧过滤，且不能在 `WidgetHost` 公开接口里引入编辑器概念。
- 不合成多层位图：`WidgetLayers` 只给位图与绘制顺序，合成交给宿主或 `@mica-js/canvas-editor`。
- 文档只用于协调实例：`loadDocument` / `applyCommand` 解析、校验并保存快照，但不做视口、选择、命中测试与命令生成，这些属于编辑器；也不持久化 `.cnv`，写盘由宿主负责。
- 不自动重建终止后的实例（见「崩溃与重建」）。
- 不枚举包目录，不跟随重定向或符号链接；读取哪些文件完全由清单决定。
