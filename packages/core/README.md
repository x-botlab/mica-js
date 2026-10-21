# @mica-js/core

Mica 仿真内核（虚拟时间与确定性事件调度），并提供原理图 `.sch` 与画布 `.cnv` 的文档格式子路径。

## 安装

```bash
pnpm add @mica-js/core
```

## 入口

| 入口                      | 内容                                              |
| ------------------------- | ------------------------------------------------- |
| `@mica-js/core`           | 仿真内核（时间调度、电气网络求值、连接拓扑提交）  |
| `@mica-js/core/schematic` | 原理图 `.sch`：解析、拓扑推导、编辑命令与属性系统 |
| `@mica-js/core/canvas`    | 画布 `.cnv`：与 `.sch` 绑定的 2D 摆放（`layout`） |

文件合同：`.sch` 见 [#6](https://github.com/x-botlab/mica-js/issues/6)，`.cnv` 见 [#67](https://github.com/x-botlab/mica-js/issues/67)。

## 仿真调度

整数皮秒虚拟时间、确定性普通事件与公共控制调度，对应 [#48](https://github.com/x-botlab/mica-js/issues/48)。依据 [#23](https://github.com/x-botlab/mica-js/issues/23)、[#26](https://github.com/x-botlab/mica-js/issues/26)；已批准的公共合同及执行边界见 [调度合同](https://github.com/x-botlab/mica-js/issues/48#issuecomment-6322004590)、[IR 接入补充](https://github.com/x-botlab/mica-js/issues/48#issuecomment-6322166225) 和 [审批记录](https://github.com/x-botlab/mica-js/issues/48#issuecomment-6322233200)。上游发布命名及多入口集成已[另行批准](https://github.com/x-botlab/mica-js/issues/48#issuecomment-6322661335)。仿真 API 入口为 `@mica-js/core`，既有 `MICA_CORE_VERSION` 与原理图/画布子入口保留。

## 时间

- `TimePs` 是 `number` 品牌类型；`timePs(value)` 运行时验证并构造它。合法范围是 `0..MAX_TIME_PS`（含两端），`MAX_TIME_PS = 7_200_000_000_000_000`，即两小时。
- `toTimePs(value, unit)` 接受非负整数单位值，单位为 `ps/ns/us/ms/s`，系数依次为 `1/1_000/1_000_000/1_000_000_000/1_000_000_000_000`。
- `addTime(left, right)` 与 `subtractTime(later, earlier)` 检查全部输入及结果；负差、加法或换算越界拒绝。
- 类型非 `number`、非有限值或非整数先抛 `TypeError`，再对负值/超过上限抛 `RangeError`，不做隐式转换。`-0` 规范化为 `+0`。错误包含输入名、值与约束；时间以 JSON 整数数值精确往返。
- 普通 IR `f64` 仍可为非整数、NaN 或无穷；只有提交到时间接口时才按时间约束检查。

## 真实 IR 执行

`createIRSchedulerInstance(scheduler, { instanceId, module, validation })` 创建一份既有 `@mica-js/ir` 参考解释器及独立存储，将 `event.now/at/cancel` 接入**同一个**调度队列和 ID 分配器，不另造解释器或调度器。`validation` 的指令支持/授权与资源权限仍显式提供，不会自动放宽。

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

适配器返回只读 `instance: SchedulerInstance`、`storage: IRStorage`，以及 `at(EntryRef, deadline, args): number`、`cancel(id): void`、`enqueueControl(LifecycleRef, args): void`。生命周期不能用 `at` 提升优先级；控制接入仅供可信内核，不向器件开放创建特权工作能力。销毁使用 `scheduler.destroyInstance(instance.instance)`。

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

`destroyInstance(handle)` 在入口边界停止输入并取消普通/控制待执行工作，不中断当前入口。销毁完成后调度器删除该实例的内部记录，并从队列清除其待执行项，释放 target、executor 及（IR 适配器）解释器与存储引用，反复创建/销毁不再累积；被取消的队列项即使调度器不再驱动也不会保留引用。实例身份与 ID 编号空间仍永久保留、不复用，外部保留的旧句柄只能得到 `invalid-instance`；不把 reset 当作 destroy。这里只处理时间/事件，不替领域资源执行电气传播或清理协议。

## 可信执行接入

低层 `addInstance({ instanceId, targets, executor })` 返回 `SchedulerInstance`（`instanceId/at/cancel`）。`SchedulerTarget` 声明 `name`、`kind: 'event' | 'control'`、`params: readonly ScalarType[]`；按登记对象身份接纳并固定元数据，不按名称匹配外来对象。后端收到不可变的目标视图。参数复用 `@mica-js/ir` 的 `RuntimeScalar`，不接受对象闭包或存储别名。

`SchedulerExecutor.execute(target, args, context): void` 是**可信内核后端合同，不是任意作者 JS 回调协议或安全沙箱**。`context` 提供 `instanceId/timePs/phase/eventId/remainingSteps`（控制 eventId 为 0）及 `consumeSteps(count = 1)`；后端必须在每个参考 IR 步骤效果提交前计数，包含普通同步调用及终结指令，不得以优化后机器指令数替代。它不能抢占任意 JS 死循环。拒绝 async/generator、Promise/thenable 结果及重入执行；可识别的异步函数在调用前拒绝，普通函数返回 Promise 前已提交的效果不回滚。

`enqueueControl(instance, target, args)` 仅是可信内核的控制入口；器件、Provider 无权自行创建控制工作。此接口不定义电气或其他领域的具体触发规则。

## 预算与故障

每入口参考步骤和同一虚拟时刻的入口次数（普通及控制合计）默认各为 **1,000,000**，可配置非负安全整数；0 禁止执行。入口次数跨暂停、步进和分段保留，只在时间真正变化时重置。超限在下一步骤/入口效果前暂停并诊断，不偷偷增加 1 ps。

IR 适配器通过 `stepObserver.beforeStep` 逐步连接 `consumeSteps`。其内部解释器 `maxSteps` 设为 `Number.MAX_SAFE_INTEGER`，实际预算由 scheduler 控制，避免独立解释器的默认一百万覆盖用户更高配置；独立解释器默认行为不变。

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

不提供电气求值、器件作者回调协议、消息桥、Provider 缓存、JIT、I2C/SPI 协议库、持久化调度快照或墙钟运行器。未实现能力不会以空实现或仅记录指令冒充完成。

## 原理图（`./schematic`）

```ts
import { loadSchematic, parseSchematic, serializeSchematic } from '@mica-js/core/schematic';

const loaded = loadSchematic(text, { devices }); // { document, topology }
const document = parseSchematic(text); // 解析 + 校验，失败抛 SchematicError
serializeSchematic(document); // 固定字段顺序的 .sch JSON
```

- 文件名即原理图标识，顶层没有 `id`；`symbols` / `wires` / `junctions` 使用不透明的稳定 `id`。
- 拓扑按位号、网名与连接关系合并网络；纯绘图分量保留为几何数据。
- 编辑命令、undo/redo、命中测试、导线段拖动与交点合并都是纯函数，编辑器只做编排。
- `createDeviceRegistry` 把器件的 `designatorPrefix` 与引脚声明合成为符号几何与位号。
- 属性（#7）：`string` / `number` / `integer` / `boolean` / `enum` / `color` / `image` / `binary`；`image` / `binary` 的值是资源引用 `{ src, mode }`（`file` 为工程根相对路径，`inline` 为 base64，`store` 为宿主资源标识）。

## 画布（`./canvas`）

```ts
import { loadCanvas, parseCanvas, serializeCanvas } from '@mica-js/core/canvas';

const canvas = parseCanvas(text); // version / id / schematic / layout
const { placements } = loadCanvas(canvas, { schematic: document }); // layout 键须属于该 .sch
serializeCanvas(canvas);
```

`layout` 以 symbol 的稳定 `id` 为键，值为 `{ x, y, rotation }`；引用绑定原理图中不存在的实例时报 `canvas/unknown-symbol`。原理图编辑器不依赖这个入口。

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

### 浮空接线

启用 `floating` 后，每个引脚惰性建立独立 `createFloatingInput(seed, instanceId, pinName)`。网络每次从非浮空进入浮空即调用 `beginFloating`；供电阻断或采样门控关闭时省略供电参数，但阶段仍计数。仍为浮空且 V0 待初始化时，在该解析点若供电已知且采样启用则调用 `sample` 完成 V0 初始化并丢弃返回值；业务读取通过 `floatingInput(pin).sample(...)` 自行取值。网络合并/拆分不会重建阶段。

### 支持边界

连接拓扑层不解析原理图、不实现 IR `connection.apply` 指令、作者 JS API、外部导线运行期增删、#51 电源域/门控或协议；它只消费宿主已提交的引脚快照与静态外部导线。

## 支持边界与验证

此实现只支持理想强电压与弱偏置的贡献解析，不支持连续电路求解、电阻、阻抗、负载或积分。电气模块自身不实现拓扑提交、电源生命周期、事件调度或 IR 领域指令接线，也不导入调度器；时间与调度由同包 `src/scheduler/` 提供，连接拓扑由 `src/topology/` 组合两者。

在仓库根目录运行：

```powershell
pnpm --filter @mica-js/core test
pnpm --filter @mica-js/core typecheck
pnpm --filter @mica-js/core build
```

Vitest 覆盖公共组合矩阵、释放/门控/readiness、冲突/浮空、f64 电压边界、冻结故障现场、顺序/网络隔离、v2 重放向量、独立 BigInt 算法对照、时间高位、供电限幅、门控阶段与恢复初始化；拓扑层覆盖连接环/并行路径、合并/拆分、GND、原子 patch、非法列表不部分提交、同刻顺序、反馈阶段、冲突不回滚、浮空登记/恢复及与时间推进的交互。TypeScript 检查根入口合同。测试直接调用生产求值函数与真实 scheduler，不用构建或子进程冒充单元测试。

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
