# @mica-js/widget

Mica Widget 的契约与运行时：Widget 定义、端口/属性描述、把包内脚本解析为 `WidgetModule` 的加载器，以及在沙箱 guest 侧执行脚本、在宿主侧管理实例生命周期与层位图缓存的 `WidgetHost`。

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
| `createWidgetHost({ provider, ... })`       | 创建 `WidgetHost`；沙箱在首次 `mount` 时惰性启动                     |
| `WidgetHost` / `WidgetMountSpec`            | 实例生命周期、属性、投递、输入分发与 `dispose`                       |
| `WidgetLayers` / `WidgetLayer`              | 按挂载顺序的层位图与 `sequence`，供宿主或编辑器合成                  |
| `WidgetLayerChange`                         | `added` / `updated` / `removed` 订阅事件                             |
| `WidgetDiagnostic` / `WidgetDiagnosticCode` | 不打断调用方的失败上报                                               |
| `WidgetInputEvent`                          | 转发给实例的指针 / 键盘事件                                          |
| `WidgetInstanceApi` / `WidgetInstance`      | Widget 工厂收到的实例 API 与可选钩子                                 |
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

```ts
import { createStaticWidgetProvider, createWidgetHost } from '@mica-js/widget';

const host = createWidgetHost({
  provider: createStaticWidgetProvider({ 'gauge:brightness': widgetModule }),
  onDiagnostic: (diagnostic) => console.warn(diagnostic.code, diagnostic.message),
});

await host.mount({
  instanceId: 'gauge-1',
  widget: 'gauge:brightness',
  width: 160,
  height: 48,
});

host.layers.subscribe((change) => {
  // { type: 'added' | 'updated' | 'removed', instanceId }
});
host.setProperties('gauge-1', { color: '#22AA55FF' });
host.deliver('gauge-1', 'brightness', 0.42, 1280);
host.dispatch('gauge-1', { type: 'pointerdown', x: 12, y: 8 });
host.update('gauge-1', { width: 320, height: 96 });

const layer = host.layers.get('gauge-1');
// { instanceId, width, height, dpr, bitmap, sequence }

host.unmount('gauge-1');
await host.dispose();
```

### 执行模型

- 全部实例共用一个 `createSandbox()`；widget 代码以文本经 guest 方法 `load` 注入，guest 用 blob URL + `import()` 求值并缓存默认导出的工厂。
- 每个实例有自己的 `OffscreenCanvas`（`round(width * dpr) × round(height * dpr)`），2D 上下文按 `dpr` 缩放，widget 始终使用逻辑尺寸绘制。
- guest 自建画布，通过自定义事件把 `ImageBitmap` **转移**给宿主，不使用沙箱的 `GuestSurface`：一个 guest 一块整幅表面的模型没有 surface 标识，多个实例分不清来源。
- 事件使用 `widget:` 命名空间：`widget:frame`、`widget:publish`、`widget:error`。沙箱保留了 `mica:` 前缀（guest 侧 `mica:` 事件会被丢弃，`sandbox.on('mica:...')` 会抛错），因此不能使用 `mica:widget-frame`。
- 只在需要时提交：`invalidate()`、首次挂载、`resize`、`set-properties`；同一 tick 内多次 `invalidate()` 合并为一帧。

### 启动时机

`createWidgetHost()` 同步返回，sandbox 在**首次 `mount()`** 时才启动，并发的 `mount()` 共享同一次启动。没有实例的宿主不必承担 iframe + worker 的启动成本；`mount()` 本身是异步的，因此懒启动对调用方不可见。

### 层（`WidgetLayers`）

`layers.list()` 按挂载顺序返回（即绘制顺序），`get()` 返回**同一份活对象**：`update()` 立即改变 `width`/`height`（位图异步到达，`sequence` 不变），新帧到达时 `sequence` 递增并把上一帧 `close()`。`unmount` 关闭当前帧，`dispose` 关闭全部帧。

### 诊断

失败通过 `onDiagnostic` 上报，不抛给调用方；只有 `mount()` 会 reject。重复实例、未知实例、未知 widget 这类校验失败只上报并返回。

| `code`                      | 场景                                                   |
| --------------------------- | ------------------------------------------------------ |
| `widget/runtime-failed`     | sandbox 启动失败或运行中终止（层被清空）               |
| `widget/unknown-widget`     | provider 未注册该引用，或引用不是 `<包>:<widget>`      |
| `widget/instance-exists`    | 同一 `instanceId` 重复 `mount`                         |
| `widget/instance-not-found` | 对未挂载实例调用实例作用域方法                         |
| `widget/mount-failed`       | 工厂或 guest `mount` 抛出（`mount()` 同时 reject）     |
| `widget/render-failed`      | `render` 抛错，或 `resize` / `set-properties` 调用失败 |
| `widget/deliver-failed`     | 订阅回调、输入回调或 `deliver` 调用抛错                |

guest 的 `mount` 阶段错误通过 `mount()` 的 rejection 呈现，因此一次失败只产生一条诊断。

### 崩溃与重建

sandbox 终止时不自动重建实例：`dispose()` 主动终止沙箱；其它终止在**下一次调用**被发现（`SandboxHandle` 没有终止事件），此时清空 `layers` 并上报 `widget/runtime-failed`。之后再次 `mount()` 会启动新的 sandbox 并重新 `load`，但不会恢复先前的实例——自动重建留给后续增强。

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

属性描述沿用 #7，本包只保留结构、不解析字段语义；`ports[*].type` 必须是 `@mica-js/core/canvas` 中 `PAYLOAD_TYPES` 的成员。`properties` 与 `ports` 都是无原型对象（`Object.getPrototypeOf` 为 `null`），定义里的 `__proto__` 键会被忽略，不会变成记录的原型或幽灵成员。

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
- 不解析属性字段语义、不建立端口连接、不持久化实例配置。
- 不做话题路由：`publish` 只经 `onPublish` 原样交给调用方，`deliver` 的 `simTime` 由调用方提供。
- 不合成多层位图、不读写画布文档：`WidgetLayers` 只给位图与挂载顺序。
- 不自动重建终止后的实例（见「崩溃与重建」）。
- 不枚举包目录，不跟随重定向或符号链接；读取哪些文件完全由清单决定。
