# 画布运行时

- Start Date: 2026-10-25
- Reference Issues: —（设计讨论，无对应 issue）
- Implementation PR: —（尚未实现）

规定 `.cnv` 画布在浏览器里的装配与执行：`WidgetHost` 的职责与选项、线程划分、帧与步的关系、外部资源的寻址。话题的投递语义见[器件话题投递](./0017-device-topic-delivery.md)。

## 声明

### 宿主职责

`WidgetHost` 是唯一的装配点：画布文档、原理图、器件、widget 与资源都从它进来，上层不直接接触仿真运行时，也不知道实例在哪个线程里绘制。

### 选项

| 选项             | 类型             | 作用                                       |
| ---------------- | ---------------- | ------------------------------------------ |
| `widgetProvider` | `WidgetProvider` | widget 定义与实现                          |
| `deviceHost`     | `DeviceSimHost`  | 已构建的仿真宿主；必需                     |
| `fs`             | `HostFs`         | 读取外部内容的唯一出口                     |
| `dpr`            | `number`         | 图层像素比，默认 1                         |
| `onDiagnostic`   | 回调             | 不中断调用的故障上报                       |
| `onPublish`      | 回调             | 未绑定端口的 widget 发布，交给宿主自行处理 |

前三项必需，其余可选。

`deviceHost` 由装配层用 `deviceProvider` 与 `fs` 构建后传入，`WidgetHost` 不负责创建仿真运行时：

```ts
const deviceHost = await createDeviceSimHost({ deviceProvider, fs });
const host = createWidgetHost({ widgetProvider, deviceHost, fs });
await host.loadDocument(uri);
```

`fs` 出现两次是因为两侧各需读取自己那部分内容（宿主读画布文档与 widget 资源，运行时读原理图与器件属性资源），但它是同一个对象。

### 仿真宿主

`DeviceSimHost` 是可跨线程的接口：全部方法返回 Promise，即使实现与调用方同线程也一样。因此 `WidgetHost` 与仿真可以分处不同线程，调用方不需要为两种部署写两套代码。

| 方法                       | 作用                                        |
| -------------------------- | ------------------------------------------- |
| `loadSchematic(uri)`       | 读取并装入原理图；`URI` 或 `undefined` 清空 |
| `advance(dt)`              | 推进一个固定步，返回报告                    |
| `deliver(target, payload)` | 向器件端点投递一条消息                      |
| `onPublish(listener)`      | 订阅器件发布；注册本身是本地操作            |
| `getTopics()`              | 端点清单                                    |
| `getSimTime()`             | 当前仿真时间                                |
| `getSchematic()`           | 当前原理图                                  |
| `dispose()`                | 释放运行时                                  |

仿真宿主不暴露引脚与拓扑对象：电气解网是运行时的内部实现，跨线程时也不可作为接口出现。

### 文档装入

```ts
loadDocument(uri: URI): Promise<void>;
applyCommand(command: CanvasCommand): void;
reset(): Promise<void>;
```

`loadDocument` 接收 `.cnv` 的 URI；宿主自己读取并解析画布文档，并把其中的原理图引用解析成绝对 URI 后交给仿真运行时。URI 的形态由宿主决定，规范只要求它可被 `fs.read` 读取。

顺序固定为：

1. 经 `fs.read` 取得 `.cnv` 字节并解析为文档；
2. `schematic` 为空时清空运行时，非空时按文档 URI 解析成绝对 URI 并调用 `loadSchematic(uri)`；
3. 运行时读取并解析该原理图，同时把每个 symbol 的 `image` / `binary` 属性解析成字节，基准是该原理图自己的 URI；
4. 解析每个实例的 widget 定义与属性资源，基准是画布文档的 URI；
5. 校验绑定的方向与载荷类型；
6. 挂载实例。

器件属性资源在第 3 步完成，因此实例创建时工厂读到的属性值已是可以直接使用的字节，而不是待解析的引用。widget 属性资源在第 4 步完成，同样在实例挂载之前。

端点的两个来源都在宿主内部：widget 侧来自 `widgetProvider` 解析出的定义，器件侧来自 `deviceHost.getTopics()`。宿主不额外接受端点目录。

`applyCommand` 在已装入的快照上增量修改，不回读文件；`reset` 重新执行一次当前的 `loadDocument`。

### 资源

外部内容一律以 URI 表达，URI 类型取自 `vscode-uri`：scheme、authority、path 是独立字段，非标准 scheme 不必迁就 `URL` 的归一化规则。

```ts
import type { URI } from 'vscode-uri';

interface HostFs {
  read(uri: URI): Promise<Uint8Array>;
}

interface HostFsError extends Error {
  readonly code: 'not-found' | 'out-of-root' | 'too-large' | 'undecodable';
  readonly uri: URI;
}
```

四条约束：

- **只接受绝对 URI**。相对引用的解析是调用方的事，`fs` 永远拿到完整地址，因此不需要知道文档在哪。
- **只返回字节**。文本解码、JSON 解析与 base64 由调用方完成，接口只负责搬运。
- **没有可选参数**。读取上限由实现按自身策略执行，调用方在拿到字节后按属性声明校验大小与像素。
- **失败必须带错误码**。码不带命名空间前缀，跨线程时按码重建。

| 情形                 | `code`        |
| -------------------- | ------------- |
| 资源不存在           | `not-found`   |
| scheme 未实现或越权  | `out-of-root` |
| 超过实现的上限       | `too-large`   |
| `data:` 内容无法解码 | `undecodable` |

规范只固定一条 scheme 规则：**`data:` URI 由宿主本地解码，不经过 `fs`**。它自包含、没有 I/O 语义，但仍受与其他资源相同的大小与像素上限约束。其余 scheme 全部由宿主决定：支持哪些、如何映射到存储、如何授权、如何拒绝，规范不设内置清单，也不要求任何具体名称。

两项规则由共享辅助函数承担，避免两侧各写一遍：

```ts
resolveUri(reference: string, baseUri: URI): URI;
readResource(fs: HostFs, uri: URI): Promise<Uint8Array>;
```

`resolveUri` 按引用形态分三种，全部基于 `vscode-uri` 的 `Utils`：

```ts
import { URI, Utils } from 'vscode-uri';

function resolveUri(reference: string, baseUri: URI): URI {
  const absolute = URI.parse(reference);
  if (absolute.scheme !== '') return absolute; // 已带 scheme：原样使用
  if (reference.startsWith('/')) {
    return baseUri.with({ path: reference, query: '', fragment: '' }); // 工程根绝对路径
  }
  return Utils.joinPath(Utils.dirname(baseUri), reference); // 相对文档
}
```

不要用 `Utils.resolvePath` 解析文档相对引用：它把基准路径当成目录，`resolvePath('/boards/panel.cnv', 'art/x.png')` 会得到 `/boards/panel.cnv/art/x.png`。`joinPath(dirname(base), ref)` 才等价于「相对文档」。

`Utils.extname` 用于校验文档扩展名（`.cnv`、`.sch`），`Utils.basename` 用于诊断信息。相对引用的解析属于 URI 语义而非 scheme 策略：结果保留基准 URI 的 scheme 与 authority，所以「相对路径」的含义由宿主选择的寻址形态自然给出。基准 URI 有 authority 但没有路径时，相对引用会挂到 authority 之下，宿主应要求基准路径非空。

`readResource` 对 `data:` 本地解码，其余交给 `fs.read`。

所有接受 URI 的接口都使用 `vscode-uri` 的 `URI` 类型，调用方用 `URI.parse` 构造一次即可；接口内部不再接受字符串形式，也不重复解析。文档内的相对引用本身是字符串，由 `resolveUri` 接到基准 URI 上。

`fs` 不提供目录枚举，也不提供写入；包根与文档根由调用方显式给出。缓存与并发顺序由实现决定，规范不作要求。

资源引用若为带 `mode` 的旧式对象，按以下规则归一后不再区分来源：`file` 视为相对 URI，`inline` 视为 `data:` URI，`store` 视为宿主自有的 URI 形态。归一规则只影响读入，不改变文档中已有的字段。

## 运行时

### 线程划分

| 线程   | 内容                                                    |
| ------ | ------------------------------------------------------- |
| 主线程 | 画布编辑器：图层合成、交互与属性面板                    |
| 沙箱   | `WidgetHost`、widget 实例、仿真运行时，三者同处一个线程 |

widget 实例加载第三方代码，因此与 `WidgetHost`、仿真一并在沙箱内运行；沙箱把它与主线程隔开。三者之间没有消息通道，投递、`tick` 与钩子调用都是同线程的同步调用。

沙箱同时承载可信的宿主代码与不可信的实例代码，因此沙箱本身必须按不可信内容对待：它拿不到真实页面的 DOM、存储与凭据。

### 帧与步

主线程持有帧时钟，每帧向沙箱发出一次推进信号并附带墙钟间隔；沙箱按累积时长执行若干步，再回传发生变化的图层位图。

```ts
tick(dt: TimePs): Promise<void>;
```

`tick` 只接收步长；当前仿真时间由宿主从仿真宿主读取，因此调用方不传时刻，也不会出现两个时间来源不一致的情况。返回 Promise 是因为 `advance` 可能跨线程。

- 一帧可以覆盖零个、一个或多个步，取决于累积时长与固定步长；
- 沙箱限制单帧最多补算的步数，长时间暂停后丢弃积压而不追赶；
- 渲染每帧一次，与步数无关；`tick` 每步一次。

固定步长与步内顺序见[器件话题投递](./0017-device-topic-delivery.md)。

### 跨线程输入

指针、键盘、文本输入与文档命令与推进信号走同一条通道，在步首统一分发，因此一条输入落在第几步与消息到达时刻无关。

文本输入与原生选择需要 DOM，由主线程代理并通过同一条通道回传。

### 共享地址空间

同一线程内，实例与仿真共享地址空间：沙箱限制第三方代码可用的能力，但不提供内存或 CPU 隔离。实例卡住会同时阻塞该沙箱内的仿真，恢复方式是重建沙箱。

## 校验

| 对象     | 规则                                                                                    |
| -------- | --------------------------------------------------------------------------------------- |
| 资源引用 | `data:` 本地解码；其他 scheme 由宿主决定；相对引用按 URL 语义解析并保留 scheme 与授权段 |
| 资源读取 | 越出授权范围返回 `out-of-root`，超限返回 `too-large`，缺失返回 `not-found`              |
| 文档装入 | `.cnv` 或其引用的原理图读取、解析失败时拒绝本次 `loadDocument`，文档与实例均不变        |
| 绑定校验 | 方向必须 `output → input`，两侧载荷类型必须相同；不可赋值按 `topic/type-mismatch` 报告  |
| 端点缺失 | 目标符号或端口不存在时报告诊断，不挂载该实例                                            |
| 帧间隔   | 单帧补算步数超过上限时按上限执行，并丢弃多余积压                                        |

## 关联

- [RFC 0001](./0001-virtual-time.md)：墙钟间隔到固定步长的换算口径。
- [RFC 0009](./0009-device-properties.md)：属性中的资源引用。
- [RFC 0010](./0010-topic-ports.md)：绑定方向与载荷类型。
- [RFC 0013](./0013-canvas-format.md)：`.cnv` 的实例、绑定与 `schematic` 引用。
- [RFC 0014](./0014-widget-definition.md)：widget 的端口声明。
- [RFC 0015](./0015-widget-js-api.md)：Widget 的上下文接口、`tick` 与文本输入。
- [RFC 0017](./0017-device-topic-delivery.md)：固定步长、步内顺序与话题投递。
