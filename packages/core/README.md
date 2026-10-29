# @mica-js/core

Mica 仿真内核：整数皮秒虚拟时间与确定性事件调度，并在其上提供电气网络求值、连接拓扑与电源域门控。同一包的子入口还提供原理图 `.sch` 与画布 `.cnv` 的文档格式。

## 入口

| 入口                      | 内容                                                          |
| ------------------------- | ------------------------------------------------------------- |
| `@mica-js/core`           | 仿真内核：时间、调度、电气求值、连接拓扑、电源域              |
| `@mica-js/core/schematic` | `.sch`：解析、序列化、拓扑推导、编辑命令、器件注册表          |
| `@mica-js/core/canvas`    | `.cnv`：widget 实例、属性覆盖、端口绑定与绑定校验             |
| `@mica-js/core/rpc`       | MessagePort 上的双向 RPC：动态代理、事件订阅与 transfer       |
| `@mica-js/core/logging`   | `LogRecord` / `LoggerService` 与 `loggerService` RPC 服务标识 |
| `@mica-js/core/lifecycle` | `Disposable`、`DisposableStore`、`Event<T>` 与 `Emitter`      |

## RPC 与资源管理

`@mica-js/core/rpc` 提供基于 MessagePort 的 `createRpc`，支持动态代理、双向调用和按 `onDidXxx` 命名的事件订阅，无需维护方法描述表。服务端在运行时检查方法并保留实现对象的 `this`；访问器及 `Object.prototype` 成员不会被暴露。

代理普通方法统一返回 Promise，即使实现方法同步返回。事件同步返回取消订阅函数；非方法属性和普通方法的回调参数不能作为远程接口使用。参数与结果须支持结构化克隆，URI 使用字符串。业务操作的串行调度由服务负责，RPC 保留端口消息顺序，支持双向重入调用。

`@mica-js/core/lifecycle` 提供 `IDisposable`（及其别名 `Disposable`）、`DisposableStore`、`toDisposable`，以及 VS Code 同款 `Event<T>` 与它的实现 `Emitter<T>`；各包的 `onDidXxx` 成员一律用它实现。`clear()` 释放当前资源后仍可复用；`dispose()` 永久关闭，之后添加的资源立即释放。清理失败会在其余资源释放后通过 `AggregateError` 汇总。

`@mica-js/core/logging` 定义可结构化克隆的 `LogRecord` 与 `LoggerService`，并把共享的服务标识 `loggerService` 绑定到 `'logger'`。sandbox 两侧各自 `register` / `getProxy` 同一个标识即可转出日志，宿主侧只负责把记录落到自己的输出。

```ts
import { createRpc, defineRpcService } from '@mica-js/core/rpc';
import { DisposableStore, toDisposable } from '@mica-js/core/lifecycle';

const store = new DisposableStore();
const rpc = store.add(createRpc(port));
const deviceHost = defineRpcService<DeviceSimulationHost>('deviceHost');
const service = rpc.getProxy(deviceHost);
store.add(toDisposable(service.onDidPublishTopic(handleTopic)));
await service.tick(dt);
store.dispose();
```

`register()` 返回 `IDisposable`，注销时释放该服务的远端订阅并通过 `ServiceUnregistered` 通知订阅方；已经开始的方法执行照常完成。事件注册失败、事件发送失败及协议异常通过 `onDidError` 或创建时的 `onError` 回调报告。`RpcEndpoint.onDidError` / `onDidClose` 本身也是 `@mica-js/core/lifecycle` 的 `Event<T>`，订阅返回 `Disposable`；代理上的 `onDidXxx` 事件同步返回取消订阅函数。取消订阅幂等，即使远端尚未确认注册也能取消；监听者异常不会打断其余事件和响应。

调用与订阅确认支持 `createRpc(port, { timeoutMs })` 默认超时，也可通过 `getProxy(name, { timeoutMs })` 覆盖。默认值 `0` 表示关闭超时，取值范围为 `0..2147483647` 整数毫秒。超时以 `RpcTimeoutError` 拒绝等待，远端执行继续；迟到响应被忽略。超时的订阅会发送取消消息。请求取消暂未提供。

### 显式 Transfer

默认使用结构化克隆。调用参数的转移列表在代理选项中指定，返回值和事件参数的转移列表在服务注册选项中指定：

```ts
const buffers = defineRpcService<BufferService>('buffers');
const remote = rpc.getProxy(buffers, {
  transfer: (member, args) => (member === 'write' ? [args[0] as ArrayBuffer] : []),
});

store.add(
  rpc.register(buffers, implementation, {
    transfer: (member, value) => {
      if (member === 'read') return [value as ArrayBuffer];
      if (member === 'onDidFrame') return [(value as [ImageBitmap])[0]];
      return [];
    },
  }),
);
```

事件的 `value` 是完整参数数组，普通方法的 `value` 是返回值。转移对象必须也出现在消息数据中；转移成功后发送方失去所有权。多订阅者需要独立的可转移对象，服务实现负责逐订阅者生成或克隆，RPC 不自动复制资源。Node MessagePort 的转移类型从端口推导，核心实现无需依赖 Node。

端口由调用方管理；释放 RPC 会通知对端、拒绝未完成调用、清理请求计时器与双向订阅，并触发 `onDidClose`，但不关闭传入的端口。异常消息报告 `RpcProtocolError` 后被忽略。浏览器端口没有可靠的对端终止通知，sandbox 终止流程必须主动调用 `rpc.dispose()`；超时只能限制等待时间，不能替代生命周期清理。

## 架构

```mermaid
flowchart TD
  subgraph core["@mica-js/core"]
    scheduler["Scheduler<br/>虚拟时间 · 事件队列 · 控制阶段"]
    topology["TopologyRuntime<br/>内部连接 · 连通分量 · 原子 patch"]
    power["PowerRuntime<br/>电源域 · 迟滞 · 门控 · 通知"]
    electrical["resolveElectricalNetwork<br/>理想电压 · 弱偏置 · 浮空"]
    adapter["createIRSchedulerInstance<br/>IR JIT/解释器 ↔ 调度器"]
    documents["schematic / canvas 子入口"]
  end

  ir["@mica-js/ir JIT/解释器"] --> adapter
  adapter --> scheduler
  topology --> scheduler
  topology --> electrical
  power --> topology
  power --> scheduler
```

## 安装

```bash
pnpm add @mica-js/core
```

## 快速上手

```ts
import { createIRModule } from '@mica-js/ir';
import { createIRSchedulerInstance, createScheduler } from '@mica-js/core';

const module = createIRModule();
const count = module.state('count', 'u32', 0);
const tick = module.entry('tick', []);
tick.body((b) => {
  b.state.store(count, b.int.add(b.state.load(count), b.const('u32', 1)));
  b.event.at(tick, b.float.add(b.event.now(), b.const('f64', 1000)), []); // 1 ns 后再触发
  b.return([]);
});

const operations = [
  'const',
  'state.load',
  'int.add',
  'float.add',
  'state.store',
  'event.now',
  'event.at',
  'return',
];
const scheduler = createScheduler();
const instance = createIRSchedulerInstance(scheduler, {
  instanceId: 'counter',
  module,
  validation: {
    supportedInstructions: operations,
    authorizedInstructions: operations,
    resources: [{ ref: count, access: 'read-write' }],
  },
});

instance.at(tick, 0, []);
const report = scheduler.start({ until: 10_000 });
// report = { timePs: 10000, executed: 11, reason: 'until' }
instance.storage.loadState(count); // 11
```

## 时间

- `TimePs` 是 `number` 品牌类型；`timePs(value)` 运行时验证并构造它。合法范围是 `0..MAX_TIME_PS`（含两端），`MAX_TIME_PS = 7_200_000_000_000_000`，即两小时。
- `toTimePs(value, unit)` 接受非负整数单位值，单位为 `ps/ns/us/ms/s`，系数依次为 `1/1_000/1_000_000/1_000_000_000/1_000_000_000_000`。
- `addTime(left, right)` 与 `subtractTime(later, earlier)` 检查全部输入及结果；负差、加法或换算越界拒绝。
- 类型非 `number`、非有限值或非整数先抛 `TypeError`，再对负值/超过上限抛 `RangeError`，不做隐式转换。`-0` 规范化为 `+0`。错误包含输入名、值与约束；时间以 JSON 整数数值精确往返。
- 普通 IR `f64` 仍可为非整数、NaN 或无穷；只有提交到时间接口时才按时间约束检查。

## 真实 IR 执行

`createIRSchedulerInstance(scheduler, { instanceId, module, validation, executors?, engine? })` 创建一份既有 `@mica-js/ir` 执行引擎及独立存储，将 `event.now/at/cancel` 接入**同一个**调度队列和 ID 分配器，不另造解释器或调度器。`engine` 选择执行引擎：默认 `'jit'`（`createIRJIT`），`'reference'` 回退到参考解释器，仅用于调试或对照；两者使用同一份选项与同一套存储语义，可观测行为等价（执行顺序、虚拟时间、每入口步数预算与错误字段、`IRExecutionError` 的位置与调用链），详见 `@mica-js/ir` README 的 JIT 一节。`validation` 的指令支持/授权与资源权限仍显式提供，不会自动放宽；`executors` 是可信宿主提供的领域指令同步执行器，未注册的领域指令仍在链接期拒绝。

```ts
import { createIRModule } from '@mica-js/ir';
import { createIRSchedulerInstance, createScheduler } from '@mica-js/core';

const module = createIRModule();
const received = module.state('received', 'u32', 0);
const deliver = module.entry('deliver', ['u32']);
deliver.body((b, [value]) => {
  b.state.store(received, value);
  b.return([]);
});
const queue = module.entry('queue', []);
queue.body((b) => {
  b.event.at(deliver, b.event.now(), [b.const('u32', 7)]);
  b.return([]);
});
const operations = ['const', 'state.store', 'event.now', 'event.at', 'return'];
const scheduler = createScheduler();
const instance = createIRSchedulerInstance(scheduler, {
  instanceId: 'example',
  module,
  validation: {
    supportedInstructions: operations,
    authorizedInstructions: operations,
    resources: [{ ref: received, access: 'write' }],
  },
});
instance.at(queue, 0, []);
scheduler.start();
instance.storage.loadState(received); // 7
```

适配器返回只读 `instance: SchedulerInstance`、`storage: IRStorage`，以及 `at(EntryRef, deadline, args): number`、`cancel(id): void`、`enqueueControl(LifecycleRef, args): void`、`enqueueMessage(EntryRef, args): number`。生命周期不能用 `at` 提升优先级；控制接入仅供可信内核，不向器件开放创建特权工作能力。销毁使用 `scheduler.destroyInstance(instance.instance)`。

领域执行器只接收解释器快照中的节点、按值解析的 SSA 操作数与执行上下文；它们只应在当前调度入口内同步工作。`connection.apply` 使用这一扩展把捕获的 bool 列表一次性提交给 `TopologyRuntime.submit()`，由拓扑在下一个控制阶段原子应用；核心不导入连接领域类型。

模块中的普通入口和生命周期在创建时固定身份与签名；接纳前完整检查目标、期限及全部标量参数，成功后按值捕获，包括 `FloatBits` 的独立不可变副本和原始浮点位。普通函数、同名伪造引用、跨实例/模块目标、错误类别/参数及过去期限均拒绝。无事件 host 的独立解释器拒绝事件模块；不支持的其他领域指令仍明确拒绝。

## 调度与暂停

`createScheduler({ maxStepsPerEntry?, maxEntriesPerTime? }?)` 返回 `Scheduler`，只读 `now`、`state: 'paused' | 'running' | 'faulted'`、`error`。

- `start({ until?, maxEntries? }?)` **同步**驱动，返回 `{ timePs, executed, reason }`；`reason` 为 `empty/until/entry-limit/paused`。本包没有墙钟映射、异步后台循环或 UI 运行器。
- `until` 包含端点；只有该时刻所有可运行工作完成后，才推进到 `until`。未给 `until` 时，空队列不额外推进时间。
- `pause()` 在当前入口返回后停止，不中断入口；非运行状态幂等。可信执行后端可以在入口内请求暂停。外部同步调用方可用 `maxEntries` 分段驱动。
- `step()` 恰好执行一个入口，优先控制工作。`maxEntries=0` 不执行、不推进；`entry-limit/pause` 也不额外推进。禁止嵌套 `start/step`。
- 普通事件按 `(timePs, round, sequence)` 稳定排列；同刻反馈进入后续普通轮次，不递归调用。已排 A/C，A 安排 B，结果为 A/C/B。暂停边界的新输入不得插回已经执行的因果层。
- 当前入口返回后，公共控制先于下一普通入口；A 产生 P 而 C 已排队，结果为 A/P/C。控制产生的控制变化进入后续控制轮次，不递归执行，全部完成后才恢复普通队列。
- 顺序不取决于 ID 或墙钟；因果轮次与顺序号使用私有精确计数，不会因长期累计发生安全整数溢出。

## ID 与销毁

普通事件 ID 为每实例独立的非零 u32，0 表示没有事件。首次从 1 递增；存在空闲 ID 时优先按**释放 FIFO** 复用，不按数值排序，也不限制累计安排次数。待执行取消立即释放，正在执行的 ID 直到正常返回才释放；失败不是正常返回。

`cancel(0)`、取消已释放未复用 ID 和取消正在执行事件均为 no-op。未分配过或非法 ID 报错。到期但尚未执行的事件仍可取消。旧数字副本若已复用，取消的是当前新事件，不提供公开代际保护；模型应清空过期编号。内核队列持有具体记录及状态，取消残留项绝不因数字 ID 复用而运行新事件或修改新期限。

`destroyInstance(handle)` 在入口边界停止输入并取消普通/控制待执行工作，不中断当前入口。销毁完成后调度器删除该实例的内部记录，并从队列清除其待执行项，释放 target、executor 及（IR 适配器）解释器与存储引用，反复创建/销毁不再累积；被取消的队列项即使调度器不再驱动也不会保留引用。**即使调度器已因故障进入 `faulted`，仍可对仍存在的实例调用 `destroyInstance` 完成清理；这只是释放资源，不恢复 `start/step/cancel` 等执行能力，故障状态与错误保持不变。** 实例身份与 ID 编号空间仍永久保留、不复用，外部保留的旧句柄只能得到 `invalid-instance`；不把 reset 当作 destroy。这里只处理时间/事件，不替领域资源执行电气传播或清理协议。

## 可信执行接入

低层 `addInstance({ instanceId, targets, executor })` 返回 `SchedulerInstance`（`instanceId/at/cancel`）。`SchedulerTarget` 声明 `name`、`kind: 'event' | 'control'`、`params: readonly ScalarType[]`；按登记对象身份接纳并固定元数据，不按名称匹配外来对象。后端收到不可变的目标视图。参数复用 `@mica-js/ir` 的 `RuntimeScalar`，不接受对象闭包或存储别名。

`SchedulerExecutor.execute(target, args, context): void` 是**可信内核后端合同，不是任意作者 JS 回调协议或安全沙箱**。`context` 提供 `instanceId/timePs/phase/eventId/messageId/remainingSteps`（控制 eventId 为 0；普通事件与控制工作的 messageId 为 0）及 `consumeSteps(count = 1)`；后端必须在每个参考 IR 步骤效果提交前计数，包含普通同步调用及终结指令，不得以优化后机器指令数替代。它不能抢占任意 JS 死循环。拒绝 async/generator、Promise/thenable 结果及重入执行；可识别的异步函数在调用前拒绝，普通函数返回 Promise 前已提交的效果不回滚。

`enqueueControl(instance, target, args)` 仅是可信内核的控制入口；器件、Provider 无权自行创建控制工作。此接口不定义电气或其他领域的具体触发规则。

`enqueueMessage(instance, target, args)` 接纳普通 `event` 类别入口的普通消息：时间固定为当前虚拟时间，不分配事件 ID、不可取消、不推进时间；返回实例内单调递增的正 message ID，并通过 `context.messageId` 传给后端，供 device 层释放 inbox 预留或统计在途请求。消息在当前普通轮次之后按 `(timePs, round, sequence)` 排序执行；faulted/destroyed 实例拒绝。它不形成等待栈，也不改变控制工作优先级。

## 预算与故障

每入口参考步骤和同一虚拟时刻的入口次数（普通及控制合计）默认各为 **1,000,000**，可配置非负安全整数；0 禁止执行。入口次数跨暂停、步进和分段保留，只在时间真正变化时重置。超限在下一步骤/入口效果前暂停并诊断，不偷偷增加 1 ps。

IR 适配器通过 `stepBudget` 协议（`remaining()` / `consume(ctx, count)`）连接调度器计步：最多一次提交本段已执行的步数，而非每一步都调用一次宿主。其内部解释器 `maxSteps` 设为 `Number.MAX_SAFE_INTEGER`，实际预算由 scheduler 控制，避免独立解释器的默认一百万覆盖用户更高配置；独立解释器默认行为不变。

宿主边界输入失败无队列/ID 副作用，不污染仿真。入口外的边界错误 `steps` 为 0，且不填 `instanceId/targetName/phase/eventId`，不继承上一入口的计数；入口内故障仍报告失败入口的步数与位置。入口内模型错误使整个 scheduler `faulted`，保留此前已提交状态、已安排队列及失败入口占用的 ID，不继续执行其他实例；后端捕获错误也不能清除全局故障。不支持入口中途恢复或检查点恢复，必须重建/合法重放。`pause()` 不清除故障。

时间错误仍是 `TypeError/RangeError`；执行时包装为 `SchedulerError` 并保留 `cause`。其只读字段包括 `code/instanceId/targetName/timePs/phase/eventId/steps/entriesAtTime/cause`；IR 原始错误、调用链与位置留在 cause。

`SchedulerErrorCode` 为：`invalid-options`、`invalid-instance`、`invalid-target`、`invalid-argument`、`invalid-event-id`、`event-id-exhausted`、`reentrant-execution`、`executor-contract`、`entry-budget-exhausted`、`time-budget-exhausted`、`execution-failed`、`scheduler-faulted`。

## 验证与边界

使用现有 Vitest/TypeScript/Vite/ESLint/Prettier。测试直接执行调度及真实 IR 的状态/数组效果，覆盖时间边界、A/C/B、A/P/C、值捕获、取消/复用/旧项隔离、分段确定性、长反馈、预算/异常及前序效果保留。没有用构建、子进程或临时消费者作为单测。源码 typecheck 与 Vitest 直接解析 workspace IR 源码，干净 checkout 无需先构建即可验证；发布构建使用独立 `tsconfig.build.json`，仍将 `@mica-js/ir` 保留为外部依赖，避免复制其引用符号/解释器身份。

```powershell
pnpm --filter @mica-js/ir build
pnpm --filter @mica-js/core test
pnpm --filter @mica-js/core typecheck
pnpm --filter @mica-js/core build
```

不提供电气求值、器件作者回调协议、话题路由/JS 消息桥、Provider 缓存（由 `@mica-js/ir` 提供）、JIT、I2C/SPI 协议库、持久化调度快照或墙钟运行器。未实现能力不会以空实现或仅记录指令冒充完成。

## 原理图（`./schematic`）

```ts
import { loadSchematic, parseSchematic, serializeSchematic } from '@mica-js/core/schematic';

const loaded = loadSchematic(text, { devices }); // { document, topology }
const document = parseSchematic(text); // 解析 + 校验，失败抛 SchematicError
serializeSchematic(document); // 固定字段顺序的 .sch JSON
```

- 文件名即原理图标识，顶层没有 `id`；`symbols` / `wires` / `junctions` 的 `id` 必须是 UUID v4，非 v4 报 `schema/invalid-value`。
- 拓扑按位号、网名与连接关系合并网络；纯绘图分量保留为几何数据。
- 编辑命令、undo/redo、命中测试、导线段拖动与交点合并都是纯函数，编辑器只做编排。
- `createDeviceRegistry` 把器件的 `designatorPrefix` 与引脚声明合成为符号几何与位号。
- 属性（#7）：`string` / `number` / `integer` / `boolean` / `enum` / `color` / `image` / `binary`；`image` / `binary` 的值是资源引用 `{ src, mode }`（`file` 为工程根相对路径，`inline` 为 base64，`store` 为宿主资源标识）。

## 画布（`./canvas`）

```ts
import { applyCanvasCommand, parseCanvas, serializeCanvas } from '@mica-js/core/canvas';

const canvas = parseCanvas(text); // version / schematic / widgets
serializeCanvas(canvas); // 固定键序、2 空格缩进、结尾换行

const next = applyCanvasCommand(canvas, {
  type: 'set-property',
  instanceId,
  key: 'label',
  value: 'hello',
}); // 纯函数：返回新文档，canvas 不变
```

canvas 是独立画布：`widgets` 是 widget 实例数组，数组顺序即绘制顺序；实例保存 `x` / `y` / `width` / `height` / `rotation`、可选的 `properties` 覆盖与 `bindings`（端口键 → `{ symbol, port }` 端点）。canvas 以工程根相对路径作为标识，顶层没有 `id`；`schematic` 可选，只声明仿真绑定。原理图编辑器不依赖这个入口。

编辑命令（#96）：`add-instance` / `remove-instance`、`set-placement` / `set-z`、`set-property` / `unset-property`、`set-binding`（`target: null` 解绑）、`set-schematic`（`null` 清除）。命令是纯函数，失败抛 `SchematicError` 并一次带回全部诊断；本层只做结构校验，端点存在性、方向与载荷类型由绑定装载负责。

绑定校验（#99）：`validateCanvasBindings(document, { catalog })` 收集诊断、从不抛错；`assertCanvasBindings` 在有 error 时抛 `SchematicError` 并带回全部诊断。`CanvasBindingCatalog` 由宿主注入（widget 定义、已加载的 `.sch`、符号与器件端口），未提供 `catalog` 时跳过引用校验以保持向后兼容；`skipWidgets` 只校验器件侧，文档缺少 `schematic` 时只校验 widget 侧。方向必须互补（widget `input` 接器件 `output`，widget `output` 接器件 `input`），载荷类型必须相同，否则报 `topic/type-mismatch`。诊断码还包括 `canvas/unknown-schematic`、`canvas/unknown-widget`、`canvas/unknown-property`、`canvas/unknown-port`、`canvas/unknown-symbol` 与 `canvas/unknown-target-port`；原理图未加载时只报一次 `canvas/unknown-schematic`，不再级联符号错误。

## 话题投递（RFC 0017）

端口描述可以声明可选的 `delivery`：`level` 表示载荷是「当前值」，一步内只保留最后一条；`message` 表示载荷是「一条消息」，按发布顺序全部送达。省略时按载荷类型取默认值——`boolean` / `number` / `vec2d` / `vec3d` 为 `level`，`string`、`bytes`、`bytes<rgb565>`、`bytes<segments>` 为 `message`。`delivery` 与 `type` 正交，任意组合都成立。

```ts
import { TopicInbox, resolveDelivery } from '@mica-js/core';

const delivery = resolveDelivery(descriptor.delivery, descriptor.type); // 声明的值优先
const inbox = new TopicInbox({ delivery, capacity: 16, port: 'rx', onDiagnostic });
inbox.post({ payload, simTime }); // message 端口满时返回 false 并上报 topic/backpressure
inbox.takeInputs(); // 或 takeInput()；同一端口混用会上报 topic/mixed-read
inbox.endStep(); // 步结束时清空本步记录，level 的生效值仍可由 inbox.current 读到
```

`./canvas` 入口同时导出 `parseDeliveryKind` / `defaultDelivery`，以及带 `delivery` 字段的 `CanvasPortDescriptor`，供 widget 与器件描述的装载期校验使用。

## 电气模块

当前实现公共电气网络的纯求值与 `mica-floating-v2` 浮空模拟取值。公共合同经 [#49 逐项批准](https://github.com/x-botlab/mica-js/issues/49#issuecomment-6322043409)，依据 [#12 引脚状态](https://github.com/x-botlab/mica-js/issues/12)、[#24 电气模型](https://github.com/x-botlab/mica-js/issues/24) 和 [#23 整数皮秒时间](https://github.com/x-botlab/mica-js/issues/23)。既有 `MICA_CORE_VERSION` 保留。实现位于 `src/electrical/`，与 `src/schematic/`、`src/canvas/` 并列。

## 网络求值

`resolveElectricalNetwork(input: ElectricalNetworkInput): ElectricalNetworkResult` 接收拓扑层已经连接到同一网络的完整引脚快照，不读取原理图、创建连接或维护拓扑。断开的引脚由调用方从 `pins` 移除。

```typescript
import { resolveElectricalNetwork, type ElectricalPinInput } from '@mica-js/core';

const output: ElectricalPinInput = {
  instanceId: 'device-1',
  pinName: 'P0',
  powerReady: true,
  mode: 'open-drain',
  outputEnabled: true,
  pull: 'up',
  digitalIntent: true,
  model: {
    kind: 'ideal-voltage',
    minVoltage: 0,
    maxVoltage: 3.3,
    lowVoltage: 0,
    highVoltage: 3.3,
  },
};

const result = resolveElectricalNetwork({ networkId: 'data', pins: [output] });
// result.state === 'driven', result.voltage === 3.3, result.strength === 'weak'
```

根入口导出 `ElectricalPinInput`、`ElectricalNetworkInput`、`ElectricalContribution`、`ElectricalNetworkResult`、`ElectricalConflictError` 及求值函数。输入状态为：

| 字段                     | 语义                                                       |
| ------------------------ | ---------------------------------------------------------- |
| `networkId`              | 非空原始字符串，仅作为诊断身份                             |
| `pins`                   | 同一网络的实体引脚快照数组，可以为空                       |
| `instanceId` / `pinName` | 非空原始字符串；同网络中的二元身份必须唯一                 |
| `powerReady`             | 调用方提供的供电就绪布尔值；false 释放主动及偏置贡献       |
| `mode`                   | `high-z`、`push-pull`、`open-drain`、`analog`              |
| `outputEnabled`          | 主动输出使能；不影响内部偏置                               |
| `pull`                   | `none`、`up`、`down`；独立于模式、使能及输出意图 readiness |
| `digitalIntent?`         | boolean；缺省表示数字意图未就绪，false/true 对应 0/1       |
| `voltageIntent?`         | number；缺省表示电压意图未就绪，零也是就绪电压             |
| `model`                  | 显式 `ideal-voltage` 模型，包含 min/max/low/high 电压      |

`high-z`、使能关闭或当前模式所需意图未就绪时主动释放。推挽 false/true 取 low/high；开漏 false 取 low，true 释放；analog 取已就绪 voltageIntent。供电就绪时上下拉独立取 high/low。函数不改变配置或意图，也不保存其引用；模式/门控变化后的完整快照由调用方提交。

### 相容性与结果

电压单位为 V，参考公共地。全部强贡献优先于弱偏置；最高优先级电压满足 `max - min <= 0.001` 时相容，取最低值。强贡献存在时相反弱偏置不会造成冲突。只有弱贡献时采用同一规则。边界直接采用 f64 运算，不添加 epsilon，也不舍入；例如 `3.301 - 3.3 > 0.001`，因此这组电压冲突。

- `state: 'driven'`：包含 `voltage`、`strength: 'strong' | 'weak'`、`contributions`。不在此处按 #13 门限生成数字逻辑。
- `state: 'floating'`：包含 `digitalFallback: false` 和空 `contributions`，**没有物理电压**。false 仅代表 #24 规定的浮空数字默认值，不隐藏冲突或未完成的求值。
- `contributions`：每条包含 `instanceId`、`pinName`、`kind: 'drive' | 'pull'`、`strength`、`voltage`，保留所有实际生效贡献，包括被强贡献覆盖的弱偏置。

结果及贡献递归冻结，并与调用方输入分离。贡献按原始 instanceId、pinName 的 UTF-16 字典序排列，同实体 drive 在 pull 前。身份不 trim 或 Unicode normalize；输入数组顺序不影响合法结果或冲突现场。网络之间没有共享可变状态。

### 校验与冲突

完整快照先校验，门控关闭或模式未选中也不能隐藏非法保存意图：

- 模型仅接受 `kind: 'ideal-voltage'`。min/max 必须有限且 min <= max，允许负电压；low/high 必须在此范围内且 low <= high；就绪 voltageIntent 必须有限且在范围内。
- 未知字段/模型（包括电阻、阻抗字段）、枚举或类型错误、非有限数值抛 `TypeError`。显式 undefined 意图不等同于缺省字段。
- 合法数值超范围或范围倒置抛 `RangeError`。校验消息包含字段路径、值和约束。
- 每个引脚及其模型的字段各读取一次，校验后的值直接构成冻结的纯数据快照，后续求值只使用该快照。字段可由普通数据属性、getter 或原型提供，但快照不保留原型与访问器；未知的自身字段仍被拒绝。冲突错误的 `network` 与 `contributions` 同样按已知字段规范化，因此类 getter、非枚举自身属性和原型属性不会在复制时丢失。
- 驱动或偏置不相容时当次同步抛 `ElectricalConflictError`，无新增错误码。其 `network` 保存冻结完整输入现场，`contributions` 保存冻结贡献；构造签名为 `(network: ElectricalNetworkInput, contributions: readonly ElectricalContribution[])`。

**冲突不是浮空。** 本模块没有仿真循环，不能自行暂停整个仿真或提交效果。后续 #50 集成必须捕获冲突、暂停整个仿真并保留此前已提交效果；此处不宣称该接线已经完成。

## 浮空模拟取值

`createFloatingInput(seed: number, instanceId: string, pinName: string): FloatingInput` 为一个实体引脚建立独立状态，根入口同时导出 `FloatingInput` 与 `FloatingInputSample`。

```typescript
import { createFloatingInput } from '@mica-js/core';

const floating = createFloatingInput(12345, 'device-1', 'AIN');
floating.beginFloating(3.3);
const value = floating.sample(3.3, 100);
// { state: 'ready', voltage: ... }，物理网络仍然是 floating。
```

- `beginFloating(supplyVoltage?: number): void`：每次**实际进入新的物理浮空阶段**时调用，u32 阶段计数加一并回绕。供电已知且采样就绪时传入供电，立即初始化 V0；其余情况省略。
- `sample(supplyVoltage: number, timePs: number, enabled?: boolean): FloatingInputSample`：enabled 默认 true。启用时返回 `{ state: 'ready', voltage }`；false 时不校验供电/时间、不初始化/推进状态，返回 `{ state: 'disabled' }`，没有零电压占位。
- seed 为 u32。实例及引脚身份必须是非空原始字符串。供电为有限非负数。timePs 接受 number，严格校验为 [0, 7_200_000_000_000_000] 内的整数皮秒；不导入调度器类型或推进时间。非有限/非整数/类型错误抛 TypeError，越界抛 RangeError。未登记阶段就启用采样抛普通 Error。

严格采用 #24 的 `mica-floating-v2`：JSON + UTF-8 身份编码，FNV-1a 阶段种子（零替换为 1），xorshift32 初始电压，完整整数皮秒的 low/high 位经 mix32 决定 [-0.1, +0.1) V 噪声，最终限幅到当前 [0, VDD]。同阶段的 V0 固定；供电变化仅改变限幅，不重新缩放 V0。重复取值、观察者数量、其他引脚取值及事件执行序号不改变结果。networkId 不参与随机，拓扑合并/拆分不能将网络 ID 代替实体引脚身份。

**接线责任：** 调用方持续跟踪确定/浮空转换，即使采样门控关闭也逐次调用 beginFloating；不能按读取次数重建阶段。未初始化阶段恢复就绪时，必须在恢复的解析点调用 sample 完成 V0 初始化，不能推迟到首次业务读取。此对象不自动检测网络转换，也不产生事件；#50 的连接拓扑层负责按解析点登记与初始化。

## 拓扑与内部连接

`createTopologyRuntime(scheduler, definition, options)` 管理实例内部连接状态、外部导线输入和网络连通分量，并在合法控制阶段原子提交连接 patch 后只重算受影响网络。对应 [#50](https://github.com/x-botlab/mica-js/issues/50)，方向依据 [#14](https://github.com/x-botlab/mica-js/issues/14)；公共合同已[逐项批准](https://github.com/x-botlab/mica-js/issues/50#issuecomment-6324248869)。源码位于 `src/topology/`，与 `src/scheduler/`、`src/electrical/` 并列。

```typescript
import { createScheduler, createTopologyRuntime } from '@mica-js/core';

const scheduler = createScheduler();
const runtime = createTopologyRuntime(
  scheduler,
  {
    pins: [
      { instanceId: 'sw', pinName: 'A', kind: 'signal' },
      { instanceId: 'sw', pinName: 'B', kind: 'signal' },
      { instanceId: 'mcu', pinName: 'P0', kind: 'signal' },
    ],
    wires: [
      {
        wireId: 'w1',
        pins: [
          { instanceId: 'sw', pinName: 'B' },
          { instanceId: 'mcu', pinName: 'P0' },
        ],
      },
    ],
    connections: [{ instanceId: 'sw', connectionId: 'contact', pins: ['A', 'B'], initial: 'open' }],
  },
  {
    instanceId: 'topology',
    pinStates: [
      {
        instanceId: 'sw',
        pinName: 'A',
        powerReady: true,
        mode: 'high-z',
        outputEnabled: false,
        pull: 'none',
        model: {
          kind: 'ideal-voltage',
          minVoltage: 0,
          maxVoltage: 3.3,
          lowVoltage: 0,
          highVoltage: 3.3,
        },
      },
      // 其余声明引脚各一份已提交状态
    ],
    floating: { seed: 12345, supplyVoltage: () => 3.3 },
  },
);

runtime.submit({
  instanceId: 'sw',
  connections: [{ connectionId: 'contact', state: 'closed' }],
});
scheduler.start(); // 控制阶段整批提交并重算受影响网络
```

示例中的 `pinStates` 为节选；构造时会校验并拒绝缺失的声明引脚状态。

### 定义与连通分量

- `pins`：非空实例身份与引脚名、`signal/power/gnd` 类别；同一 `(instanceId, pinName)` 只能声明一次。
- `wires`：外部导线不可在运行期增删。每条导线把 `pins` 成员连成同一网络（成员团边），支持跨实例、环路与并行路径；`globalGnd: true` 表示该导线接显式全局 GND。
- `connections`：实例内部可控触点，端点必须是该实例已声明的两个互异引脚；`initial` 缺省 `open`，只允许 `open/closed`。
- 未被导线或闭合触点连接的引脚仍是单引脚网络。分量按导线与 `closed` 连接取并查集；合并、拆分、环及并行导通路径均按实际连通性处理。
- `networkId` 由分量内 UTF-16 字典序最小的 `(instanceId, pinName)` 生成，格式 `net:<instanceId>/<pinName>`，其中两段均把 `%` 转义为 `%25`、`/` 转义为 `%2F`；因此含 `/`、`%` 的原始身份不会碰撞，成员与网络排序固定。网络身份只用于诊断/查询，不参与浮空随机。
- `groundReady` 仅在分量同时含 `kind: 'gnd'` 引脚和 `globalGnd: true` 导线时为 true。电源域、阈值与门控仍属于后续能力。

### 原子 patch 与调度

- `submit` 在调用时整批校验并按值捕获：空列表、重复连接、未知实例/连接、非法状态或非法声明直接抛 `TypeError`/`RangeError`，不产生队列项、不改状态。
- 校验通过后向同一 scheduler 登记一个零参数 `control` 目标并入 FIFO 队列。每个 patch 对应一个控制入口，在控制阶段整批写入连接状态、重建分量并只重算受影响网络；同刻按提交顺序执行。
- 提交不表示已生效：普通入口内的 patch 在该入口返回后、下一普通入口前应用；控制入口内的 patch 进入后续控制轮次，不递归、不同步重入器件入口。全幂等 patch 是 no-op。
- `updatePinStates(states)` 以部分更新方式按值捕获引脚状态并入控制队列；`refresh(pins?)` 在供电/采样门控条件变化但引脚快照未变时请求解析点，缺省重算全部网络。两者都不立即修改可见拓扑。
- `connectionState`、`networks()`、`networkOf(pin)` 只返回已提交结果；`floatingInput(pin)` 返回该引脚的 #49 浮空对象。

### 电气求值与故障

每个网络按成员组装 `ElectricalNetworkInput` 调用 `resolveElectricalNetwork`，不复制驱动、偏置或浮空算法。驱动冲突时先保留已提交连接状态与新分量，受影响网络的 `result` 为 `undefined`，随后 `ElectricalConflictError` 逃出控制入口，由 scheduler 进入 `faulted`（`SchedulerError.code = 'execution-failed'`，`cause` 保存冲突现场）。已经提交的连接状态与此前效果不会回滚；如需恢复必须重建仿真。

scheduler 已处于 `faulted` 时，`runtime.destroy()` 会按调度器边界拒绝并抛 `scheduler-faulted`；该状态本来就不能继续运行，宿主应整体丢弃 runtime 与 scheduler，而不是依赖清理调用恢复。

### 浮空接线

启用 `floating` 后，每个引脚惰性建立独立 `createFloatingInput(seed, instanceId, pinName)`。网络每次从非浮空进入浮空即调用 `beginFloating`；供电阻断或采样门控关闭时省略供电参数，但阶段仍计数。仍为浮空且 V0 待初始化时，在该解析点若供电已知且采样启用则调用 `sample` 完成 V0 初始化并丢弃返回值；业务读取通过 `floatingInput(pin).sample(...)` 自行取值。网络合并/拆分不会重建阶段。

### 支持边界

连接拓扑层不解析原理图、不实现 IR `connection.apply` 指令、作者 JS API 或外部导线运行期增删；它只消费宿主已提交的引脚快照与静态外部导线。电源域、阈值、就绪与引脚门控由其上的 `src/power/` 组合，拓扑本身不计算域状态。

## 电源域与引脚门控

`createPowerRuntime(scheduler, definition, options)` 在 #50 拓扑层之上实现 #13 的电源域供电/接地条件、迟滞就绪状态、引脚驱动/采样门控与器件通知。对应 [#51](https://github.com/x-botlab/mica-js/issues/51)，公共合同已[逐项批准](https://github.com/x-botlab/mica-js/issues/51#issuecomment-6338138144)，依赖批量计算与收敛补充见[批准记录](https://github.com/x-botlab/mica-js/issues/51#issuecomment-6338170525)。源码位于 `src/power/`，与 `src/topology/`、`src/electrical/`、`src/scheduler/` 并列。

```typescript
import { createPowerRuntime, createScheduler } from '@mica-js/core';

const scheduler = createScheduler();
const power = createPowerRuntime(
  scheduler,
  {
    topology: {
      pins: [
        { instanceId: 'psu', pinName: 'VCC', kind: 'power' },
        { instanceId: 'psu', pinName: 'GND', kind: 'gnd' },
        { instanceId: 'mcu', pinName: 'VDD', kind: 'power' },
        { instanceId: 'mcu', pinName: 'GND', kind: 'gnd' },
        { instanceId: 'mcu', pinName: 'P0', kind: 'signal' },
      ],
      wires: [
        {
          wireId: 'vcc',
          pins: [
            { instanceId: 'psu', pinName: 'VCC' },
            { instanceId: 'mcu', pinName: 'VDD' },
          ],
        },
        {
          wireId: 'gnd',
          pins: [
            { instanceId: 'psu', pinName: 'GND' },
            { instanceId: 'mcu', pinName: 'GND' },
          ],
          globalGnd: true,
        },
      ],
      connections: [],
    },
    devices: [
      {
        instanceId: 'mcu',
        powerDomains: {
          core: { supply: 'VDD', ground: 'GND', voltage: { turnOn: 3, turnOff: 2 } },
        },
        pins: { P0: { powerDomain: 'core', levels: { low: 0.3, high: 0.7 } } },
      },
    ],
  },
  {
    instanceId: 'power',
    pinStates: [
      {
        instanceId: 'psu',
        pinName: 'VCC',
        powerReady: true,
        mode: 'analog',
        outputEnabled: true,
        voltageIntent: 5,
        model: {
          kind: 'ideal-voltage',
          minVoltage: 0,
          maxVoltage: 5,
          lowVoltage: 0,
          highVoltage: 5,
        },
      },
      // 其余 4 个声明引脚各一份完整 ElectricalPinInput；域引脚初始由运行时关闭。
    ],
    observer: {
      onPowerDomainChange(changes, snapshot) {
        // 公共控制阶段通知；此处只能入队，不能同步重入器件入口
      },
    },
  },
);

scheduler.start(); // 初始化域、通知 off→on、恢复门控并继续网络解析
```

### 声明与静态校验

- `PowerDefinition.topology` 即 #50 定义；`devices` 按实例声明 `powerDomains` 与信号引脚绑定。域 ID 在器件内稳定、唯一、大小写敏感。
- `supply`/`ground` 必须是同一实例的 `power`/`gnd` 引脚；`turnOn > turnOff >= 0` 且均为有限数；`dependsOn` 仅引用同一器件域、唯一、无自依赖且必须无环。
- `pins.<id>.powerDomain` 仅用于 `signal` 引脚；`levels` 必须与 `powerDomain` 同时提供，且 `0 <= low < high <= 1`。
- 未知字段/类型/枚举/非有限数值抛 `TypeError`；越界、引用缺失、kind 不匹配或依赖环抛 `RangeError`。定义按值只读取一次，快照直接交给 #50。

### 域状态、迟滞与接地

每个域维护 `{ state, voltage, groundReady, dependenciesReady }`。`groundReady` 由 `ground` 引脚所在分量是否接入显式全局 GND 网络决定；全局 GND 固定 0 V。接地就绪且 supply 网络为确定驱动电压时 `voltage` 取该电压；接地失效或供电待确定时 `voltage === null` 且域为 `off`。依赖关闭不把 `voltage` 置 null。

状态按 #13 优先级计算：接地未就绪 / 电压为 null / 任一依赖 off → `off`；`voltage <= turnOff` → `off`；`voltage >= turnOn` → `on`；迟滞区间保持原状态。边界含等号。同一批网络/供电更新只读取一次已提交拓扑快照，全部域按依赖拓扑顺序一次求值后统一应用门控。下电原因保留 `ground-not-ready`/`supply-indeterminate`/`dependency-off`/`below-turn-off`。

### 门控、持有意图与实际网络

- 绑定域的 signal 引脚由运行时拥有 `powerReady`，宿主提交的该字段被忽略。域 `off` 时提交 `powerReady: false`，由 #49 释放主动驱动与内部上下拉；配置和两类输出意图继续保存。域 `on` 时以最新持有意图提交 `powerReady: true` 恢复驱动。
- `pinIntent(pin)` 返回最后提交的持有意图，`networkOf(pin)` 返回实际网络结果，两者分离。无域绑定引脚沿用宿主 `powerReady`。
- 上电时先完成观察者通知，再把门控更新排入后续 topology 控制轮次；在后续解析完成前 `pinGate(pin).ready === false`（`opening`）。域 off 为 `domain-off`，无域为 `no-domain`，就绪为 `powered`。
- `submit/updatePinStates/refresh` 都在公共控制阶段提交，不在调用中同步重入器件；引脚更新先整批校验，失败时不部分写入。

### 数字输入与采样

- 有 `levels` 的引脚按当前域电压取 `low * V_D`/`high * V_D` 门限；无 `levels` 的引脚使用已提交引脚 model 的绝对 `lowVoltage/highVoltage`（#24 器件电气模型规则）。
- 默认三态：`<= low` 为 0，`>= high` 为 1，区间返回该引脚的逻辑记忆并标记 `threshold-range`；可选 `two-state` 以 `high` 为唯一分界。逻辑记忆初值 0，只有确定低/高（以及二态判定）更新。
- 解释只在已提交的 topology 快照与引脚模型一致时执行；排队的引脚更新由后续解析点解释，不会用未提交网络写入逻辑记忆。采样读取该解析结果。
- 门控采样数字返回 `{ value: 0, ready: false, source: 'gated' }`，模拟返回 `{ voltage: +0, ready: false, source: 'gated' }`；浮空数字返回 0 且 `source: 'floating'`，逻辑记忆保持不变。
- 浮空模拟通过 #50 `floatingInput(pin).sample(V_D, scheduler.now)` 取得 `mica-floating-v2` 合成值；未配置 `floating.seed` 时明确拒绝。无域绑定的浮空模拟引脚以引脚 model 的 `maxVoltage` 作为供电上限。
- 采样 power/gnd 引脚明确抛 `RangeError`。ADC 量化、滤波、PWM 平均等器件行为仍由器件模型表达。

### 数字引脚变化观察

- `power.addDigitalPinObserver(observer)` 注册变化观察者，返回幂等 disposer；可同时注册多个，按注册顺序调用。`destroy()` 清除全部观察者，之后注册明确拒绝。
- 每次完成电气解析阶段后同步通知一次，只包含 `(value, ready, source)` 发生变化的 signal 引脚，按 `TopologyDefinition.pins` 的声明顺序稳定排列；内部按 `(instanceId, pinName)` 排序的查找/更新列表不改变该通知顺序。没有变化时不调用。
- 通知不重放当前值；当前状态继续用 `sampleDigital` 读取。回调只能入队或读取，不得同步重入器件入口。
- 观察者异常采用 fail-fast：立即停止后续观察者通知并向当前 scheduler 入口传播；此前观察者已经入队的消息不回滚。
- 该接口不改变 #51 已批准的 `observe(observer)` 电源域通知；域门控变化表现为 `ready`/`source` 变化，供 #56 观察层重建基线。

### 通知顺序、控制阶段与预算

- 每批变化只回调一次 `PowerDomainObserver.onPowerDomainChange(changes, snapshot)`。先全部下电、再全部上电；下电依赖方优先（深度降序），上电前置域优先（深度升序）；同级按域 ID、跨实例按实例 ID 的 UTF-16 字典序。完整快照按 `(instanceId, domainId)` 排序。
- 普通入口返回后、下一普通入口前：topology 控制阶段提交网络/引脚并解析；power 控制阶段计算域状态、释放下电域、通知、开放上电域并继续后续网络解析。观察者回调中只能入队；不会同步重入器件入口。
- 通知命令在真正执行时按最新已提交域快照重新计算变化；同一批次内被后续拓扑或引脚更新覆盖的中间状态不会重复通知，`previousState`、`reasons`、`changes` 与 `snapshot` 来自同一时刻。上电域即使在批内经历 off→on 也会重新施加最新持有意图。
- 同一虚拟时间最多 `maxPropagationRounds`（默认 10000）个 power 传播入口。超限从控制入口抛 `PowerFeedbackError`（含 `timePs`、`rounds`、`maxRounds`、完整域快照），scheduler 进入 `faulted`（`SchedulerError.code === 'execution-failed'`，`cause` 为 `PowerFeedbackError`），已提交状态与意图不被静默丢弃。
- `destroy()` 清除观察者引用；destroy 后调用 `observe` 会抛错。与拓扑层一致，scheduler 已处于 `faulted` 时 `destroy()` 会按调度器边界拒绝并抛 `scheduler-faulted`；宿主应整体丢弃 power runtime 与 scheduler，而不是依赖清理调用恢复。

### 支持边界

本层不实现 #55 的 IR `pin.*` 指令与标量布局、#56 的观察投递、UART/SPI/I²C 等协议、JIT、掉电后的器件寄存器/Flash/reset 语义，也不实现连续电路、电阻、阻抗或负载求解。器件内部的状态保留、复位、通信状态机与业务就绪仍由器件 IR/模型表达；本层只提供域状态、门控、输入解释和通知接口。

## 支持边界与验证

此实现只支持理想强电压与弱偏置的贡献解析，不支持连续电路求解、电阻、阻抗、负载或积分。电气模块自身不实现拓扑提交、电源生命周期、事件调度或 IR 领域指令接线，也不导入调度器；时间与调度由同包 `src/scheduler/` 提供，连接拓扑由 `src/topology/` 组合两者。

在仓库根目录运行：

```powershell
pnpm --filter @mica-js/core test
pnpm --filter @mica-js/core typecheck
pnpm --filter @mica-js/core build
```

Vitest 覆盖公共组合矩阵、释放/门控/readiness、冲突/浮空、f64 电压边界、冻结故障现场、顺序/网络隔离、v2 重放向量、独立 BigInt 算法对照、时间高位、供电限幅、门控阶段与恢复初始化；拓扑层覆盖连接环/并行路径、合并/拆分、GND、原子 patch、非法列表不部分提交、同刻顺序、反馈阶段、冲突不回滚、浮空登记/恢复及与时间推进的交互；电源层覆盖上电/欠压/掉电/失地及恢复、迟滞与依赖通知顺序、持有意图与实际网络分离、驱动/偏置/模拟释放与恢复、三态/二态门限与逻辑记忆、门控/浮空采样、控制阶段顺序、无同步重入、反馈预算诊断及定义/选项校验。TypeScript 检查根入口合同。测试直接调用生产求值函数、真实 topology 与 scheduler，不用构建或子进程冒充单元测试。

## 开发

```bash
pnpm --filter @mica-js/core run test
pnpm --filter @mica-js/core run typecheck
pnpm --filter @mica-js/core run build
```

## 相关提案

- 原理图格式：[#6](https://github.com/x-botlab/mica-js/issues/6)
- 属性定义：[#7](https://github.com/x-botlab/mica-js/issues/7)
- 画布格式：[#67](https://github.com/x-botlab/mica-js/issues/67)
