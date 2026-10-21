# @mica/core

整数皮秒虚拟时间、确定性普通事件与公共控制调度，对应 [#48](https://github.com/x-botlab/mica-js/issues/48)。依据 [#23](https://github.com/x-botlab/mica-js/issues/23)、[#26](https://github.com/x-botlab/mica-js/issues/26)；已批准的公共合同及执行边界见 [调度合同](https://github.com/x-botlab/mica-js/issues/48#issuecomment-6322004590)、[IR 接入补充](https://github.com/x-botlab/mica-js/issues/48#issuecomment-6322166225) 和 [审批记录](https://github.com/x-botlab/mica-js/issues/48#issuecomment-6322233200)。唯一公共入口为 `@mica/core`，既有 `MICA_CORE_VERSION` 保留。

## 时间

- `TimePs` 是 `number` 品牌类型；`timePs(value)` 运行时验证并构造它。合法范围是 `0..MAX_TIME_PS`（含两端），`MAX_TIME_PS = 7_200_000_000_000_000`，即两小时。
- `toTimePs(value, unit)` 接受非负整数单位值，单位为 `ps/ns/us/ms/s`，系数依次为 `1/1_000/1_000_000/1_000_000_000/1_000_000_000_000`。
- `addTime(left, right)` 与 `subtractTime(later, earlier)` 检查全部输入及结果；负差、加法或换算越界拒绝。
- 类型非 `number`、非有限值或非整数先抛 `TypeError`，再对负值/超过上限抛 `RangeError`，不做隐式转换。`-0` 规范化为 `+0`。错误包含输入名、值与约束；时间以 JSON 整数数值精确往返。
- 普通 IR `f64` 仍可为非整数、NaN 或无穷；只有提交到时间接口时才按时间约束检查。

## 真实 IR 执行

`createIRSchedulerInstance(scheduler, { instanceId, module, validation })` 创建一份既有 `@mica/ir` 参考解释器及独立存储，将 `event.now/at/cancel` 接入**同一个**调度队列和 ID 分配器，不另造解释器或调度器。`validation` 的指令支持/授权与资源权限仍显式提供，不会自动放宽。

```ts
import { createIRModule } from '@mica/ir';
import { createIRSchedulerInstance, createScheduler } from '@mica/core';

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

`destroyInstance(handle)` 在入口边界停止输入并取消普通/控制待执行工作，不中断当前入口。实例身份永不复用，旧句柄不能转投新实例；不把 reset 当作 destroy。这里只处理时间/事件，不替领域资源执行电气传播或清理协议。

## 可信执行接入

低层 `addInstance({ instanceId, targets, executor })` 返回 `SchedulerInstance`（`instanceId/at/cancel`）。`SchedulerTarget` 声明 `name`、`kind: 'event' | 'control'`、`params: readonly ScalarType[]`；按登记对象身份接纳并固定元数据，不按名称匹配外来对象。后端收到不可变的目标视图。参数复用 `@mica/ir` 的 `RuntimeScalar`，不接受对象闭包或存储别名。

`SchedulerExecutor.execute(target, args, context): void` 是**可信内核后端合同，不是任意作者 JS 回调协议或安全沙箱**。`context` 提供 `instanceId/timePs/phase/eventId/remainingSteps`（控制 eventId 为 0）及 `consumeSteps(count = 1)`；后端必须在每个参考 IR 步骤效果提交前计数，包含普通同步调用及终结指令，不得以优化后机器指令数替代。它不能抢占任意 JS 死循环。拒绝 async/generator、Promise/thenable 结果及重入执行；可识别的异步函数在调用前拒绝，普通函数返回 Promise 前已提交的效果不回滚。

`enqueueControl(instance, target, args)` 仅是可信内核的控制入口；器件、Provider 无权自行创建控制工作。此接口不定义电气或其他领域的具体触发规则。

## 预算与故障

每入口参考步骤和同一虚拟时刻的入口次数（普通及控制合计）默认各为 **1,000,000**，可配置非负安全整数；0 禁止执行。入口次数跨暂停、步进和分段保留，只在时间真正变化时重置。超限在下一步骤/入口效果前暂停并诊断，不偷偷增加 1 ps。

IR 适配器通过 `stepObserver.beforeStep` 逐步连接 `consumeSteps`。其内部解释器 `maxSteps` 设为 `Number.MAX_SAFE_INTEGER`，实际预算由 scheduler 控制，避免独立解释器的默认一百万覆盖用户更高配置；独立解释器默认行为不变。

宿主边界输入失败无队列/ID 副作用，不污染仿真。入口内模型错误使整个 scheduler `faulted`，保留此前已提交状态、已安排队列及失败入口占用的 ID，不继续执行其他实例；后端捕获错误也不能清除全局故障。不支持入口中途恢复或检查点恢复，必须重建/合法重放。`pause()` 不清除故障。

时间错误仍是 `TypeError/RangeError`；执行时包装为 `SchedulerError` 并保留 `cause`。其只读字段包括 `code/instanceId/targetName/timePs/phase/eventId/steps/entriesAtTime/cause`；IR 原始错误、调用链与位置留在 cause。

`SchedulerErrorCode` 为：`invalid-options`、`invalid-instance`、`invalid-target`、`invalid-argument`、`invalid-event-id`、`event-id-exhausted`、`reentrant-execution`、`executor-contract`、`entry-budget-exhausted`、`time-budget-exhausted`、`execution-failed`、`scheduler-faulted`。

## 验证与边界

使用现有 Vitest/TypeScript/Vite/ESLint/Prettier。测试直接执行调度及真实 IR 的状态/数组效果，覆盖时间边界、A/C/B、A/P/C、值捕获、取消/复用/旧项隔离、分段确定性、长反馈、预算/异常及前序效果保留。没有用构建、子进程或临时消费者作为单测。core 将 `@mica/ir` 保留为构建外部依赖，避免复制其引用符号/解释器身份。

```powershell
pnpm --filter @mica/ir build
pnpm --filter @mica/core test
pnpm --filter @mica/core typecheck
pnpm --filter @mica/core build
```

不提供电气求值、器件作者回调协议、消息桥、Provider 缓存、JIT、I2C/SPI 协议库、持久化调度快照或墙钟运行器。未实现能力不会以空实现或仅记录指令冒充完成。
