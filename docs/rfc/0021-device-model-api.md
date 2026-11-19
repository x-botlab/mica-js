# 器件模型接口

- Start Date: 2026-11-15
- Reference Issues: —（尚未实现）
- Implementation PR: —（尚未实现）

规定统一器件的模型入口、类型化方法与事件、调用顺序及所有权。模型维护权威仿真状态，展示通过本实例接口交互；本合同中的签名为待实现的作者 API 草案。MUST / MUST NOT 为强制要求，SHOULD 为推荐，MAY 为可选。

修订（2026-11-17）：模型属性按 [RFC 0026](./0026-firmware-properties.md) 接收程序镜像或文件集，DDL 继续接收普通属性。

## 声明

### 公共类型

```ts
import type { TimePs } from '@mica-js/core';
import type { Disposable, Event } from '@mica-js/core/lifecycle';

type Value =
  | null
  | boolean
  | number
  | string
  | Uint8Array
  | readonly Value[]
  | { readonly [key: string]: Value };
type ValueType =
  | { readonly type: 'null' | 'boolean' | 'number' | 'string' | 'binary' }
  | { readonly type: 'array'; readonly items: ValueType }
  | {
      readonly type: 'object';
      readonly properties: Readonly<Record<string, ValueType>>;
      readonly optional?: readonly string[];
      readonly additionalProperties?: ValueType;
    }
  | { readonly ref: string };
interface MethodDefinition {
  readonly params: ValueType;
  readonly returns: ValueType;
}
interface ModelDefinition {
  readonly entry: string;
  readonly types?: Readonly<Record<string, ValueType>>;
  readonly methods?: Readonly<Record<string, MethodDefinition>>;
  readonly events?: Readonly<Record<string, ValueType>>;
}
declare class MethodError extends Error {
  readonly code: string;
  readonly details?: Value;
  constructor(code: string, message: string, details?: Value);
}
```

- 值域对齐 MessagePack 的上述子集；传输合同不要求把每条 RPC 编码成 MessagePack 字节流。
- `number` 是有限 binary64；整数编码只使用安全整数范围，其他数值保持浮点语义。
- 对象使用字符串自有数据键，数组连续，实际值为无环数据；`undefined`、函数、日期和自定义对象均不属于值域。
- 二进制的底层存储为普通 `ArrayBuffer`；字节范围仅包含该 `Uint8Array` 视图覆盖的内容。
- `ModelDefinition` 对应清单的 `model`；`entry` 为模型入口，`types`、`methods`、`events` 缺省为空映射。
- `ref` 指向当前 `model.types`；`optional` 缺省空，列出的键必须存在于所属对象类型的 `properties`。
- 对象未声明 `additionalProperties` 时拒绝未知键；声明后按对应类型校验其他键。
- 每个方法接收一个参数值；无参数与无结果分别使用 `null`，具名参数使用对象类型。
- 方法的业务语义由器件作者约定，框架按同一调用规则执行。
- 接口定义是类型的唯一来源，SDK 按 [RFC 0027](./0027-device-type-generation.md) 生成模型、场景展示和 HTML 的 TypeScript 投影并校验实现。

### 电气资源与引脚

- 模型入口导出合法 `DeviceIR`，可由 DDL 或 Builder 生成；引脚、阈值、初始电阻支路及运行中意图遵循现行[电气合同](../spec/electrical.rst)。
- 模型 IR 的引脚声明名称与清单 `pins` 的键 MUST 完全一致；几何和文档通过同一名称定位引脚，`label` 与封装脚号只用于显示。
- 器件通过自身普通引脚接入供电与地；多电源域、供电检测和输出驱动由模型使用这些引脚的采样与电阻意图表达。
- 器件内部导通使用有限电阻支路，电阻范围为 `0.001` 至 `1_000_000_000` Ω；这是导通电阻近似，理想等电位连接由外部装配网络表达。
- 断开通过移除相应支路表达；`pin.intent <- []` 只移除该引脚贡献的支路，有限大电阻仍是有效连接。
- 意图写入完整替换该引脚的当前贡献；动态触点更新后，固定支路仍须由模型保留，初始意图不会自动作为永久支路叠加。
- 按钮等交互通过方法提交输入通道，再由模型更新电气意图；展示状态及文档中的导线保持各自的职责。

### 生命周期与实例接口

下列 `CoreContext`、`Batch` 分别表示现行核心上下文和输出批次，模型 IR 使用 `DeviceIR`，`P` 为清单生成的完整属性值类型；上下文继续提供输入通道、内存和 JIT 能力。统一上下文提供完整属性快照与事件出口，旧通信桥不进入该投影。

```ts
type Methods = Readonly<Record<string, (params: never) => Value>>;
type Params<F> = F extends (params: infer P) => Value ? P : never;
type Result<F> = F extends (params: never) => infer R ? R : never;
type AsyncMethods<M extends Methods> = {
  readonly [K in keyof M]: (params: Params<M[K]>) => Promise<Result<M[K]>>;
};
interface ModelEventEmitter<T> {
  fire(value: T): void;
  fireTransferred(value: T, buffers: readonly ArrayBuffer[]): void;
}
type ModelEvents<E extends Readonly<Record<string, Value>>> = {
  readonly [K in keyof E]: ModelEventEmitter<E[K]>;
};
type ModelContext<C, P extends object, E extends Readonly<Record<string, Value>>> = Omit<
  C,
  'props' | 'topics'
> & {
  readonly props: Readonly<P>;
  readonly events: ModelEvents<E>;
};
interface ModelInstance<M extends Methods, B> extends Disposable {
  readonly methods: M;
  sync(batch: B): void;
}
interface ModelModule<
  IR,
  C,
  P extends object,
  E extends Readonly<Record<string, Value>>,
  M extends Methods,
  B,
> {
  readonly model: IR;
  create(context: ModelContext<C, P, E>): ModelInstance<M, B>;
}
interface ModelEvent<T> {
  readonly value: T;
  readonly simTime: TimePs;
  readonly sequence: number;
}
type EventListeners<E> = {
  readonly [K in keyof E]: Event<ModelEvent<E[K]>>;
};
interface ModelClient<M extends Methods, E extends Readonly<Record<string, Value>>> {
  readonly methods: AsyncMethods<M>;
  readonly events: EventListeners<E>;
}
```

- 清单 `model.entry` 指定的模块具名导出 `model` 和同步 `create`，共同符合 `ModelModule`；DDL 编译产物和适配器交付在同一入口。
- 工厂 `props` 是清单属性的独立只读初值，核心只消费模型 IR 声明且类型兼容的普通属性；`program` 按 [RFC 0026](./0026-firmware-properties.md) 的 `loader` 提供 `MemoryProgram` 或 `ProgramFiles`，在模型侧仅由 JS 工厂消费，IR 禁止同名属性；模型用输入通道提交交互，用 `sync` 消费按仿真时间有序的 DDL 输出。
- 实例方法集合 MUST 与清单 `model.methods` 完全一致；事件由上下文按 `model.events` 声明的出口产生。
- 模型使用 `ctx.events.onDidXxx.fire(value)` 发出对应载荷；事件出口由宿主创建，仅提供发出接口，事件派发复用核心 `Emitter` 机制。
- 工厂返回后方法集合固定，拒绝动态增删和访问器形式的方法入口。
- 作者侧只见类型化异步方法和 `onDidXxx` 事件；订阅返回 Disposable。
- 订阅复用核心 `Event<ModelEvent<T>>`，载荷、时间与顺序放入同一个只读事件参数，并保留 `thisArgs` 与 Disposable 集合参数的既有订阅语义。
- 模型上下文 MUST NOT 暴露界面身份、连接数量或断开回调。

## 运行时

### 方法与事件顺序

- 模型工厂、方法、`sync` 和 `dispose` 同步执行；返回 thenable 是实现错误。
- 模型输入与事件只能在获准的初始化、方法、同步和核心执行阶段提交；墙钟计时器或异步资源回调不得驱动模型变化。
- 方法在模型安全边界串行执行；安全边界位于模型初始化完成后、连续仿真推进之间或暂停状态。
- 按已接受请求的顺序调用；同边界多个请求按宿主分配的顺序处理，顺序与回放记录一致。
- 方法返回表示处理完成或输入提交成功；电气求解结果由后续推进、事件或查询取得。
- 暂停期间允许方法执行，方法调用本身保持仿真时间不变。
- `sync` 收到的通道输出按各通道既有顺序消费；跨通道业务排序由适配器显式决定。
- 每次 `fire` 或 `fireTransferred` 分配该模型实例生命周期内严格递增的安全整数 `sequence`；新模型独立计数，`simTime` 是产生事件时的整数皮秒。
- 事件仅投递给当时已激活的监听者；逐条保持产生顺序，无历史重放和通用最新值缓存。
- 同一接收方的事件回调按序开始调用；异步回调的完成顺序由接收方管理，回调返回的 Promise 不阻塞后续事件派发或仿真推进。
- 回调同步抛错或返回的 Promise 拒绝时，宿主明确报告界面故障，停止向该界面交付输入并移除监听。
- 一个界面的取消订阅只影响自身；接收方异常不允许把后续缺失数据呈现为正常交付。

### 先监听、再查询

- 需要当前状态的界面先注册相关事件，再调用器件提供的状态查询方法。
- 同一 `ModelClient` 的订阅注册、取消和方法请求按提交顺序在模型侧生效；同步返回 Disposable 的注册操作 MUST 先于随后提交的查询生效。
- 桥接全过程保持同一实例方法响应与事件的模型产生顺序；对于同步状态处理，查询 Promise 的等待方先应用结果，随后才执行查询之后产生的事件回调。
- 完整状态查询覆盖查询前的变化；对应事件直接更新当前状态。两处状态应用采用同步处理，跨 `await` 的状态写入由业务保证顺序。
- 事件回调等待模型方法时，方法响应独立处理，不等待该回调完成。
- 历史记录查询与实时事件可能包含重叠数据；串口等增量业务由模型声明记录游标，界面据此去重和衔接。
- 查询失败明确拒绝该调用，已建立的监听保持有效；界面可释放监听并报告初始化失败。
- 取消订阅后停止该监听的后续派发；已经开始的异步业务由接收方清理。
- 常规方法不得反向等待展示；HTML 资源加载与绘制不占据模型安全边界。

### 业务数据组织

- 器件作者决定事件粒度、通知频率与批量载荷，按业务选择状态事件、批量事件或方法查询。
- 串口记录、采样等连续数据由模型维护业务缓冲，器件接口说明容量、溢出语义、读取方式和记录游标；界面按需分批读取。
- 事件派发与仿真推进相互独立；局部业务队列和异步处理由器件展示或 HTML 视图管理。

### 所有权与错误

- 普通参数、结果和事件在提交时捕获独立快照；调用方之后修改原对象不影响接收结果。
- `fireTransferred` 的缓冲必须唯一，且被载荷中的某个 `Uint8Array` 完整覆盖；成功提交即经既有 transfer hooks 交出所有权，接收方之间仍保持隔离。
- 多接收方所需复制由宿主承担；零接收方不积攒消息，显式交出的缓冲仍视为失去所有权。
- 工厂初值、模型缓存和查询结果之间 MUST 隔离可变别名。
- 业务拒绝使用带 `code`、`message` 和可选 `details: Value` 的 `MethodError`；宿主保留结构并拒绝对应调用。
- 参数校验失败在处理函数执行前拒绝；超时或失联不证明操作未执行，调用方 MUST NOT 自动重试。
- 普通抛错、返回类型非法和模型钩子异常均属于模型故障，由运行会话停止推进。
- 关闭、复位及失效模型代理的请求拒绝规则见 [RFC 0025](./0025-fused-runtime.md)。

## 校验

| 诊断码                                        | 条件                                   |
| --------------------------------------------- | -------------------------------------- |
| `model/invalid-interface`                     | 类型引用、声明、导出形状或引脚集合非法 |
| `model/invalid-params`                        | 参数不匹配，处理函数未执行             |
| `model/unknown-method`、`model/unknown-event` | 引用未声明成员                         |
| `model/invalid-result`、`model/invalid-event` | 实现产生非法载荷                       |
| `model/async-handler`                         | 同步处理函数返回 thenable              |
| `model/invalid-phase`                         | 在获准执行阶段之外提交模型输入或事件   |
| `model/execution-failed`                      | 模型或适配器出现未分类异常             |
| `model/call-timeout`、`model/disconnected`    | 超时、代理失效或失联，执行结果可能未知 |

## 示例

四脚按钮的模型与清单使用 `a1`、`a2`、`b1`、`b2` 四个引脚名。一种合法实现由 `a2` 向 `a1`、`b2` 向 `b1` 分别贡献固定 `0.001` Ω 支路；按下时 `a1` 向 `b1` 贡献 `1` Ω 支路，松开时将 `a1` 的意图设为 `[]`。固定支路由其他引脚贡献，松开不会移除它们；这些数值为模型示例，不是框架默认值。

适配器示例使用生成上下文的 `brightness` 输出通道；编译产物另外具名导出 `model`。

```js
export function create(ctx) {
  let brightness = 0;
  return {
    methods: { getBrightness: () => brightness },
    sync(batch) {
      for (const message of batch.outputs.brightness) {
        brightness = message.value;
        ctx.events.onDidBrightnessChange.fire(brightness);
      }
    },
    dispose() {},
  };
}
```

以下为清单 `model` 对象的完整示例，完整包结构见 [RFC 0020](./0020-unified-device-package.md)。

```json
{
  "entry": "model.js",
  "types": { "Brightness": { "type": "number" } },
  "methods": {
    "getBrightness": {
      "params": { "type": "null" },
      "returns": { "ref": "Brightness" }
    }
  },
  "events": { "onDidBrightnessChange": { "ref": "Brightness" } }
}
```

## 范围

- 包入口与属性由 [RFC 0020](./0020-unified-device-package.md) 规定。
- 会话推进、生命周期和故障由 [RFC 0025](./0025-fused-runtime.md) 规定。
- SDK 类型准备、固定类型名与生成配置由 [RFC 0027](./0027-device-type-generation.md) 规定。

## 关联

- [RFC 0001](./0001-virtual-time.md)：仿真时间单位。
- [RFC 0015](./0015-widget-js-api.md)、[RFC 0017](./0017-device-topic-delivery.md)：既有分离组件合同；统一器件使用本文的实例内接口。
