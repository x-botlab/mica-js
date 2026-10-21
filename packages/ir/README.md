# @mica-js/ir

领域无关的 IR 数据模型、同步类型化建图器、静态校验/链接诊断、整数/布尔/浮点逐指令语义、实例存储与参考解释器。

本包负责**建图、实例存储、静态校验与参考执行**：声明标量资源与函数、构造 SSA 值、基本块与终结指令，为每个实例建立独立存储，并通过 `validateIR` 检查内存模型、控制流与能力策略。不提供事件调度、Provider 生成缓存、运行中恢复、消息桥接或 JIT；校验通过不代表已经执行，未实现的能力显式拒绝，不以空操作伪装成功。

## 安装

```bash
pnpm add @mica-js/ir
```

## 公共入口

唯一公开入口为 `@mica-js/ir`，构建生成 `dist/index.js`（ESM）与声明文件。

| 导出                                          | 作用                                                                                                       |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `createIRModule()`                            | 创建独立的模块声明/建图上下文，返回 `IRModule`                                                             |
| `createIRStorage(module, options?)`           | 为声明资源创建一份独立实例存储；`updateResources` 显式授予字节更新权限，默认无授权                         |
| `createIRInterpreter(module, options)`        | 创建经快照与校验的参考解释器，拥有独立 `storage`                                                           |
| `validateIR(input, options)`                  | 返回 `IRValidationResult`，通过 `IRDiagnostic` / `IRDiagnosticLocation` 报告静态错误                       |
| `evaluateScalarInstruction(instruction, ops)` | 求值单个整数/布尔节点，失败抛 `IRScalarEvaluationError`                                                    |
| `evaluateFloatInstruction(instruction, ops)`  | 求值单个浮点节点，失败抛 `IRFloatEvaluationError`                                                          |
| 类型                                          | `IRDeclarations`、`FunctionBuilder<R>`、`IRModule`、`FunctionRef` / `EntryRef` / `LifecycleRef` 等引用类别 |

`StateRef`、`ArrayRef`、`BytesRef`、`InboxRef` 不可互换；`EntryRef`、`LifecycleRef` 与普通 `FunctionRef` 在类型和运行期都保持独立。

## 建图

```ts
import { createIRModule } from '@mica-js/ir';

const ir = createIRModule();
const count = ir.state('count', 'u32', 0);

const add = ir.func('add', { params: ['u32', 'u32'], results: ['u32'] });
add.body((b, [left, right]) => b.return([b.int.add(left, right)]));

const run = ir.entry('run', ['u32']);
run.body((b, [value]) => {
  const [sum] = b.call(add, [value, b.const('u32', 1)]);
  b.state.store(count, sum);
  b.return([]);
});
```

- 函数先通过 `ir.func` / `ir.entry` / `ir.lifecycle` 声明引用，再用一次 `.body(callback)` 定义函数体；`.body` 同步执行，async/generator 回调在调用前即被拒绝，普通函数返回 Promise 也会同步拒绝。
- 普通函数通过 `b.call(target, args)` 同步调用，结果始终按列表返回（零/单/多结果）；入口与生命周期没有普通返回值，也不能被 `call`。
- 基本块：`b.block(types)` 只创建目标块，`b.at(block, callback)` 才进入该块并在回调后恢复插入位置。每个块必须以 `return` / `jump` / `branch` / `trap` 终结；回调抛错、返回 Promise 或未终结都会使整个函数构建失效，需重新 `.body`。
- 块参数是循环与合流的唯一显式传值方式，不提供隐式 phi 或可变局部变量。
- `GeneratedFunctionBuilder<R>` 目前只保留继承边界：Provider 工厂、`checkpoint` 与 `dispatch` 属于后续任务。

```ts
const choose = ir.func('choose', { params: ['bool'], results: ['u32'] });
choose.body((b, [condition]) => {
  const yes = b.block([]);
  const no = b.block([]);
  const join = b.block(['u32']);
  b.branch(condition, { target: yes, args: [] }, { target: no, args: [] });
  b.at(yes, (inner) => inner.jump(join, [inner.const('u32', 1)]));
  b.at(no, (inner) => inner.jump(join, [inner.const('u32', 2)]));
  b.at(join, (inner, [result]) => inner.return([result]));
});
```

### 统一内存模型

状态、数组、字节区与输入槽位共用 `MemoryDefinition`（`module.memories`）：

- `kind` 区分 `state`、`array`、`bytes`、`inbox`。
- `state` / `array`：`layout.kind: 'scalar'`，固定元素类型与长度（状态长度为 1）。
- `bytes` / `inbox`：`layout.kind: 'bytes'`，固定字节容量，`unitBytes` 记录版本单元粒度。
- `bytes` 的 `readonly` 只限制普通 `bytes.store` / `bytes.copy`；`inbox` 只能读取。
- 声明初值会被复制，整数越界或 bool/数值混用会被拒绝。

### 领域扩展

领域模块可在自己的包中声明静态句柄与显式指令，核心不导入引脚、电源等域类型：

```ts
const led = ir.domainDeclaration('led', 'status');
const setLed = ir.domainInstruction('led.set', {
  operands: [
    { kind: 'static', category: 'led' },
    { kind: 'value', type: 'bool' },
  ],
  results: [],
});

ir.entry('enable', ['bool']).body((b, [on]) => {
  b.invoke(setLed, [led, on]);
  b.return([]);
});
```

`invoke` 只生成已声明的显式指令，并校验操作数类别、标量类型与结果布局；不提供 `call(hostFunction)` 或任意运行期 JS 回调扩展。

## 实例存储

```ts
import { createIRModule, createIRStorage } from '@mica-js/ir';

const ir = createIRModule();
const counter = ir.state('counter', 'u32', 0);
const ram = ir.bytes('ram', new Uint8Array(16), { readonly: false });
const input = ir.inbox('input', 8);

const storage = createIRStorage(ir);
storage.storeState(counter, 1);
storage.storeBytes('u16', 'little', ram, 1, 0x1234);
storage.copy(ram, 4, input, 0, 8);
```

- 索引、偏移与长度按 u32 检查；多字节访问先验证完整范围，非对齐访问合法。
- 单次操作先完成类别、权限、范围与值校验再提交字节，失败不留部分写入；此前成功的写入不回滚。
- `bytes.copy` 先取源快照，同资源重叠复制按复制前取值；零长度仍校验端点与目标可写。
- 每次 `createIRStorage` 都从声明初值复制独立 buffer，实例、声明与输入 `Uint8Array` 之间互不别名。
- 普通 `store` / `copy` 只改内容、不改版本；版本化更新需独立授权（见下）。
- `state.load` / `array.load` / `bytes.load` 返回 `StorageValue<T>`：`bool` 为 `boolean`、整数为 `number`、浮点为 `FloatBits` 原始位模式。
- 失败抛 `IRStorageError`，`code` 为 `invalid-resource`、`invalid-value`、`invalid-argument`、`out-of-bounds`、`readonly-resource`、`unauthorized-resource` 或 `allocation-failure`。`validateIR` 负责静态核验，存储负责运行期检查，二者互不替代。

## 逐指令求值

`evaluateScalarInstruction(instruction, operands)` 消费建图器/内存模型的节点，不引入另一套指令类型；`operands` 按 SSA 操作数出现顺序提供已求值标量（literal 不占位）。不写回 SSA、不访问存储、不执行控制流。

```ts
import { createIRModule, evaluateScalarInstruction } from '@mica-js/ir';

const ir = createIRModule();
ir.func('multiply', { params: ['u32', 'u32'], results: ['u32'] }).body((b, [a, c]) =>
  b.return([b.int.mul(a, c)]),
);
const multiply = ir.functions[0]!.body!.entry.instructions[0]!;
evaluateScalarInstruction(multiply, [4294967295, 4294967295]); // 1
```

- 支持 `u8/i8/u16/i16/u32/i32` 的 `int.add/sub/mul/div/rem/and/or/xor/not`、`int.cmp` 全部 predicate、`int.shl/lshr/ashr` 及 `int.zext/sext/trunc/reinterpret`；`bool.not/and/or/xor`、`const`、`select`。
- 加减乘与有符号商溢出按位宽回绕；除法向零截断；除零/取余零报错。
- 移位数严格为 `u32`，不对位宽取模；`count >= width` 时左移/逻辑右移为零，算术右移按符号填充。
- 内部使用精确 `bigint` 与显式定宽归一化，避免 JS 位运算的 32 位截断；公开标量仍为 `number | boolean`。
- 失败抛 `IRScalarEvaluationError`：`unsupported-instruction`、`invalid-instruction`、`invalid-operand`、`division-by-zero`。

### 浮点

`evaluateFloatInstruction(instruction, operands)` 复用同一指令模型，只求值单个节点：

- `FloatBits = { type; bits }` 保存原始位（f32 8 位、f64 16 位十六进制，`0x` 前缀）；`RuntimeScalar = boolean | number | FloatBits`。
- 支持 `const` / `const.bits` / `select`、`float.add/sub/mul/div/fma/cmp/isNaN/isFinite`、`convert.intToFloat/floatToInt/float` 及 f32/64 与 u32/i32 间的 `bitcast`。
- 内部用无依赖 BigInt 精确计算，按目标精度最近值、居中取偶数舍入；FMA 不舍入中间乘积，保留次正规数与有符号零。
- 算术与精度转换产生的 NaN 规范为 `0x7fc00000` / `0x7ff8000000000000`；`const.bits`、`select` 与 bitcast 保留原始位。
- 浮点输出始终为 `FloatBits`；需要保留 NaN 载荷/符号位时必须传 `FloatBits`，不要经 JS number 往返。
- 失败抛 `IRFloatEvaluationError`：`integer-overflow`、`invalid-instruction`、`invalid-operand`、`unsupported-operation`。

```ts
import { createIRModule, evaluateFloatInstruction } from '@mica-js/ir';

const module = createIRModule();
module
  .func('fused', { params: ['f32', 'f32', 'f32'], results: ['f32'] })
  .body((b, [a, c, d]) => b.return([b.float.fma(a, c, d)]));
const instruction = module.functions[0]!.body!.entry.instructions[0]!;
evaluateFloatInstruction(instruction, [1 + 2 ** -23, 1 - 2 ** -23, -1]);
// { type: 'f32', bits: '0xa8800000' }，即 -2^-46；非融合结果为正零。
```

## 静态校验

`validateIR(input, options)` 是统一静态检查入口：`input` 需具备 `memories`、`functions`、`domainDeclarations`、`instructions` 四个列表（可直接传 `IRModule`）。它校验当前表示，不调用建图方法，也不以 builder 的隐藏记录替代检查。

```ts
import { createIRModule, validateIR } from '@mica-js/ir';

const ir = createIRModule();
const count = ir.state('count', 'u32', 0);
ir.entry('run', []).body((b) => {
  b.state.store(count, b.const('u32', 1));
  b.return([]);
});

const result = validateIR(ir, {
  supportedInstructions: ['const', 'state.store', 'return'],
  authorizedInstructions: ['const', 'state.store', 'return'],
  resources: [{ ref: count, access: 'write' }],
});
// result.ok；否则读 result.diagnostics。
```

策略必须由可信宿主提供，不应采信客体自称的能力：

- `supportedInstructions`（后端支持）与 `authorizedInstructions`（实例获准）精确匹配，且必须包含所用的终结名；没有默认全支持、通配符或自动授权。
- `resources` 按句柄身份授予 `read` / `write` / `read-write` / `update`。
- 领域扩展的静态声明与指令也在此校验。

## 参考解释器

```ts
import { createIRInterpreter, createIRModule } from '@mica-js/ir';

const module = createIRModule();
const count = module.state('count', 'u32', 0);
const increment = module.func('increment', { params: ['u32'], results: ['u32'] });
increment.body((b, [delta]) => {
  const next = b.int.add(b.state.load(count), delta);
  b.state.store(count, next);
  b.return([next]);
});

const runtime = createIRInterpreter(module, {
  validation: {
    supportedInstructions: ['state.load', 'int.add', 'state.store', 'return'],
    authorizedInstructions: ['state.load', 'int.add', 'state.store', 'return'],
    resources: [{ ref: count, access: 'read-write' }],
  },
  maxSteps: 1_000_000,
});
const result = runtime.execute(increment, [3], { instanceId: 'counter', virtualTime: 1000 });
// { values: [3], steps: 4 }
runtime.storage.loadState(count); // 3
```

- `createIRInterpreter` 捕获私有执行快照，调用 `validateIR`，再用 `createIRStorage` 建独占存储；原模型后续修改不影响已创建的实例。
- `IRInterpreterOptions` 包含必填 `validation: IRValidationOptions` 和可选 `maxSteps: number`、`eventHost: IREventHost`、`stepObserver: IRStepObserver`；API 面向可信宿主，不是隔离恶意 JS getter/validator 的沙箱。
- `execute(target, args, context)` 同步执行 `FunctionRef` / `EntryRef` / `LifecycleRef`，返回 `{ values, steps }`。`context = { instanceId, virtualTime }` 必填：实例标识非空，虚拟时间为非负安全整数皮秒，仅用于诊断。
- 存储跨成功执行保留；每次 `execute` 使用独立预算。普通调用和块跳转不推进虚拟时间、不创建事件、不形成等待/恢复对象；显式 event 指令通过下述可信宿主桥接。

### 确定预算

- `maxSteps` 默认 1,000,000，必须是非负安全整数；`0` 在首步前拒绝。
- 每条规范化指令与终结符各计一步；参数绑定与调用帧不计费，未选中的分支不计。
- 普通调用共享顶层 `execute` 的剩余预算，先检查再开始下一步；`steps` 计已开始步骤（故障步骤计入，被预算拦截的不计入）。

### 错误与提交

`IRExecutionError` 暴露 `code`、`context`、`location`、`callStack`、`steps`、`diagnostics`、`cause`。`location` 含 `functionIndex`、`blockIndex`、`instructionIndex?` 与名称；`callStack` 由外到内排列。

| `IRExecutionErrorCode`    | 含义                             |
| ------------------------- | -------------------------------- |
| `invalid-options`         | 非法解释器配置/预算              |
| `validation-failed`       | 模型或显式策略未通过静态校验     |
| `invalid-target`          | 顶层目标不属于此解释器的模块快照 |
| `invalid-argument`        | 执行前实参或上下文非法           |
| `budget-exhausted`        | 下一步骤超出预算                 |
| `trap`                    | 模型显式终结异常                 |
| `evaluation-failed`       | 单节点运算失败                   |
| `storage-failed`          | 存储分配或访问失败               |
| `unsupported-instruction` | 静态扩展合法但没有执行实现       |
| `instance-faulted`        | 实例此前已发生故障，不允许再执行 |

- 存储操作沿用完整范围校验与原子提交：失败操作无部分写入，已提交效果不回滚。
- 预算、求值、存储或 trap 故障会锁定实例，后续 `execute` 抛 `instance-faulted`；无 reset/resume，也不支持失败入口中途恢复。
- 非法目标、参数或 context 等调用前错误不消耗步骤、不锁定实例。
- 执行能力限于现有整数/布尔/浮点/存储指令、`resource.update_bytes` / `resource.fill_bytes`、核心 `event.now/at/cancel`、普通 `call` 及 `return/jump/branch/trap`；扩展静态校验通过也不会自动获得执行实现。未实现领域指令在执行前拒绝；dispatch、Provider/checkpoint 与其他保留能力仍静态拒绝。

### 事件与宿主桥接（#48）

`FunctionBuilder.event: EventOperations` provides core operations (also inherited by `GeneratedFunctionBuilder`):

```ts
interface EventOperations {
  now(): Value<'f64'>;
  at<const P extends readonly ScalarType[]>(
    target: EntryRef<P>,
    deadline: Value<'f64'>,
    args: Values<NoInfer<P>>,
  ): Value<'u32'>;
  cancel(id: Value<'u32'>): void;
}
interface IREventHost {
  now(): number;
  at(target: EntryRef, deadline: number, args: readonly RuntimeScalar[]): number;
  cancel(id: number): void;
}
interface IRStepObserver {
  beforeStep(context: IRExecutionContext): void;
}
```

`event.now` has no operands and returns f64; `event.at` encodes a static ordinary entry, an SSA f64 deadline, and SSA arguments, returning u32; `event.cancel` takes one SSA u32 and has no results. Targets must belong to the same module and match the entry parameter signature; lifecycle and ordinary function targets are rejected. These names cannot be redefined by domain declarations or extension validators. All three still require explicit supportedInstructions and authorizedInstructions grants.

The optional interpreter `eventHost` is a trusted synchronous scheduler bridge, not an arbitrary domain instruction executor. Every event node, including unreachable ones, requires a host at interpreter creation; otherwise `unsupported-instruction` includes its IR location. The interpreter does not import core. `event.now` validates host time; `event.at` validates the complete target, captures all scalar arguments by value (including exact FloatBits), decodes f64 deadlines using the existing IEEE representation, rejects past deadlines against host.now(), and checks the returned ID is a nonzero u32. `event.cancel` validates u32 and passes 0 through; the host owns its no-op behavior and event queue/ID lifecycle.

Time validation applies only at this event boundary, not to ordinary f64 values: time must be a finite integer number in `[0, 7_200_000_000_000_000]` picoseconds, with negative zero normalized to zero. Non-number/non-finite/fractional values cause TypeError before range checking; out-of-range or past times cause RangeError, retained as the evaluation failure cause.

The optional `stepObserver.beforeStep` runs once before each reference step effect, including calls and terminators, using the captured execution context. Existing maxSteps checks and the default 1,000,000-step budget are unchanged; no observer is invoked for a step blocked by maxSteps. Hook method identities, receivers, and option values are captured at creation without executing hooks. Async/generator methods are rejected as invalid-options; Promise/thenable or generator results and thrown hook errors fail execution with existing error codes, retaining cause, location, and IR callStack. Previously committed effects remain and the interpreter faults as usual. A host must implement its own operations atomically when required.

`src/event.test.ts` tests real IR execution, validation, capture, time/ID boundaries, synchronous hooks, and step effects; `src/event.type-test.ts` checks the approved API and invalid signatures.

## 版本化资源更新

`FunctionBuilder.resource` 提供：

```ts
updateBytes(destination, destinationOffset, source, sourceOffset, length): undefined;
fillBytes(destination, offset, length, value): undefined;
```

它们产生无结果的 `resource.update_bytes` / `resource.fill_bytes`。目标是静态字节区（可 readonly，不可 inbox），源可为字节区或 inbox：

```ts
import { createIRInterpreter, createIRModule } from '@mica-js/ir';

const module = createIRModule();
const firmware = module.bytes('firmware', new Uint8Array(8).fill(255), {
  readonly: true,
  unitBytes: 4,
});
const patch = module.bytes('patch', new Uint8Array([11, 22, 33, 44]), { readonly: true });
const apply = module.func('apply', { params: ['u32', 'u32', 'u32'], results: [] });
apply.body((b, [dst, src, length]) => {
  b.resource.updateBytes(firmware, dst, patch, src, length);
  b.return([]);
});

const runtime = createIRInterpreter(module, {
  validation: {
    supportedInstructions: ['resource.update_bytes', 'return'],
    authorizedInstructions: ['resource.update_bytes', 'return'],
    resources: [
      { ref: firmware, access: 'update' },
      { ref: patch, access: 'read' },
    ],
  },
});
const before = runtime.storage.readVersionedBytes(firmware, 0, 8);
runtime.execute(apply, [2, 0, 4], { instanceId: 'flash', virtualTime: 0 });
const after = runtime.storage.readVersionedBytes(firmware, 0, 8);
runtime.storage.validateDependencies(before.dependencies); // false
runtime.storage.validateDependencies(after.dependencies); // true
```

- 独立存储用 `createIRStorage(module, { updateResources })` 授予更新权限；构造时捕获名单、拒绝 inbox 与外模块资源，默认不允许更新。
- `update` grant、源 `read` grant、指令支持/授权分别核验；完整范围检查先于任何提交，重叠更新使用源快照。
- `IRStorage` 新增 `updateBytes`、`fillBytes`、`readVersionedBytes`、`validateDependencies`；零长仍验端点与权限，但不读写字节或改版本。
- 单元边界为 `floor(offset / unitBytes)`，声明后固定；非零更新为覆盖的每个单元产生新版本 token，未覆盖单元与其他资源不变。
- 依赖对象是不透明 token，只在本实例内有效；过期、伪造、跨资源/实例或非法形状返回 `false`，空集合为 `true`。它们不是序列化或持久化格式。
- 普通 `store` / `copy` 不改变版本；Provider 缓存（#60）与运行中恢复（#61）不在本包。

```ts
interface IRStorage {
  updateBytes(
    destination: BytesRef,
    destinationOffset: number,
    source: ReadableBytesRef,
    sourceOffset: number,
    length: number,
  ): void;
  fillBytes(destination: BytesRef, offset: number, length: number, value: number): void;
  readVersionedBytes(ref: ReadableBytesRef, offset: number, length: number): IRVersionedBytes;
  validateDependencies(dependencies: readonly IRResourceDependency[]): boolean;
}

type IRVersionedBytes = {
  readonly bytes: Uint8Array;
  readonly dependencies: readonly IRResourceDependency[];
};

type IRResourceDependency = {
  readonly resource: IRResourceIdentity;
  readonly unit: IRVersionUnitIdentity;
  readonly version: IRResourceVersion;
};
```

## 当前限制

- 事件队列/调度器本身（核心 event 指令通过上述可信宿主桥接）、输出、消息桥接及 JS 作者侧 `api.updateBytes` 请求队列。
- Provider 生成缓存（#60）、运行中恢复/checkpoint（#61）与 JIT。
- 尚未定义的函数保持 `body: undefined`，会被 `validateIR` 拒绝。

## 开发

```bash
pnpm --filter @mica-js/ir test        # 模型、建图、校验、标量、存储、解释器与资源更新
pnpm --filter @mica-js/ir typecheck   # 含 builder / storage / interpreter 正反类型用例
pnpm --filter @mica-js/ir build
```

## 相关提案

- 规范：[IR SPEC #26](https://github.com/x-botlab/mica-js/issues/26)、[器件作者 API #8](https://github.com/x-botlab/mica-js/issues/8)
- 实现： [#41](https://github.com/x-botlab/mica-js/issues/41)、[#42](https://github.com/x-botlab/mica-js/issues/42)、[#43](https://github.com/x-botlab/mica-js/issues/43)、[#44](https://github.com/x-botlab/mica-js/issues/44)、[#45](https://github.com/x-botlab/mica-js/issues/45)、[#46](https://github.com/x-botlab/mica-js/issues/46)、[#47](https://github.com/x-botlab/mica-js/issues/47)
