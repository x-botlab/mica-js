# @mica-js/device

器件层入口：解析已加载的器件描述、通过宿主 `IDeviceProvider` 加载同步 JS 工厂，并为每个实例提供独立、递归只读的属性快照、工厂上下文与内核驱动的生命周期。

本包负责**描述对象解析、#10 端口校验、#7 属性默认值/值校验、JS 工厂导出形式校验、属性快照、实例级 `api.ir` / `api.props` 上下文、initialize/reset/onDispose 生命周期，以及话题与 IR 输出消息桥接**。不负责文件定位、文件读取、缺失文件诊断或 JSON 语法解析；这些由宿主 `IDeviceProvider` 实现。引脚 I/O、观察与连接分别留给 #55–#57。

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
| `DeviceInstance` / `DeviceInstanceOptions` / `DeviceInstanceState` | 宿主实例句柄与状态                                            |
| `DeviceDescription` 等类型                                         | 描述、端口、工厂与加载结果                                    |

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
    designatorPrefix: 'U',
  },
  { name: 'acme:display', displayName: '显示屏', description: '示例显示器件' },
);
```

- `metadata.name` 必填；`displayName` 缺省回退 `name`；`description` 可选。
- `properties` 复用 `@mica-js/core/schematic` 的 #7 实现；不可用的属性描述被忽略，不猜测类型。
- `ports` 按 #10 校验：方向必须是 `input` / `output`，载荷类型取自封闭清单，未知字段报 `schema/unknown-field`，未知类型报 `type/unknown`。
- `designatorPrefix` 去除首尾空白；空字符串视为未声明。
- 顶层未知字段被忽略；定义对象只接受已解析对象，JSON 文本与语法错误属于 provider。
- 定义、`properties`、`ports`、单端口与属性覆盖都必须是纯对象；`Map`、`Set`、`Date`、class 实例不会被当作空记录。`Object.create(null)` 与跨 realm 的普通对象仍被接受。

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
});

expect(instance.state).toBe('initializing');
scheduler.start(); // 公共控制阶段执行 initialize
expect(instance.state).toBe('ready');
```

工厂与绑定的已确认形态：

```ts
interface DeviceAPI {
  readonly props: DevicePropertySnapshot;
  readonly ir: IRDeclarations;
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

- 同步工厂每次创建只调用一次。`api.ir` 仅暴露 `state/array/bytes/inbox/func/entry/lifecycle/output/outputBytes` 声明方法；工厂返回**或抛出**后立即封闭，任何后续声明或结构写入报 `device/factory-closed`。工厂不能通过上下文取得原始 `IRModule`、执行器或调度器。`subscribe` / `onOutput` 登记同样只在工厂期间开放。
- `api.props` 是创建时解析默认值后的独立、递归只读快照；运行期不可修改，不提供更新接口、自动重建或 `onPropsChanged`。需要另一组属性时由宿主显式创建新实例。
- 工厂返回值必须是纯对象，只允许 `initialize` / `reset` / `onDispose` 三个字段。生命周期引用必须属于本次工厂声明的模块、类别为 `lifecycle`、零参数；同一引用同时绑定 initialize 与 reset 拒绝。`onDispose` 必须是同步普通函数（拒绝 async/generator/class），运行时还要求返回 `undefined`。
- 工厂返回 Promise/thenable 或默认导出为 async/async generator 报 `device/factory-async`；普通函数抛出、非普通函数或非法返回形状分别报 `device/factory-failed` / `device/lifecycle-binding`。
- `createDeviceInstance` 只有在工厂返回、绑定校验和真实 `validateIR`/链接全部通过后才安装 scheduler 实例并入队 initialize。任何前置失败不留下实例、队列任务或解释器引用，也不执行 initialize。IR 校验/链接失败统一报 `device/link-failed` 并保留 `cause`。
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
- 宿主用 `instance.deliver(port, payload, { simTime })` 投递输入话题，用 `onTopic` 接收 `api.publish`。`onTopic` 必须是同步、返回 `undefined` 的函数；未提供时发布消息在校验后丢弃。初始化期间的输入与 IR 输出暂存于有界队列，initialize 成功后先按捕获顺序通知输出，再按接纳顺序投递输入。
- 工厂/initialize 完成前调用 `post/postBytes/publish/updateBytes` 报 `device/not-active`；故障/销毁中报 `device/instance-busy`；销毁后报 `device/instance-destroyed`。销毁丢弃未消费的实例内通知，但不撤销已交付给 `onTopic` 的外部效果。
- 不实现重放、ACK/可靠传输、跨实例广播协议；普通消息投递不推进客体时间。

`api.ir` 仍不暴露 `IRModule.functions/memories` 或 domain 声明/指令面，相关领域能力由 #55/#57 扩展。

## 错误码

| 错误码                         | 含义                                                                           |
| ------------------------------ | ------------------------------------------------------------------------------ |
| `device/device-unknown`        | provider 返回 `undefined`，或 device id 为空                                   |
| `device/provider-failed`       | provider 抛非 `DeviceError`、未实现 `resolve` 或结果违约；`cause` 保留原始异常 |
| `device/description-schema`    | 定义容器、metadata 或 `designatorPrefix` 形状错误                              |
| `device/implementation-import` | 代码字符串不是可加载的 ES 模块                                                 |
| `device/implementation-export` | 默认导出不是普通同步函数（含 generator / class）                               |
| `device/implementation-async`  | 默认导出声明为 async / async generator                                         |
| `device/factory-failed`        | 工厂抛出非 `DeviceError`、不是普通函数或调用失败；`cause` 保留原始异常         |
| `device/factory-async`         | 工厂为 async/async generator，或返回 Promise/thenable                          |
| `device/factory-closed`        | 工厂返回/抛出后尝试继续声明或写入 `api.ir`                                     |
| `device/lifecycle-binding`     | 返回值/字段/生命周期引用/重复绑定/`onDispose` 形状不合法                       |
| `device/lifecycle-unsupported` | 未绑定 reset 却请求复位                                                        |
| `device/link-failed`           | IR 校验、链接或不支持的指令；`cause` 保留 `IRExecutionError`                   |
| `device/instance-invalid`      | 创建选项、已加载模块、scheduler 或实例标识不合法                               |
| `device/instance-busy`         | 非法生命周期操作或重入冲突（初始化未完成、故障、运行中销毁等）                 |
| `device/instance-destroyed`    | 销毁后访问 `storage`、请求 reset 或提交消息                                    |
| `device/dispose-failed`        | 内核清理完成后 `onDispose` 抛错、返回 Promise 或非 `undefined`                 |
| `device/topic-unknown`         | 订阅/发布/投递引用了描述中不存在的端口                                         |
| `device/topic-direction`       | 输入/输出方向与操作不匹配                                                      |
| `device/topic-payload`         | 载荷表示或 `simTime` 元数据不合法                                              |
| `device/topic-subscription`    | 同一 callback 重复注册同一输入端口                                             |
| `device/output-unknown`        | `onOutput` 或 bridge 引用了本次工厂未声明的输出                                |
| `device/output-consumer`       | 同一 IR 输出重复登记消费者                                                     |
| `device/message-target`        | `post` / `postBytes` 目标不是普通 entry、签名或参数不合法                      |
| `device/inbox-reference`       | `postBytes` 的 inbox 不是本次工厂声明的 inbox                                  |
| `device/update-target`         | `updateBytes` 资源不可写/未声明/范围非法或提交失败                             |
| `device/message-callback`      | 监听器或 `onTopic` 不是允许的函数形态                                          |
| `device/not-active`            | initialize 完成前或工厂/链接失败后调用消息操作                                 |
| `schema/invalid-type`          | #7/#10 字段类型错误                                                            |
| `schema/invalid-value`         | #7/#10 字段取值错误                                                            |
| `schema/unknown-field`         | #10 端口声明出现未知字段                                                       |
| `type/unknown`                 | #10 端口载荷类型不在封闭清单                                                   |

`DeviceError` 的 `pointer` 使用 JSON Pointer 指向失败位置，便于宿主定位。

## 支持边界

本层已实现 #53 的工厂上下文与实例生命周期，以及 #54 的话题订阅/发布、`post` / `postBytes`、IR 标量/字节输出、`updateBytes`、有界队列与激活顺序。不实现 #55 的引脚声明与 I/O 指令、#56 的观察投递、#57 的 `connection.apply`、#59 的 sandbox 执行适配，也不实现 #60/#61 的 Provider/checkpoint；不提供重放、ACK/可靠传输或跨实例广播。文件定位、缺失文件与 JSON 语法诊断由 `IDeviceProvider` 负责；本包不以空实现冒充这些能力。

## 验证

在仓库根目录运行：

```powershell
pnpm --filter "@mica-js/device..." build
pnpm --filter @mica-js/device test
pnpm --filter @mica-js/device typecheck
```

Vitest 使用真实临时目录中的 `.json` / `.js` 配对文件验证 provider 加载；覆盖所有 #7 属性类型、默认值、覆盖校验、未知键忽略、嵌套对象/数组冻结、外部别名变更、运行期写入拒绝、独立实例快照、#10 端口校验、各类导出错误、provider 失败、纯对象容器拒绝、带注释 class、URL 构造失败、Node DOM shim 判定及 provider+device id 模块缓存语义。生命周期用例使用真实工厂、真实 `createIRModule`、`createIRSchedulerInstance` 与现有 scheduler，覆盖工厂一次调用与声明封闭、同步/Promise/async 拒绝、绑定与重复绑定、链接失败零残留、initialize 控制阶段完成判据、reset 语义与缺失诊断、事件 `now/at/cancel`、故障暂停与故障后销毁、destroy 顺序/幂等/重入、`onDispose` 限制与异常、storage 销毁守卫。消息用例继续走真实 builder → `validateIR` → 参考解释器 / scheduler → device 生命周期链，覆盖话题订阅/取消/重复、载荷与方向诊断、`post` 接纳与执行分离、`postBytes` 预留/复制/释放/零长度/实例隔离、IR 标量与字节输出、`timePs` 捕获、不重入 JS、输出队列满的 `false`、`updateBytes` 内容与版本、初始化暂存与激活顺序、故障/销毁、以及各容量 `BackpressureError`。跨包集成用例把解析结果送入 `@mica-js/core/schematic` 的 `createDeviceRegistry`，并用真实临时 provider 完成 `loadDeviceModule → createDeviceInstance → scheduler` 闭环。测试直接调用生产函数，不用构建或子进程冒充单元测试。

## 相关提案

- 属性定义：[#7](https://github.com/x-botlab/mica-js/issues/7)
- 器件 JavaScript 作者 API：[#8](https://github.com/x-botlab/mica-js/issues/8)
- 话题端口定义：[#10](https://github.com/x-botlab/mica-js/issues/10)
- 器件定义：[#11](https://github.com/x-botlab/mica-js/issues/11)
