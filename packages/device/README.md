# @mica-js/device

器件层入口：解析已加载的器件描述、通过宿主 `IDeviceProvider` 加载同步 JS 工厂，并为每个实例提供独立、递归只读的属性快照、工厂上下文与内核驱动的生命周期。

本包负责**描述对象解析、#10 端口校验、#7 属性默认值/值校验、#12 引脚与固定组声明、#25 数字引脚 I/O 与数字边沿观察、JS 工厂导出形式校验、属性快照、实例级 `api.ir` / `api.props` 上下文、initialize/reset/onDispose 生命周期、#54 的话题与 IR 输出消息桥接，以及 #57 的连接作者接口与拓扑接入**。不负责文件定位、文件读取、缺失文件诊断或 JSON 语法解析；这些由宿主 `IDeviceProvider` 实现。模拟观察、状态观察、电压/get/set 与组观察不在当前作者面。

## 安装

```bash
pnpm add @mica-js/device
```

## 公共入口

唯一公开入口为 `@mica-js/device`，构建生成 `dist/index.js`（ESM）与声明文件。

| 导出                                                               | 作用                                                          |
| ------------------------------------------------------------------ | ------------------------------------------------------------- |
| `parseDeviceDescription()`                                         | 解析已加载的定义对象与 metadata，返回 `DeviceDescription`     |
| `loadDeviceModule()`                                               | 通过 `IDeviceProvider` 取得定义与 JS 代码，加载并校验默认导出 |
| `resolveDeviceProperties()`                                        | 按描述默认值与实例覆盖值生成独立、递归冻结的属性快照          |
| `createDeviceInstance()`                                           | 调用一次工厂、校验绑定与 IR、安装实例并入队 initialize        |
| `DeviceError`                                                      | 带 `code`、`deviceId`、`pointer` 的设备层错误                 |
| `BackpressureError`                                                | 有界队列/槽位不足的预期拒绝，带 `operation`                   |
| `TopicPayload` / `TopicMetadata` / `IROutputMetadata` 等类型       | 话题载荷、投递元数据与 IR 输出元数据                          |
| `IDeviceProvider`                                                  | 宿主实现：`resolve(deviceId)` 返回定义对象与 JS 代码          |
| `DeviceAPI` / `DeviceBindings` / `DeviceFactory`                   | 工厂上下文与平铺生命周期绑定                                  |
| `DeviceInstance` / `DeviceInstanceOptions` / `DeviceInstanceState` | 宿主实例句柄、pin host 注入与状态                             |
| `DevicePinHost`                                                    | 消费 #51 引脚意图、采样与数字变化观察                         |
| `PinRef` / `PinConfig` / `PinOperations`                           | 引脚静态引用、配置与 `b.pin` 建图类型                         |
| `ObserverRef` / `ObserveConfig` / `ObserveOperations`              | 观察静态引用、配置与 `b.observe` 建图类型                     |
| `ObserveDigitalDescriptor` / `CapturedPinTypes`                    | `api.ir.observeDigital` 的触发/捕获/目标签名类型              |
| `DeviceDescription` 等类型                                         | 描述、端口、引脚、连接、工厂与加载结果                        |
| `DeviceConnectionDescriptor` / `DeviceConnectionOptions`           | 连接声明与实例的 topology 绑定                                |
| `ConnectionRef` / `ConnectionOperations`                           | `api.ir.connection` 的静态句柄与 `b.connection` 操作组        |

不导出文件路径 helper、文件缺失错误码、JSON 语法错误码或属性更新接口。

## Provider 合同

```ts
import type { DeviceDefinition, IDeviceProvider } from '@mica-js/device';
import { parseDeviceDescription } from '@mica-js/device';

const provider: IDeviceProvider = {
  async resolve(deviceId) {
    // 宿主负责定位/读取/缺失诊断与 JSON.parse。
    const loaded = await loadPackageContent(deviceId);
    return {
      definition: parseDeviceDescription(loaded.json, {
        name: deviceId,
        displayName: loaded.displayName,
        description: loaded.description,
      }),
      code: loaded.jsSource,
    } satisfies DeviceDefinition;
  },
};
```

- `deviceId` 是不透明字符串（例如 `zerobit:stm32f103c8t6`），本包不解析其格式。
- `resolve` 返回 `undefined` 表示器件不存在，`loadDeviceModule` 报 `device/device-unknown`。
- provider 抛出的 `DeviceError` 原样传播；其他异常包装为 `device/provider-failed` 并保留 `cause`。
- `definition` 必须是已经由 `parseDeviceDescription` 解析的 `DeviceDescription`。`loadDeviceModule` 只做运行时形状检查，不二次解析；provider 结果违约报 `device/provider-failed`。
- `code` 是器件实现的 ES 模块源码。provider 应提供自包含模块；相对导入不在本层解析。

## 描述解析

```ts
import { parseDeviceDescription } from '@mica-js/device';

const description = parseDeviceDescription(
  {
    properties: {
      label: { type: 'string', default: 'Display' },
      speed: { type: 'number', default: 72, min: 1, max: 170, unit: 'MHz' },
    },
    ports: {
      frame: { direction: 'output', type: 'bytes<rgb565>' },
    },
    pins: {
      VDD: { kind: 'power', side: 'top' },
      GND: { kind: 'gnd', side: 'bottom' },
      A: { kind: 'signal' },
      B: { kind: 'signal' },
      OUT: { kind: 'signal', side: 'right' },
      IN: { kind: 'signal', powerDomain: 'io', levels: { low: 0.3, high: 0.7 } },
    },
    pinGroups: { data: { pins: ['OUT', 'IN'] } },
    connections: {
      contact: { pins: ['A', 'B'], initial: 'open' },
    },
    designatorPrefix: 'U',
  },
  { name: 'acme:display', displayName: '显示屏', description: '示例显示器件' },
);
```

- `metadata.name` 必填；`displayName` 缺省回退 `name`；`description` 可选。
- `properties` 复用 `@mica-js/core/schematic` 的 #7 实现；不可用的属性描述被忽略，不猜测类型。
- `ports` 按 #10 校验：方向必须是 `input` / `output`，载荷类型取自 `@mica-js/core/canvas` 的 `PAYLOAD_TYPES`（与画布共用同一份清单），未知字段报 `schema/unknown-field`，未知类型报 `type/unknown`。
- `pins` 按 #12 校验：`kind` 必须是 `power` / `gnd` / `signal`，`side` 缺省 `left`；`powerDomain` 只允许出现在 `signal` 引脚，`levels` 必须与 `powerDomain` 同时出现并满足 `0 <= low < high <= 1`。引脚键与成员名大小写精确、不得为空。
- `pinGroups` 按 #12 校验：成员非空、唯一且必须引用已声明引脚；组本身只保存固定顺序，不做电气推断。
- `connections` 按 #14 校验：键非空；每项是纯对象且只含 `pins` / `initial`；`pins` 必须是两个互异、已在同一描述 `pins` 键声明的引脚 ID；`initial` 取 `open` / `closed`，省略时为 `open`。引脚描述本身（`kind` 等）由 #55 校验，本层只读取引脚键用于连接端点检查。
- `designatorPrefix` 去除首尾空白；空字符串视为未声明。
- 顶层未知字段被忽略；定义对象只接受已解析对象，JSON 文本与语法错误属于 provider。
- 定义、`properties`、`ports`、单端口、引脚、连接与属性覆盖都必须是纯对象；`Map`、`Set`、`Date`、class 实例不会被当作空记录。`Object.create(null)` 与跨 realm 的普通对象仍被接受。

## 属性快照

```ts
import { resolveDeviceProperties } from '@mica-js/device';

const props = resolveDeviceProperties(description, { label: 'LCD' });
// props 已深拷贝并递归冻结；width、嵌套对象、数组均不可写。
```

- 按描述填默认值、校验覆盖值；颜色归一化为大写 `#RRGGBBAA`。
- 未声明的覆盖键静默忽略；无有效默认值且无覆盖时省略该键。
- 每次调用返回独立对象；外部覆盖对象或描述默认对象的后续变更不影响快照。
- 运行期写入冻结树会抛 `TypeError`；本包不提供属性更新、自动重建或 `onPropsChanged`。需要另一组属性时由宿主显式创建新实例。

## 加载与导出校验

```ts
import { loadDeviceModule } from '@mica-js/device';

const loaded = await loadDeviceModule('acme:display', provider);
// loaded.description 为解析后的描述；loaded.factory 尚未被调用。
```

- 浏览器使用 Blob URL、Node 使用 `data:` URL 动态 import 代码字符串。
- **模块身份**：同一 provider 实例内，一个 device id 只加载一次；并发与重复调用返回同一 `LoadedDeviceModule` 和 factory。不同 provider 或不同 device id 独立加载；失败不缓存，下一次调用重试。需要重新加载实现时创建新的 provider 实例。Node 的 data URL 以 provider/device/load 片段区分模块（失败重试使用新的 load），浏览器路径使用同一缓存。
- **浏览器 CSP**：Blob URL 动态 import 要求 `script-src` 允许 `blob:`（例如 `script-src 'self' blob:`）。仅 `script-src 'self'` 时 Chromium 会报 “Failed to fetch dynamically imported module”，本包归为 `device/implementation-import`。D01 不提供受支持的 fallback：宿主必须放行 `blob:`，或在 #59 适配层预导入模块后绕过本包的 code 字符串路径。
- **信任边界**：`loadDeviceModule` 在宿主 realm 中执行 provider 提供的代码，它不是沙箱；#59 沙箱适配落地前，器件包必须可信。
- 默认导出必须是普通同步函数；`async` / async generator 报 `device/implementation-async`；非函数、generator、class 报 `device/implementation-export`；模块语法/求值或 URL 构造失败报 `device/implementation-import`。带注释的 class（如 `class/*x*/ {}`）也会在加载期拒绝；bound class（`(class {}).bind(null)`）无法从源码静态识别，留给 #53 调用期失败。
- **`loadDeviceModule` 不调用工厂**。工厂上下文与生命周期由 `createDeviceInstance` 负责；同步函数返回 Promise 无法在加载期静态识别，在调用期报 `device/factory-async`。
- provider 的缺失文件/IO 异常（例如 `ENOENT`）统一包装为 `device/provider-failed` 并保留 `cause`；本包不新增独立的缺失文件错误码。
- 不提供 WASM 兼容分支或第二个实现加载来源。

## 工厂上下文与实例生命周期

```ts
import { createDeviceInstance, loadDeviceModule } from '@mica-js/device';
import { createScheduler } from '@mica-js/core';

const scheduler = createScheduler();
const loaded = await loadDeviceModule('acme:display', provider);
const instance = createDeviceInstance(loaded, scheduler, {
  instanceId: 'display-1',
  properties: { label: 'LCD' },
  // 声明并使用引脚时必填；PowerRuntime 结构上满足 DevicePinHost。
  // pinHost: powerRuntime,
  // 仅当器件 IR 使用 connection.apply 时需要；topology 必须使用同一 scheduler。
  // connections: { topology },
});

expect(instance.state).toBe('initializing');
scheduler.start(); // 公共控制阶段执行 initialize
expect(instance.state).toBe('ready');
```

工厂与绑定的已确认形态：

```ts
interface DeviceAPI {
  readonly props: DevicePropertySnapshot;
  readonly ir: DeviceIRDeclarations;
  subscribe(port: string, callback: MessageCallback<TopicPayload, TopicMetadata>): Unsubscribe;
  publish(port: string, payload: TopicPayload): void;
  post<P extends readonly ScalarType[]>(entry: EntryRef<P>, args: ScalarArgs<P>): Promise<void>;
  postBytes(
    entry: EntryRef<readonly ['u32', 'u32']>,
    inbox: InboxRef,
    bytes: Uint8Array,
  ): Promise<void>;
  onOutput(output: OutputRef, callback: MessageCallback<unknown, IROutputMetadata>): Unsubscribe;
  onOutput(
    output: BytesOutputRef,
    callback: MessageCallback<Uint8Array, IROutputMetadata>,
  ): Unsubscribe;
  updateBytes(resource: BytesRef, offset: number, bytes: Uint8Array): Promise<void>;
}
interface DeviceBindings {
  readonly initialize?: LifecycleRef<readonly []>;
  readonly reset?: LifecycleRef<readonly []>;
  readonly onDispose?: () => void;
}
type DeviceFactory = (api: DeviceAPI) => DeviceBindings;
```

- 同步工厂每次创建只调用一次。`api.ir` 暴露 `state/array/bytes/inbox/func/entry/lifecycle/provider`、`pin(id)` / `connection(id)` 与本实例的输出声明 `output/outputBytes`；工厂返回**或抛出**后立即封闭，任何后续声明或结构写入报 `device/factory-closed`。工厂不能通过上下文取得原始 `IRModule`、执行器或调度器。`subscribe` / `onOutput` 登记同样只在工厂期间开放。
- `api.ir.provider` 沿用 IR #60 合同：生成回调在首次派发时执行，产物经同一 `validateIR`/解释器校验并在实例内缓存；`dispatch` 作为入口终结指令延续当前预算与虚拟时间。每次派发校验产物依赖，资源版本变化后按需重生成。
- `b.pin` / `b.observe` 通过 `@mica-js/ir` 的 `FunctionBuilder` 模块增强获得类型；运行期由本包为 device 模块注册的 builder extension 提供，普通函数、生命周期与嵌套块共用同一组方法。`b.connection` 由 #57 的装饰路径提供。直接使用裸 `createIRModule()` 的模块不会自动获得这些命名空间。
- `api.props` 是创建时解析默认值后的独立、递归只读快照；运行期不可修改，不提供更新接口、自动重建或 `onPropsChanged`。需要另一组属性时由宿主显式创建新实例。
- 工厂返回值必须是纯对象，只允许 `initialize` / `reset` / `onDispose` 三个字段。生命周期引用必须属于本次工厂声明的模块、类别为 `lifecycle`、零参数；同一引用同时绑定 initialize 与 reset 拒绝。`onDispose` 必须是同步普通函数（拒绝 async/generator/class），运行时还要求返回 `undefined`。
- 工厂返回 Promise/thenable 或默认导出为 async/async generator 报 `device/factory-async`；普通函数抛出、非普通函数或非法返回形状分别报 `device/factory-failed` / `device/lifecycle-binding`。
- `createDeviceInstance` 只有在工厂返回、绑定校验和真实 `validateIR`/链接全部通过后才安装 scheduler 实例并入队 initialize。任何前置失败不留下实例、队列任务或解释器引用，也不执行 initialize。IR 校验/链接失败统一报 `device/link-failed` 并保留 `cause`。引脚初始状态只在链接成功后提交；提交失败会销毁已安装实例并报 `device/pin-io-unavailable`。
- `DeviceInstanceOptions.pinHost` 是 #51 公开能力的窄接口（`pinIntent` / `updatePinStates` / `sampleDigital`，以及可选的 `addDigitalPinObserver`）；`PowerRuntime` 可直接传入。没有引脚指令或观察绑定的器件可以省略；一旦使用引脚指令/观察却缺少 host、host 未声明被引用引脚或不支持变化观察，创建期明确拒绝（`device/pin-io-unavailable` / `device/observe-unavailable`）。
- initialize 只作为公共控制工作入队，由现有 `scheduler.start()` / `step()` 驱动，不在工厂内同步执行。只有 initialize **正常执行完成**后状态才从 `initializing` 变为 `ready`；执行失败进入 `faulted`，不会短暂进入 `ready`。没有 initialize 时创建即 `ready`。
- reset 只入队已绑定的 reset 控制工作：不重新执行 initialize、不取消既有事件、不重建实例。未绑定报 `device/lifecycle-unsupported`；`initializing`、`faulted`、`destroying`、`destroyed` 状态拒绝 reset。faulted 不能通过 reset 隐式恢复。
- 模型故障使 scheduler 进入 `faulted` 并暂停，不自动销毁、不调用 `onDispose`。`destroy()` 在 faulted 状态下仍允许清理实例；scheduler 本身不会被 reset/恢复，`start/step/cancel` 继续按 #48 故障规则拒绝。
- `destroy()` 只允许在 scheduler 非 `running` 的入口边界调用：先停止新输入与执行，再清理事件、队列、实例与内核引用，最后调用一次 `onDispose`。重复调用幂等；销毁期间的重入不会重复清理。`onDispose` 抛错或返回 Promise/非 `undefined` 时报 `device/dispose-failed`，实例仍进入 `destroyed`。
- `instance.storage` 是受控句柄；销毁后 getter 与所有存储访问器都抛 `device/instance-destroyed`，且句柄释放自身对内核存储的引用。
- `instance.state` 为 `initializing | ready | faulted | destroying | destroyed`。messaging 回调的未处理异常同样使实例 `faulted`，后续请求拒绝。

## 话题与 IR 输出桥接（#54）

```ts
type TopicPayload = boolean | number | string | Vec2d | Vec3d | Uint8Array;
type TopicMetadata = Readonly<{ simTime: number }>;
type IROutputMetadata = Readonly<{ timePs: number }>;

interface DeviceMessagingOptions {
  readonly postCapacity?: number; // 默认 64
  readonly publishCapacity?: number; // 默认 64
  readonly deliveryCapacity?: number; // 默认 64
  readonly updateCapacity?: number; // 默认 64
  readonly outputByteBudget?: number; // 默认 65536
}
interface DeviceInstanceOptions {
  readonly instanceId: string;
  readonly properties?: Readonly<Record<string, PropertyValue>>;
  readonly messaging?: DeviceMessagingOptions;
  readonly onTopic?: (message: { readonly port: string; readonly payload: TopicPayload }) => void;
}
interface DeviceInstance {
  deliver(port: string, payload: TopicPayload, meta: TopicMetadata): void;
}
```

- `subscribe` 只接受描述中声明为 `input` 的端口；不同 callback 可注册多个监听器，同一 callback 重复注册同一端口报 `device/topic-subscription`。`publish` 只接受 `output` 端口。未知端口/方向分别报 `device/topic-unknown` / `device/topic-direction`。
- 载荷校验为**表示层**：布尔、有限数值、字符串、固定键的 `vec2d/vec3d`、`Uint8Array`。`bytes<rgb565>` / `bytes<segments>` 的布局校验属于宿主/格式层。字节载荷在捕获时复制，每个监听器收到独立副本。
- `post(entry, args)` 只接受本实例声明的普通 entry；Promise 完成表示**已接纳**，不表示入口已执行。`post` 不推进时间、不创建事件、不形成等待栈。
- `postBytes(entry, inbox, bytes)` 要求 entry 签名 `[u32, u32]`。接纳时预留 inbox 连续范围、复制字节并把 `offset/length` 交给 entry；entry 返回、故障或销毁时释放。零长度消息使用 `offset=0, length=0`，不占字节容量但仍计入消息条数限制。容量不足抛 `BackpressureError`，不覆盖未消费数据。
- `onOutput(output, callback)` 为每个 IR 输出登记唯一消费者，重复绑定报 `device/output-consumer`。回调在入口返回后执行，`meta.timePs` 是 `bridge.send` 捕获时的虚拟时间；标量输出载荷为固定布局列表，字节输出为独立 `Uint8Array`。队列满时 `b.output` / `b.outputBytes` 返回 `false`，失败发送不通知。
- `updateBytes(resource, offset, bytes)` 只对声明为可写 `bytes` 的资源生效；Promise 完成表示内容与受影响单元版本已一并可见。readonly、未声明或越界报 `device/update-target`。
- 宿主用 `instance.deliver(port, payload, { simTime })` 投递输入话题，用 `onTopic` 接收 `api.publish`。`onTopic` 必须是同步、返回 `undefined` 的函数；返回 thenable 或其他值会先消费该 thenable，再以 `device/message-callback` 拒绝。未提供时发布消息在校验后丢弃。初始化期间的输入与 IR 输出暂存于有界队列，initialize 成功后先按捕获顺序通知输出，再按接纳顺序投递输入；入口边界内的回调新产生的输入、发布与更新会在同一边界继续排空，不越过已受理消息。
- 工厂/initialize 完成前调用 `post/postBytes/publish/updateBytes` 报 `device/not-active`；故障/销毁中报 `device/instance-busy`；销毁后报 `device/instance-destroyed`。销毁丢弃未消费的实例内通知，但不撤销已交付给 `onTopic` 的外部效果。
- 不实现重放、ACK/可靠传输、跨实例广播协议；普通消息投递不推进客体时间。

`api.ir` 仍不暴露 `IRModule.functions/memories` 或通用 domain 声明/指令面；观察能力由 #56 扩展。

## 引脚声明与数字 I/O

```ts
import type { DeviceFactory } from '@mica-js/device';

const factory: DeviceFactory = (api) => {
  const out = api.ir.pin('OUT');
  const input = api.ir.pin('IN');
  const last = api.ir.state('last', 'u32', 0);
  const initialize = api.ir.lifecycle('initialize', []);
  initialize.body((b) => {
    b.pin.configure(out, { mode: 'push-pull', outputEnabled: true, pull: 'none' });
    b.pin.writeDigital(out, b.const('bool', true));
    b.state.store(last, b.pin.sampleDigital(input));
    b.return([]);
  });
  return { initialize };
};
```

- `api.ir.pin(id)` 只接受本器件 `pins` 中声明的 id；未知或空 id 报 `device/pin-unknown`。同一 id 重复调用返回同一静态引用，跨实例/跨模块引用在建图时拒绝。引脚静态声明与其他 `api.ir` 声明共享模块命名空间，重复名称按 IR 声明错误拒绝。
- `b.pin.configure(pin, { mode, outputEnabled, pull })` 降低为 `pin.configure`（mode 0/1/2/3，pull 0/1/2）；`b.pin.writeDigital(pin, Value<'bool'>)` 降低为 `pin.write_digital`；`b.pin.sampleDigital(pin)` 降低为 `pin.sample_digital`，结果是规范 `u32`：bit 0 为电平，高位为零，不以 JS `boolean` 代替。
- 只有 `kind: 'signal'` 引脚允许配置、写入与采样；`power` / `gnd` 引脚在 builder 与链接校验两处拒绝。本批不定义逐引脚 direction，也不实现只读/只写方向约束。
- 链接期为被引用的引脚提交 #12 初始状态（`high-z`、未使能、`none`、无数字/电压意图），保留宿主 `ElectricalPinInput.model` 与无域引脚的 `powerReady`；宿主未声明该引脚或未提供 pin host 时报 `device/pin-io-unavailable`。
- 写入与配置保存器件侧持有意图，并在操作点通过 `DevicePinHost.updatePinStates` 提交完整引脚状态；电气结果在下一 topology/power 控制阶段（同一虚拟时刻）生效。同一入口内后续 `sampleDigital` 读取上一已提交解析结果，不承诺同入口写后可见。
- `sampleDigital` 通过宿主 #51 采样读取已解释电平；域关闭、上电未完成或欠压期间返回 0，恢复后由 #51 重新施加最后持有意图。本层不复制阈值、迟滞、门控、浮空或域状态机。
- 驱动冲突由 `ElectricalConflictError` 沿 #49/#51 路径上抛并使 scheduler 进入 `faulted`；本层不新增冲突码、仲裁或部分提交。
- 销毁时按链接期捕获的宿主意图尽力恢复被引用引脚，避免已销毁实例继续驱动电路。
- #25 的电压写入/采样、`set_*` / `get_*`、引脚组 `port.*` I/O 与观察控制不在引脚 I/O 作者面；观察由下一节单独提供，其余能力不会被静默降级为空操作。

## 数字边沿观察与捕获投递（#56）

```ts
const trigger = api.ir.pin('IN');
const capture = api.ir.pin('CAP');

const onEdge = api.ir.entry('onEdge', ['u8', 'u32']);
onEdge.body((b, [edge, level]) => {
  b.state.store(lastEdge, edge);
  b.state.store(lastLevel, level);
  b.return([]);
});

const observer = api.ir.observeDigital('edge', {
  trigger,
  captures: [capture],
  target: onEdge,
});

const initialize = api.ir.lifecycle('initialize', []);
initialize.body((b) => {
  b.observe.configure(observer, { enabled: true, edges: 'both' });
  b.return([]);
});
```

- `api.ir.observeDigital(name, { trigger, captures, target })` 只接受本器件已声明的 `signal` 引脚；`captures` 可为空并按声明顺序形成 `u32` 载荷。目标必须是普通 entry，链接期要求其签名恰为 `['u8', ...u32 × captures.length]`；错误签名、目标类别或重复观察名报 `device/observe-binding`，未知/跨实例/非 signal 引脚报 `device/observe-pin`。观察名与其他 `api.ir` 声明共享模块命名空间。
- `b.observe.configure(observer, { enabled, edges })` 降低为 `observe.configure`：静态观察绑定、`bool` 字面量启用位、`u8` 边沿编码（1 rising / 2 falling / 3 both）；结果为空。非法绑定、非 bool 启用位或非 1/2/3 边沿报 `device/observe-config`。
- 载荷固定为 `[u8 边沿编码, ...按 captures 声明顺序的 u32]`。边沿编码只描述本次匹配的 rising/falling，不把 `both` 写入载荷；数字捕获读取同一解析阶段的 #51 采样结果，gated capture 按采样规则得到 0。触发时复制数值入队，执行入口时不再重新采样。
- 初始禁用；每次显式 `configure` 都在提交点重建基线并原子更新启用/边沿，即使参数相同。首次启用、门控/待定区间恢复、浮空进出与显式配置都只重建基线，不投递边沿；只有相邻确定 `sampled` 电平的 `0→1` / `1→0` 才可能投递，未选中的确定跃迁仍更新基线。不新增 baseline 包装字段。
- 观察依赖 #51 的解析阶段数字变化通知；`DevicePinHost.addDigitalPinObserver` 缺失时报 `device/observe-unavailable`。同一解析阶段的变化按观察声明顺序入队，走 `scheduler.enqueueMessage` 的 #54 普通入口队列：不推进时间、不形成等待栈、不同步重入器件或其他实例。
- 观察绑定与 `pinHost` 应共享同一 scheduler 与虚拟时间基准，才能保证解析阶段与普通入口阶段按本文顺序衔接。跨 scheduler 注入 `pinHost` 的跨阶段顺序不在本批合同内；宿主若这样组合，需自行保证两个 scheduler 的驱动顺序，本层不额外推演或重排。
- 关闭观察不撤销已入队消息，也不补发关闭期间的跃迁；销毁时取消订阅并丢弃实例内待执行入口，已捕获载荷保持原内容。
- 仅实现数字边沿观察。`edges=0` 状态观察、模拟量/电压观察、`get_*`/`set_*`、组观察与任意比较器均明确拒绝，不注册空实现。

## 连接作者接口与拓扑提交

```ts
const initialize = api.ir.lifecycle('initialize', []);
const pressed = api.ir.state('pressed', 'bool', false);
const contact = api.ir.connection('contact');

initialize.body((b) => {
  b.connection.apply([{ connection: contact, closed: b.state.load(pressed) }]);
  b.return([]);
});
```

- `api.ir.connection(id)` 只解析描述中已声明的连接，返回静态 `ConnectionRef`；重复调用返回同一句柄。不存在、空 ID 或在工厂封闭后调用分别报 `device/connection-unknown` / `device/connection-invalid` / `device/factory-closed`。没有状态查询或直接更新入口。
- `b.connection.apply([{ connection, closed }])` 把建图时固定的对象列表降低为一份 `connection.apply` 指令：`static-list` 连接引用与等长 `value-list` bool SSA。普通函数、生命周期及嵌套块使用同一写法。空列表、同一 patch 重复连接、非 bool SSA、跨实例句柄与未知连接在提交前拒绝（`device/connection-invalid` / `device/connection-unknown`）。
- 未绑定 `DeviceInstanceOptions.connections.topology` 时，含 `connection.apply` 的程序在链接期报 `device/connection-unavailable`。绑定时，使用的连接必须由该 topology 为当前 `instanceId` 声明，否则报 `device/connection-unknown`。
- 执行 apply 时按值捕获全部 bool，只调用一次 `topology.submit({ instanceId, connections })`；不在入口中推进时间、创建事件或重入 JS。拓扑在下一个合法控制阶段整体应用；同一入口的后续指令不能假定新拓扑已解析。
- 多触点 patch 不暴露中间拓扑；同刻多份 patch 按提交顺序稳定执行。电气冲突或拓扑控制失败不回滚已提交的拓扑状态，按 #50 的 fault 语义上抛。
- topology 被销毁后继续提交报 `device/connection-unavailable`；实例销毁会移除其待执行入口，不再提交连接。`destroy()` 不会销毁宿主拥有的 topology。

## 示例器件与端到端闭环（#58）

`examples/` 按 #11 的同目录同名配对提供两个真实作者面模型，作为首个完整闭环的可执行样例；`package.json` 的 `files` 仅含 `dist`，这些文件既不进入发布产物，也不从包入口导出。

| 目录                    | 描述文件与实现              | 行为                                                                                                                                                                                                                                       |
| ----------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `examples/ideal-button` | `ideal-button.json` + `.js` | 引脚 `A`/`B`、连接 `contact`（初始 open）、输入话题 `pressed: boolean`；话题消息经 `api.post` 进入 `setPressed`，用 `b.connection.apply` 接通/断开被动双向触点；initialize 与 reset 都复位为断开，任何引脚都不被驱动                       |
| `examples/ideal-relay`  | `ideal-relay.json` + `.js`  | 引脚 `IN`/`COM`/`NO`/`NC`、连接 `normallyOpen`/`normallyClosed`；initialize 用 `b.pin.sampleDigital(IN)` 建立初始触点并启用 `observeDigital`；`changed(u8, u32)` 用触发时捕获的电平调用 `apply`，同一 patch 原子切换两路触点；不声明 reset |

端到端用例 `src/e2e/button-relay.test.ts` 从磁盘读取上述配对，经真实文件 provider → `loadDeviceModule` → `createDeviceInstance` → scheduler/IR → `createPowerRuntime`（电气网络、电源域、数字观察）→ `b.connection.apply` → topology 完成闭环：按钮话题 → 线圈网络电压 → 边沿投递 → 继电器 `apply` → 触点拓扑 → 第二网络电压。

`examples/` 放在 `src/` 之外：这些是器件作者的模型文件而非包实现，保留原始 JSON/JS 配对便于宿主与文档直接复用；`tsconfig.build.json` 的 `include: ["src"]` 与 `files: ["dist"]` 共同保证它们不进入 `dist` 或发布包。示例保持 `.js` 配对，因此其组合作者面由 `src/examples.type-test.ts` 以类型断言镜像（pin + connection + entry + observeDigital + subscribe/post + 生命周期），不复制为运行期实现。

端到端用例有两处刻意依赖、但**不是公共合同**的前提，改动时需同步调整断言：

- 4 个实例的 initialize 补丁顺序（`sw1` → `k1` → `sw2` → `k2`）来自「同刻控制条目按实例注册顺序执行」的调度器内部约定；若同刻 control 排序改变，确定性断言必须一起更新。
- 测试板的 `VCC`/`LOAD` 供电、`COIL*`/`NO*`/`NC*` 上下拉与 `board` 电源域绑定属于宿主侧电路（`src/e2e/test-helpers.ts`），不是器件模型的一部分；改动它们会改变电压、门控与冲突断言。

## 错误码

| 错误码                          | 含义                                                                           |
| ------------------------------- | ------------------------------------------------------------------------------ |
| `device/device-unknown`         | provider 返回 `undefined`，或 device id 为空                                   |
| `device/provider-failed`        | provider 抛非 `DeviceError`、未实现 `resolve` 或结果违约；`cause` 保留原始异常 |
| `device/description-schema`     | 定义容器、metadata 或 `designatorPrefix` 形状错误                              |
| `device/implementation-import`  | 代码字符串不是可加载的 ES 模块                                                 |
| `device/implementation-export`  | 默认导出不是普通同步函数（含 generator / class）                               |
| `device/implementation-async`   | 默认导出声明为 async / async generator                                         |
| `device/factory-failed`         | 工厂抛出非 `DeviceError`、不是普通函数或调用失败；`cause` 保留原始异常         |
| `device/factory-async`          | 工厂为 async/async generator，或返回 Promise/thenable                          |
| `device/factory-closed`         | 工厂返回/抛出后尝试继续声明或写入 `api.ir`                                     |
| `device/lifecycle-binding`      | 返回值/字段/生命周期引用/重复绑定/`onDispose` 形状不合法                       |
| `device/lifecycle-unsupported`  | 未绑定 reset 却请求复位                                                        |
| `device/pin-unknown`            | `api.ir.pin` 引用未声明或空的引脚 id                                           |
| `device/pin-io-unavailable`     | 使用引脚 I/O 但缺少 pin host，或宿主未声明/拒绝被引用引脚                      |
| `device/observe-pin`            | 观察 trigger/capture 引脚未知、跨实例或不是 `signal` 引脚                      |
| `device/observe-binding`        | 重复观察名、非法描述符、目标不是普通 entry 或目标签名不匹配                    |
| `device/observe-config`         | 非法 `observe.configure`（未知绑定、非 bool enabled、edges 非 1/2/3）          |
| `device/observe-unavailable`    | 存在观察绑定但缺少 pin host 或宿主不支持数字变化观察                           |
| `device/link-failed`            | IR 校验、链接或不支持的指令；`cause` 保留 `IRExecutionError`                   |
| `device/instance-invalid`       | 创建选项、已加载模块、scheduler 或实例标识不合法                               |
| `device/instance-busy`          | 非法生命周期操作或重入冲突（初始化未完成、故障、运行中销毁等）                 |
| `device/instance-destroyed`     | 销毁后访问 `storage`、请求 reset 或提交消息                                    |
| `device/dispose-failed`         | 内核清理完成后 `onDispose` 抛错、返回 Promise 或非 `undefined`                 |
| `device/topic-unknown`          | 订阅/发布/投递引用了描述中不存在的端口                                         |
| `device/topic-direction`        | 输入/输出方向与操作不匹配                                                      |
| `device/topic-payload`          | 载荷表示或 `simTime` 元数据不合法                                              |
| `device/topic-subscription`     | 同一 callback 重复注册同一输入端口                                             |
| `device/output-unknown`         | `onOutput` 或 bridge 引用了本次工厂未声明的输出                                |
| `device/output-consumer`        | 同一 IR 输出重复登记消费者                                                     |
| `device/message-target`         | `post` / `postBytes` 目标不是普通 entry、签名或参数不合法                      |
| `device/inbox-reference`        | `postBytes` 的 inbox 不是本次工厂声明的 inbox                                  |
| `device/update-target`          | `updateBytes` 资源不可写/未声明/范围非法或提交失败                             |
| `device/message-callback`       | 监听器或 `onTopic` 不是允许的函数形态，或 `onTopic` 返回值不是 `undefined`     |
| `device/not-active`             | initialize 完成前或工厂/链接失败后调用消息操作                                 |
| `device/connection-invalid`     | 空/重复 patch、非 bool、跨实例句柄、重复声明或连接执行参数不合法               |
| `device/connection-unknown`     | 连接 ID 未由描述或绑定的 topology 为该实例声明                                 |
| `device/connection-unavailable` | 使用 `connection.apply` 但未绑定 topology，或 topology 已销毁/拒绝提交         |
| `schema/invalid-type`           | #7/#10/#12/#14 字段类型错误                                                    |
| `schema/invalid-value`          | #7/#10/#12/#14 字段取值错误（含非法连接引脚对）                                |
| `schema/unknown-field`          | #10/#12/#14 声明出现未知字段                                                   |
| `type/unknown`                  | #10 端口载荷类型不在封闭清单                                                   |

`DeviceError` 的 `pointer` 使用 JSON Pointer 指向失败位置，便于宿主定位。

## 支持边界

本层已实现 #53 的工厂上下文与实例生命周期、#54 的话题订阅/发布/`post`/`postBytes`/IR 输出/`updateBytes`/有界队列与激活顺序、#55 的引脚声明与数字 I/O、#56 的数字边沿观察与捕获投递、#57 的 `api.ir.connection` / `b.connection.apply` 与 core topology 提交接入、#60 的 `api.ir.provider` 生成产物接入、#61 的产物 checkpoint/运行中恢复，以及 #58 由 `examples/` 与端到端用例覆盖的理想按钮/继电器闭环（未新增 device 公共入口）。不实现 #59 的 sandbox 执行适配；不提供持久化快照、跨进程/跨实例迁移、重放、ACK/可靠传输、跨实例广播、连接状态查询、JS 直接更新入口、复数别名或外部导线运行时增删。观察仅支持数字边沿；`edges=0` 状态观察、模拟量/电压观察、`set_*` / `get_*`、组 `port.*` I/O、逐引脚 direction 与协议库同样不在本批范围，均明确拒绝而非空实现。文件定位、缺失文件与 JSON 语法诊断由 `IDeviceProvider` 负责。

## 验证

在仓库根目录运行：

```powershell
pnpm --filter "@mica-js/device..." build
pnpm --filter @mica-js/device test
pnpm --filter @mica-js/device typecheck
```

Vitest 使用真实临时目录中的 `.json` / `.js` 配对文件验证 provider 加载；覆盖所有 #7 属性类型、默认值、覆盖校验、未知键忽略、嵌套对象/数组冻结、外部别名变更、运行期写入拒绝、独立实例快照、#10 端口校验、#12 引脚/固定组声明、#14 连接声明、各类导出错误、provider 失败、纯对象容器拒绝、带注释 class、URL 构造失败、Node DOM shim 判定及 provider+device id 模块缓存语义。端到端用例（#58）从 `examples/` 读取已提交的真实 `.json` / `.js` 配对，回放按下、释放与排队短脉冲，断言线圈/触点网络电压、观察投递、SPDT 原子切换、initialize 采样、显式 reset 与缺失 reset、销毁后拒绝输入且 `onDispose` 只执行一次、两个实例隔离、非法模型拒绝、掉电门控不伪造电压，以及电气冲突下已提交的拓扑与网络效果不被回滚，并验证同一输入序列得到同一轨迹；`src/examples.type-test.ts` 以类型断言镜像两个示例的组合作者面。引脚用例使用真实 `createPowerRuntime`、scheduler 与 IR 解释器，覆盖 `pins` / `pinGroups` 解析与拒绝、未知/跨实例/非 signal 引用、builder 类型与配置编码、初始状态提交、同入口写后采样的控制阶段可见性、驱动意图与实际网络分离、掉电/欠压/失地/恢复及持有意图重放、门控采样返回 0、驱动冲突 `ElectricalConflictError`、缺少 host/引脚拒绝与销毁恢复；不使用手写电气算法替代 #49/#51。连接用例走真实 builder → `validateIR` → 解释器/调度器 → 实例生命周期 → core topology，覆盖单触点/双触点、控制阶段延迟、SSA 按值捕获、bool 分支选择 patch、同刻顺序、冲突不回滚、销毁与未知/跨实例诊断。观察用例继续走真实 builder → `validateIR` → 参考解释器 / scheduler → device 生命周期 → core power 链路，覆盖静态绑定与链接期目标签名、`observe.configure` 编码与 `edges=0` 拒绝、首次启用/显式重配/禁用重启/门控恢复/浮空与待定区间重建基线、rising/falling/both 选择、同刻短脉冲双边沿、捕获按值固定、声明顺序与 #54 普通队列顺序、销毁后停止投递及未知/非 signal 引脚和宿主能力诊断。消息用例继续走真实 builder → `validateIR` → 参考解释器 / scheduler → device 生命周期链，覆盖话题订阅/取消/重复、载荷与方向诊断、`post` 接纳与执行分离、`postBytes` 预留/复制/释放/零长度/实例隔离、IR 标量与字节输出、`timePs` 捕获、不重入 JS、输出队列满的 `false`、`updateBytes` 内容与版本、初始化暂存与激活顺序、故障/销毁、各容量 `BackpressureError`、重入排空顺序及链接失败监听清理。生命周期用例使用真实工厂、真实 `createIRModule`、`createIRSchedulerInstance` 与现有 scheduler，覆盖工厂一次调用与声明封闭、同步/Promise/async 拒绝、绑定与重复绑定、链接失败零残留、initialize 控制阶段完成判据、reset 语义与缺失诊断、事件 `now/at/cancel`、故障暂停与故障后销毁、destroy 顺序/幂等/重入、`onDispose` 限制与异常、storage 销毁守卫。跨包集成用例把解析结果送入 `@mica-js/core/schematic` 的 `createDeviceRegistry`，并用真实临时 provider 完成 `loadDeviceModule → createDeviceInstance → scheduler` 闭环。测试直接调用生产函数，不用构建或子进程冒充单元测试。

## 相关提案

- 属性定义：[#7](https://github.com/x-botlab/mica-js/issues/7)
- 器件 JavaScript 作者 API：[#8](https://github.com/x-botlab/mica-js/issues/8)
- 话题端口定义：[#10](https://github.com/x-botlab/mica-js/issues/10)
- 器件定义：[#11](https://github.com/x-botlab/mica-js/issues/11)
- 引脚声明与运行时配置：[#12](https://github.com/x-botlab/mica-js/issues/12)
- 电源域与引脚门控：[#13](https://github.com/x-botlab/mica-js/issues/13)
- 内部可控连接与拓扑切换：[#14](https://github.com/x-botlab/mica-js/issues/14)
- 公共电气模型：[#24](https://github.com/x-botlab/mica-js/issues/24)
- IR 引脚 I/O、采样与观察合同：[#25](https://github.com/x-botlab/mica-js/issues/25)
