# 画布运行时

- Start Date: 2026-10-25
- Reference Issues: —（设计讨论，无对应 issue）
- Implementation PR: —（尚未实现）

规定 `.cnv` 画布在浏览器里的装配与执行：`WidgetHost` 的职责与选项、线程划分、帧与步的关系、外部资源的寻址。话题的投递语义见[器件话题投递](./0017-device-topic-delivery.md)。

## 声明

### 宿主职责

`WidgetHost` 是唯一的装配点：画布文档、原理图、器件、widget 与资源都从它进来，上层不直接接触仿真运行时，也不知道实例在哪个线程里绘制。

### 选项

| 选项           | 类型                   | 作用                                       |
| -------------- | ---------------------- | ------------------------------------------ |
| `provider`     | `WidgetProvider`       | widget 定义与实现                          |
| `devices`      | `IDeviceProvider`      | 器件描述与实现；宿主据此构建仿真运行时     |
| `files`        | `WidgetHostFiles`      | 读取外部内容的唯一出口，见「资源」         |
| `host`         | `DeviceSimHostFactory` | 引脚的电气接线与拓扑（可选）               |
| `sandbox`      | `WidgetSandboxFactory` | 实例的隔离实现（可选）                     |
| `dpr`          | `number`               | 图层像素比                                 |
| `onDiagnostic` | 回调                   | 不中断调用的故障上报                       |
| `onPublish`    | 回调                   | 未绑定端口的 widget 发布，交给宿主自行处理 |

仿真运行时由宿主按 `devices` 与 `host` 构建，调用方不传入运行时实例。

### 文档装入

```ts
loadDocument(uri: string): Promise<void>;
applyCommand(command: CanvasCommand): void;
reset(): Promise<void>;
```

`loadDocument` 接收 `.cnv` 的 URI，宿主自己读取并解析；该 URI 同时是文档内所有相对引用的基准。

顺序固定为：

1. 经 `files.read` 取得 `.cnv` 字节并解析为文档；
2. `schematic` 非空时按文档 URI 解析成绝对 URI，经 `files.read` 取得字节并解析为原理图；
3. 装入仿真运行时；为空时装入空图纸；
4. 解析每个实例的 widget 定义与属性资源；
5. 校验绑定的方向与载荷类型；
6. 挂载实例。

端点的两个来源都在宿主内部：widget 侧来自 `provider` 解析出的定义，器件侧来自运行时已有的端点清单。宿主不额外接受端点目录。

`applyCommand` 在已装入的快照上增量修改，不回读文件；`reset` 重新执行一次当前的 `loadDocument`。

### 资源

外部内容一律以 URI 表达，读取只有一个出口：

```ts
interface WidgetHostFiles {
  read(uri: string): Promise<Uint8Array>;
}
```

| 引用形态          | 处理                                   |
| ----------------- | -------------------------------------- |
| 相对或绝对 URI    | 按文档 URI 解析后 `files.read`         |
| `data:` URI       | 宿主本地解码，不经过 `files`           |
| 宿主自定义 scheme | `files.read`，由该 scheme 的提供方解释 |

`data:` 自包含，没有 I/O 语义，因此不进读取通道；它仍受与其他资源相同的大小与像素上限约束。

资源引用若为带 `mode` 的旧式对象，按以下规则归一后不再区分来源：`file` 视为相对 URI，`inline` 视为 `data:` URI，`store` 视为宿主自定义 scheme。归一规则只影响读入，不改变文档中已有的字段。

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

| 对象     | 规则                                                                                     |
| -------- | ---------------------------------------------------------------------------------------- |
| 资源引用 | 相对 URI 按文档 URI 解析；`data:` 本地解码；其余经 `files.read`                          |
| 资源上限 | 越出工程根返回 `asset/out-of-root`，超限返回 `asset/too-large`，缺失返回 `asset/missing` |
| 文档装入 | `.cnv` 或其引用的原理图读取、解析失败时拒绝本次 `loadDocument`，文档与实例均不变         |
| 绑定校验 | 方向必须 `output → input`，两侧载荷类型必须相同；不可赋值按 `topic/type-mismatch` 报告   |
| 端点缺失 | 目标符号或端口不存在时报告诊断，不挂载该实例                                             |
| 帧间隔   | 单帧补算步数超过上限时按上限执行，并丢弃多余积压                                         |

## 关联

- [RFC 0001](./0001-virtual-time.md)：墙钟间隔到固定步长的换算口径。
- [RFC 0009](./0009-device-properties.md)：属性中的资源引用。
- [RFC 0010](./0010-topic-ports.md)：绑定方向与载荷类型。
- [RFC 0013](./0013-canvas-format.md)：`.cnv` 的实例、绑定与 `schematic` 引用。
- [RFC 0014](./0014-widget-definition.md)：widget 的端口声明。
- [RFC 0015](./0015-widget-js-api.md)：Widget 的上下文接口、`tick` 与文本输入。
- [RFC 0017](./0017-device-topic-delivery.md)：固定步长、步内顺序与话题投递。
