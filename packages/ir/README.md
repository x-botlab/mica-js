# @mica-js/ir

领域无关的 IR 数据模型、同步类型化建图器、静态校验/链接诊断、整数/布尔及浮点逐指令语义、实例存储与参考解释器，对应 [#41](https://github.com/x-botlab/mica-js/issues/41)、[#42](https://github.com/x-botlab/mica-js/issues/42)、[#43](https://github.com/x-botlab/mica-js/issues/43)、[#44](https://github.com/x-botlab/mica-js/issues/44)、[#45](https://github.com/x-botlab/mica-js/issues/45)、[#46](https://github.com/x-botlab/mica-js/issues/46)、[#47](https://github.com/x-botlab/mica-js/issues/47)。规范依据为 [IR SPEC #26](https://github.com/x-botlab/mica-js/issues/26) 与 [器件作者 API #8](https://github.com/x-botlab/mica-js/issues/8)。

本包负责**建图、实例存储、静态校验/链接诊断、可复用标量运算与参考执行**：声明标量资源与函数、构造 SSA 值、基本块和终结指令，为每个实例建立独立存储，并通过 `validateIR` 检查内存模型、控制流与能力策略。`evaluateScalarInstruction` 和 `evaluateFloatInstruction` 仍是独立的单节点求值入口；`createIRInterpreter` 在固定快照并校验后复用它们及现有 storage，执行控制流与普通同步调用。`b.resource` 显式更新复用同一存储，原子维护内容与版本，并提供未来 Provider 所需的一致读取/依赖验证基础。本包不提供事件调度、Provider 缓存/运行恢复、消息桥接或 JIT。校验通过不代表已经执行，尚未实现的能力不会以空操作伪装为成功。

## 公共入口

唯一公开入口为 `@mica-js/ir`，构建生成 `dist/index.js`（ESM）与声明文件。主要导出：

- `createIRModule()`：创建独立的模块声明/建图上下文，返回 `IRModule`。
- `createIRStorage(module, options?)`：为模块的声明资源创建一份独立实例存储，返回 `IRStorage`；每次调用互不别名。可选 `IRStorageOptions.updateResources` 显式授予字节更新权限，默认无授权。
- `createIRInterpreter(module, options)`：创建经过快照与校验的参考解释器，拥有独立 `storage`，通过 `execute(target, args, context)` 同步执行；预算、诊断及拒绝边界见下文。
- `validateIR(input, options)`：返回 `IRValidationResult`，通过 `IRDiagnostic` / `IRDiagnosticLocation` 报告静态错误；能力策略及领域扩展类型见下文。
- `evaluateScalarInstruction(instruction, operands)`：求值单个整数/布尔节点，失败抛出 `IRScalarEvaluationError`；范围与错误码见下文。
- `IRDeclarations`：`state`、`array`、`bytes`、`inbox`、`func`、`entry`、`lifecycle` 静态声明。
- `FunctionBuilder<R>`：常量、标量运算、资源访问、普通 `call`、基本块、分支、循环与终结指令。
- `IRModule`：除声明方法外，提供只读的 `memories`、`functions`、`domainDeclarations`、`instructions` 模型视图。
- 类型边界：`FunctionRef`、`EntryRef`、`LifecycleRef`、`BlockRef` 使用独立引用类别；`StateRef`、`ArrayRef`、`BytesRef`、`InboxRef` 不可互换。

## 整数与布尔逐指令求值

`evaluateScalarInstruction(instruction: InstructionNode, operands: readonly (boolean | number)[]): boolean | number` 消费现有建图器/内存模型的节点，不引入另一套指令类型。`operands` 按 `instruction.operands` 中 **SSA 操作数出现的顺序**提供已求值标量；节点内的 literal（例如比较 predicate、转换目标或常量）不占该数组位置。返回节点唯一结果的标量值，不写回 SSA 表，也不访问存储或执行控制流。

```ts
import { createIRModule, evaluateScalarInstruction } from '@mica-js/ir';

const ir = createIRModule();
ir.func('multiply', { params: ['u32', 'u32'], results: ['u32'] }).body((b, [a, c]) =>
  b.return([b.int.mul(a, c)]),
);
const multiply = ir.functions[0]!.body!.entry.instructions[0]!;
evaluateScalarInstruction(multiply, [4294967295, 4294967295]); // 1
```

支持范围：

- `u8/i8/u16/i16/u32/i32` 的 `int.add/sub/mul/div/rem/and/or/xor/not`、`int.cmp` 全部六种 predicate、`int.shl/lshr/ashr` 及 `int.zext/sext/trunc/reinterpret`。
- `bool.not/and/or/xor`，以及整数/bool 的 `const`、`select`。`select` 的两个候选值均须已求值且合法；它不短路，也不能屏蔽先前的除零异常。
- 加减乘及有符号商溢出按位宽回绕；除法向零截断，余数随被除数或为零。除零/取余零均报错；整数零规范化为正零。
- 移位数严格为 `u32`，不对位宽取模。`count >= width` 时左移/逻辑右移为零；算术右移按符号填充为零或 -1。`ashr` 只接受有符号来源。
- 扩位/截断严格检查宽度关系；`sext` 只接受有符号来源，允许无符号目标；`zext` 对来源位模式补零；`reinterpret` 只允许同宽、异符号。常量和输入值必须先处于其声明类型值域，不以截断代替验证。

实现内部使用精确 `bigint` 和显式定宽归一化，避免 JS 位运算的 32 位隐式截断、移位数取模及 u32 乘法精度损失；公开标量仍为 `number | boolean`，不接受 bigint、真假值强制转换或混型运算。

失败抛出 `IRScalarEvaluationError`，其只读 `code: IRScalarEvaluationErrorCode` 为：`unsupported-instruction`（尚未实现）、`invalid-instruction`（布局/签名错误）、`invalid-operand`（SSA 实参数目/类型/值域错误）、`division-by-zero`。批准的错误联合还保留 `conversion-out-of-range`，本项整数内部转换不会产生该错误。不支持的运算显式拒绝；所有浮点运算、整数↔浮点数值转换、`convert.float`、`const.bits`、bitcast 和浮点 select 由 [#44](https://github.com/x-botlab/mica-js/issues/44) 实现，本项不执行它们。

此入口检查单节点签名和值域，不替代 `validateIR` 对 SSA 定义/支配、静态引用、控制流和授权的整图检查。参考解释器完成验证、解析 SSA 标量后复用此入口，并附加执行位置；不得把静态校验成功当作执行成功。现有 `IRConstructionError` 与 #42 静态诊断合同不变。

## 建图示例

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

const entry = ir.functions.find((fn) => fn.name === 'run')?.body?.entry;
// entry.instructions 是 call、int.add、state.store；entry.terminator 是 return。
```

函数必须先通过 `ir.func` / `ir.entry` / `ir.lifecycle` 声明引用，再用一次 `.body(callback)` 定义函数体。`.body` 回调同步执行；可识别的 async/generator 回调在调用前即被拒绝，不会执行其同步前缀；普通函数若返回 Promise，也会同步拒绝并消费其后续 rejection，不把建图变成异步流程。普通函数通过 `b.call(target, args)` 同步调用，结果始终按列表返回，支持零个、一个或多个结果。入口与生命周期没有普通返回值，也不能被 `call`。

## 基本块与插入位置

`b.block(types)` 只创建当前函数内的目标块，**不会移动插入位置**。`b.at(block, callback)` 才进入该块定义，并在回调结束后恢复之前的插入位置。每个块定义一次，并且必须恰好以 `return`、`jump`、`branch` 或 `trap` 终结；终结后向同一块追加指令会被拒绝。若块回调抛错、返回 Promise 或未终结，整个函数构建会被标记失效：调用方即使捕获异常也不能继续追加或重试该块，函数体不会发布；需要重新调用 `.body` 从新的构建状态开始。

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

块参数是循环和合流的唯一显式传值方式，不提供隐式 phi 或可变局部变量。嵌套 `at` 回调仍然使用同一 `FunctionBuilder<R>` 方法族；`EntryRef`、`LifecycleRef` 与普通 `FunctionRef` 在类型和运行期都保持独立。`GeneratedFunctionBuilder<R>` 目前只保留继承边界：它的嵌套 `at` 回调仍返回生成函数 builder，但 Provider 工厂、`checkpoint` 与 `dispatch` 属于后续任务，尚不可用。

## 统一内存模型

状态、数组、字节区和输入槽位共用 `MemoryDefinition`：

- `MemoryDefinition.kind` 区分 `state`、`array`、`bytes`、`inbox`。
- `state` / `array`：`layout.kind: 'scalar'`，固定元素类型与长度；状态长度为 1。
- `bytes` / `inbox`：`layout.kind: 'bytes'`，固定字节容量，`unitBytes` 记录版本单元粒度。
- `bytes` 的 `readonly` 只限制客体普通 `bytes.store` / `bytes.copy`；`inbox` 只能读取，不能作为普通写入目标。
- 声明初值会被复制；数组元素与标量初值按目标类型校验，整数越界或 bool/数值混用会被拒绝。

`module.memories` 暴露该统一模型。它是当前实现的内存表示，不是已冻结的持久化格式。

## 实例存储

`createIRStorage(module)` 按声明初值建立固定容量的实例存储。底层 buffer 不公开，读写只能经过带完整校验的方法：

```ts
import { createIRModule, createIRStorage } from '@mica-js/ir';

const ir = createIRModule();
const counter = ir.state('counter', 'u32', 0);
const samples = ir.array('samples', 'u16', [10, 20]);
const ram = ir.bytes('ram', new Uint8Array(16), { readonly: false });
const input = ir.inbox('input', 8);

const storage = createIRStorage(ir);
storage.storeState(counter, 1);
storage.storeArray(samples, 1, 30);
storage.storeBytes('u16', 'little', ram, 1, 0x1234);
const word = storage.loadBytes('u16', 'big', ram, 1);
storage.copy(ram, 4, input, 0, 8);
storage.copy(ram, 5, ram, 4, 4);
```

- 索引、偏移和长度在运行期按 u32 检查；多字节访问先验证完整范围，非对齐访问合法，不通过回绕绕过边界。
- 单次操作先完成资源类别、权限、范围和值校验，再提交字节；失败不会留下本操作的部分写入。此前已成功的写入不回滚。
- `bytes.copy` 先建立源字节快照，再写入目标；同资源重叠复制按复制前的源字节取值。零长度仍校验两侧 offset 在 `[0, 容量]` 内以及目标可写。
- `readonly` 字节区与 `inbox` 可以读取或作为 `bytes.copy` 源；普通 `bytes.store` / `bytes.copy` 写入会被拒绝。`state` / `array` 的写入目标是固定可写的声明资源。
- 每次 `createIRStorage` 都从声明初值复制独立 buffer；两个实例、两个声明以及原始 `Uint8Array` 输入之间互不别名。
- 普通 `store` / `copy` 只改变内容，不更新资源版本；版本化更新必须通过下述独立授权路径。
- `state.load` / `array.load` / `bytes.load` 返回 `StorageValue<T>`：`bool` 为 `boolean`、整数为 `number`、浮点为 `FloatBits`。浮点 load 返回原始位模式，移动不会解码/重编码 NaN；`store` 接受 `number`（数值入口，NaN 使用规范编码）或同类型 `FloatBits`。
- 失败抛出 `IRStorageError`，`code` 为 `invalid-resource`、`invalid-value`、`invalid-argument`、`out-of-bounds`、`readonly-resource`、`unauthorized-resource`（缺少独立更新授权）或 `allocation-failure`。`validateIR` 静态核验 `resources`；存储负责运行期类别、可写性、独立更新权限和范围检查，二者互不替代。既有直接存储读取/普通写入的权限模型不变。

`FloatBits` 与 `RuntimeScalar` 是共享的值表示：`FloatBits` 的 `bits` 使用 `0x` 加固定 8/16 位小写十六进制。存储不会把 `DataView.getFloat32/64` 的数值结果当作原始载荷的替代。

## 领域扩展

领域模块可以在自己的包中声明静态句柄和显式指令，核心不导入引脚、电源、连接等域类型：

```ts
const led = ir.domainDeclaration('led', 'status');
const setLed = ir.domainInstruction('led.set', {
  operands: [
    { kind: 'static', category: 'led' },
    { kind: 'value', type: 'bool' },
  ],
  results: [],
});

const enable = ir.entry('enable', ['bool']);
enable.body((b, [on]) => {
  b.invoke(setLed, [led, on]);
  b.return([]);
});
```

`invoke` 只生成模块中已声明的显式指令，并校验操作数类别、标量类型和结果布局。不提供 `call(hostFunction)` 或任意运行期 JS 回调扩展。域模块仍可自行增加类型化包装方法；本包负责底层静态声明、指令和建图原语。

## 校验与链接诊断

`validateIR(input: unknown, options: IRValidationOptions): IRValidationResult` 是统一静态检查入口（[#42](https://github.com/x-botlab/mica-js/issues/42)）。`input` 必须具有 `memories`、`functions`、`domainDeclarations`、`instructions` 四个列表，可直接传入 `IRModule`。它校验传入的当前表示，不调用建图方法，也不以 builder 的隐藏 WeakMap 记录代替检查。每次调用仅读取一次这四个列表，保持 getter 生成的声明视图在各校验阶段和领域回调上下文中一致；下一次调用会重新读取。

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
// result.ok 为 true；否则读取 result.diagnostics。
```

策略必须由可信宿主提供，不应采信客体自己声称的能力：

- `supportedInstructions` 是目标后端明确支持的指令名；`authorizedInstructions` 是实例获准使用的指令名。两者均精确匹配，并包含所用终结名 `return` / `jump` / `branch` / `trap`。没有默认全支持、通配符或自动授权。
- `resources` 按句柄身份授予 `read`、`write`、`read-write` 或独立的 `update`。同一资源可分多条不同权限 grant（相同权限的重复条目仍拒绝）；`read-write` 不授予更新，`update` 不授予普通读写。读取/写入逐条核验；普通写权限不能突破资源固有只读性，`update` 则不受 readonly 限制，但目标必须是字节区、不能是 inbox。同名不等于同一资源，也不能授权输入外的资源。
- 领域指令还必须存在声明、匹配操作数/结果布局，并通过 `validators` 中对应 `op` 的独立扩展校验器。`validate(context)` 返回只读字符串消息列表；空列表表示领域静态规则通过，消息产生 `domain-validation`。上下文提供模块、函数、块、指令、定位与资源授权；具体领域读写约束由可信扩展核验。回调只能同步运行；async/generator 在调用前拒绝，抛错、Promise 或非法返回产生 `extension-error`。
- 核心不导入任何领域包。扩展不能替换核心指令（包括已实现的 `resource.update_bytes/fill_bytes`），也不能启用其他保留的资源操作、Provider/checkpoint/dispatch 或 kernel-only 指令。

SSA 值和静态句柄以对象身份关联，块边目标必须是本函数 `body.blocks` 中的实际对象；块 ID 在函数内唯一。`FunctionDefinition.ref` 和 `DomainDeclaration.ref` 显式保存声明句柄。校验交叉核验句柄类别、函数签名、资源布局及初值，拒绝重复身份、布局不一致与跨函数使用。对象的附加调试字段不充当 SSA ID；内存模型仍不是冻结的序列化格式。

函数入口块参数对应函数参数；参数在全函数内有效。其余定义必须支配使用，同块必须先定义后使用。循环回边允许；不可达块仍完整校验，其局部定义只保证支配本块，不允许跨不可达块借用值（函数参数除外）。每个函数都必须有函数体，每个块必须已定义且具有合法终结；包括未被入口调用的函数和不可达块。

诊断具有稳定的 `code`、`message`、`location`。`location.path` 总是存在，例如 `functions[0].body.blocks[1].instructions[2]`；函数/块/指令使用从 0 开始的 `functionIndex`、`blockIndex`、`instructionIndex`，并附 `functionName`、`blockId`。终结位置使用 `.terminator` 路径与 `terminator: true`，不伪造指令序号。声明、策略或畸形外围上下文中不存在的字段会省略；读取输入抛错时定位为 `$`。稀疏数组和错误结构明确拒绝。

返回值仅针对本次稳定输入和策略有效，不是冻结的已链接产物或运行授权令牌。调用方必须在任何安装/执行前检查 `ok`，输入、策略或后端变化后重新检查。`createIRInterpreter` 自行捕获并校验执行快照，承担动态约束与运行故障处理，且额外拒绝无执行实现的指令；不把后端支持列表当作执行实现。

## 浮点单指令语义（#44）

`evaluateFloatInstruction(instruction: InstructionNode, operands: readonly RuntimeScalar[]): RuntimeScalar` 复用建图器/校验器的指令模型，不解释函数、分支或存储。`operands` 仅含 SSA 操作数的运行值，按其在指令中的顺序排列；谓词、目标类型、常量等 literal 已在指令节点中，不重复传入。

- `FloatBits = { readonly type: FloatType; readonly bits: HexBits }` 保存原始位，f32 必须恰好 8 个十六进制位，f64 恰好 16 位，均以 `0x` 开头。`RuntimeScalar = boolean | number | FloatBits` 是语义层值；两者统一定义在 `src/types.ts`，从包入口导出，供浮点与存储共用。不改变作者层 `Value` / `JSScalar` 或声明初值合同，也不引入 u64 算术。
- 所有浮点结果均为 `FloatBits`，整数/布尔结果仍为 number/boolean。浮点 number 输入按 SSA 声明精度量化，仅用于数值入口；需要保留 NaN 载荷/符号/信号位必须传 `FloatBits`，不得经过 JS number 往返。
- 支持浮点 `const` / `const.bits` / `select`、`float.add/sub/mul/div/fma/cmp/isNaN/isFinite`、`convert.intToFloat/floatToInt/float` 及仅 f32 与 u32/i32 间的 `bitcast`。这里采用模型中的 camelCase 操作名，不另造文本 IR 解析器。
- 内部使用无依赖的 BigInt 精确二进制整数/有理数计算，四则及 FMA 直接按目标精度最近值、居中取偶数舍入。每个 f32 操作独立舍入，FMA 不舍入中间乘积，保留次正规数及正确的有符号零；不会用 `a*b+c` 或 f64 中间结果冒充融合运算。
- 算术与浮点精度转换得到的 NaN 分别规范为 `0x7fc00000` / `0x7ff8000000000000`；`const.bits`、浮点选择与 bitcast 保留原始位。后续状态/数组/字节移动应直接搬运此位值，不将其解码为 number 再编码。此项未实现存储或公共总 dispatcher；#43 的 number-only 标量入口保持独立，不作为原始浮点位传输路径。
- 整数到浮点先验证来源整数范围，再按目标精度舍入；浮点到整数先按来源精度读取并向零截断，再严格检查目标范围，整数零规范为 number `0`。NaN、无穷或越界抛 `IRFloatEvaluationError`，`code` 为 `integer-overflow`；错误布局为 `invalid-instruction`，错误运行值为 `invalid-operand`，未实现的操作为 `unsupported-operation`。这些执行错误不复用静态校验诊断。

```typescript
import { createIRModule, evaluateFloatInstruction } from '@mica-js/ir';

const module = createIRModule();
module
  .func('fused', { params: ['f32', 'f32', 'f32'], results: ['f32'] })
  .body((b, [a, c, d]) => b.return([b.float.fma(a, c, d)]));
const instruction = module.functions[0]!.body!.entry.instructions[0]!;
const result = evaluateFloatInstruction(instruction, [1 + 2 ** -23, 1 - 2 ** -23, -1]);
// result: { type: 'f32', bits: '0xa8800000' }，即 -2^-46；非融合结果为正零。
```

`src/float.test.ts` 包含可复用的表驱动边界向量，包括融合/非融合、f32 经 f64 的双舍入差异、溢出抵消、次正规数、转换范围及带载荷 NaN 位移动，并使用真实 builder 节点与 `validateIR` 联合检查。`src/float.type-test.ts` 检查上述公开合同。

## 参考解释器（#46）

公共合同经[逐项审批](https://github.com/x-botlab/mica-js/issues/46#issuecomment-6320397762)确认。

```typescript
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
// result: { values: [3], steps: 4 }
runtime.storage.loadState(count); // 3
```

`createIRInterpreter(module: IRModule, options: IRInterpreterOptions): IRInterpreter` 捕获私有执行快照，调用现有 `validateIR`，再用现有 `createIRStorage` 创建独占存储。`IRInterpreterOptions` 包含必填 `validation: IRValidationOptions` 和可选 `maxSteps: number`。执行图的节点、SSA 类型、块边与签名在捕获后不再读取原模型；静态句柄保留身份，资源内容由 storage 独立捕获。原模型后续添加函数或修改指令不会改变已创建解释器；要使用新程序须重新创建。不修改/冻结调用方原模型，不接受外部 storage；多次构造同一模块得到互不别名的实例，现有独立 `createIRStorage` 不受影响。API 面向可信宿主，不是执行任意恶意 JS getter/validator 的隔离沙箱。

`IRInterpreter` 的只读 `storage: IRStorage` 供宿主检查和受控访问；IR 的访问权限仍来自必填 validation 策略，不能通过普通 call 扩权。`execute(target: FunctionRef | EntryRef | LifecycleRef, args: readonly RuntimeScalar[], context: IRExecutionContext): IRExecutionResult` 同步执行，结果为 `{ readonly values: readonly RuntimeScalar[]; readonly steps: number }`，包括零、单、多结果。可信宿主可直接选择这三类目标；IR 内 `call` 只允许同模块普通函数，不得调用入口/生命周期或跨实例目标。实例存储跨成功执行保留，每次 execute 使用独立预算。

`IRExecutionContext = { readonly instanceId: string; readonly virtualTime: number }` 必须显式提供；实例标识非空，时间为非负安全整数皮秒，用于诊断，不读取墙钟。参数数量、bool/整数值域和 FloatBits 精度/位宽严格检查。浮点 number 输入通过现有浮点求值器按声明精度量化，FloatBits 输入按值捕获；浮点输出始终是 FloatBits。块边先捕获全部实参再同时绑定，回边交换参数不会被顺序覆盖。块跳转和普通 call 不推进虚拟时间、不创建事件、不形成等待或恢复对象；调用帧是本次同步执行的内部帧，非保存的等待栈。

### 确定预算

- `maxSteps` 默认为 1,000,000，必须是非负安全整数；0 在首步前拒绝。
- 每条规范化 InstructionNode 和每条 terminator 各计一步，包含 const、call、return、jump、branch、trap。函数入参/块参数绑定、调用帧压入/弹出无额外计费；被执行到的常量照常计费，未选分支不计。
- 普通调用共享本次顶层 execute 的剩余预算；先检查再开始下一步，最多开始 `maxSteps` 步，不执行预算外操作。`steps` 计已开始步骤，因此发生运算/存储/trap 故障的步骤计入；被预算拦截的步骤不计入。
- 块循环、快照复制和普通调用帧均迭代处理，不依赖 JS 栈溢出或机器运行时长终止。每同一时刻入口执行次数的全局限制归后续调度器，本包不另造调度器。

### 错误与提交

`IRExecutionError` 构造签名为 `(code: IRExecutionErrorCode, message: string, details?: IRExecutionErrorDetails)`，只读 `code`、`context`、`location`、`callStack`、`steps`、`diagnostics` 与 `cause` 描述失败；无对应上下文/位置/cause 时为 undefined，callStack/diagnostics 默认空数组，steps 默认 0。`IRExecutionErrorDetails` 为上述后六项的可选字段，`cause: unknown` 保留原异常。

`IRExecutionLocation` 包含从 0 开始的 `functionIndex`、`blockIndex`、`instructionIndex?`，以及 `functionName`、`blockId`、`terminator?: true`；终结位置不伪造 instructionIndex。callStack 外层到内层排列，外层位置为调用点，最内层为失败点，与 location 对应。构造/调用前错误可能没有执行位置。静态失败在 diagnostics 保留现有 IRDiagnostic；运算或存储失败在 cause 保留 IRScalarEvaluationError、IRFloatEvaluationError 或 IRStorageError，明确错误原因而不改变既有错误码。trap 的模型 code 包含在 message 中。

| IRExecutionErrorCode      | 含义                                   |
| ------------------------- | -------------------------------------- |
| `invalid-options`         | 非法解释器配置/预算                    |
| `validation-failed`       | 模型或显式策略未通过静态校验           |
| `invalid-target`          | 顶层目标不属于此解释器的模块快照       |
| `invalid-argument`        | 执行前实参或上下文非法                 |
| `budget-exhausted`        | 下一参考 IR 步骤超出预算               |
| `trap`                    | 模型显式终结异常                       |
| `evaluation-failed`       | 单节点运算失败                         |
| `storage-failed`          | 存储分配或访问失败                     |
| `unsupported-instruction` | 静态扩展合法但本解释器没有执行实现     |
| `instance-faulted`        | 实例此前已发生执行故障，不允许再次执行 |

每项存储操作复用原有完整范围校验与原子提交，失败操作自身不产生部分写入，此前已提交效果不回滚。执行中的预算、求值、存储或 trap 故障锁定实例，storage 仍可检查；后续 execute 抛 instance-faulted，无 reset/resume，也不支持失败入口中途恢复。非法目标、参数或 context 等调用前错误不消耗步骤、不锁定实例。解释器停止并抛错，整个仿真及其他实例的暂停由宿主负责，不由本包擅自调度或销毁。

### 能力边界

执行范围为现有整数/布尔/浮点/存储指令、`resource.update_bytes/fill_bytes`、普通 call 及 return/jump/branch/trap。调用无用户执行回调；新增能力必须在解释器明确分发点接入并另行审批，不能靠增加 supportedInstructions 或静态 validator 自动获得执行实现。构造时也检查不可达块/未调用函数：扩展静态校验即使通过，event、domain 等未实现执行能力仍在任何 IR 效果发生前拒绝；dispatch、Provider/checkpoint、其他 resource 更新拼写及保留能力沿用静态拒绝。普通写入不能突破 readonly；独立更新授权不受 readonly 限制，但仍核验资源身份与类别。

`src/interpreter.test.ts` 使用真实 builder、validateIR、既有求值器与 storage，覆盖 identity、分支合流、sum 循环、同时绑定回边、4096 层调用、多结果、精确预算、错误调用链、失败操作原子性、独立实例、浮点载荷/负零移动及拒绝路径。`src/interpreter.type-test.ts` 检查公共签名。

## 版本化资源更新（#47）

公共合同经[五项逐一审批](https://github.com/x-botlab/mica-js/issues/47#issuecomment-6321258164)确认。`FunctionBuilder.resource: ResourceOperations` 和继承它的 `GeneratedFunctionBuilder` 提供：

```typescript
updateBytes(destination: BytesRef, destinationOffset: Value<'u32'>,
  source: ReadableBytesRef, sourceOffset: Value<'u32'>, length: Value<'u32'>): undefined;
fillBytes(destination: BytesRef, offset: Value<'u32'>,
  length: Value<'u32'>, value: Value<'u8'>): undefined;
```

它们分别产生无结果的 `resource.update_bytes` / `resource.fill_bytes`。目标是静态字节区（可 readonly，不可 inbox）；源可为字节区或 inbox。独立 `update` grant、源 `read` grant、操作支持/授权分别核验。完整范围检查先于任何提交，重叠更新使用源快照；零长度仍检查权限、端点和填充值，不读写字节或改版本。非零同值更新也保守失效，跨单元内容与覆盖版本同步提交。失败无本操作部分提交，此前成功效果不回滚。无 writer/flush、自动时间推进、事件、NOR 编程规则或 BUSY 状态。

```typescript
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
// after.bytes: [255, 255, 11, 22, 33, 44, 255, 255]；两个单元均已更新。
runtime.storage.validateDependencies(before.dependencies); // false
runtime.storage.validateDependencies(after.dependencies); // true
```

独立存储通过 `createIRStorage(module: IRModule, options?: IRStorageOptions): IRStorage` 创建；`IRStorageOptions = { readonly updateResources?: readonly BytesRef[] }`，构造时捕获名单、拒绝 inbox/外模块资源；默认不允许更新。解释器从自己的私有验证策略快照提取 update grants，配置独占存储，不接受外部 storage 或新增执行回调。宿主直接存储接口不重复普通读取授权；IR 源读取仍由 validator 独立核验。

`IRStorage` 新增以下方法；所有偏移/长度严格为 u32，填充值为 u8：

```typescript
updateBytes(destination: BytesRef, destinationOffset: number,
  source: ReadableBytesRef, sourceOffset: number, length: number): void;
fillBytes(destination: BytesRef, offset: number, length: number, value: number): void;
readVersionedBytes(ref: ReadableBytesRef, offset: number, length: number): IRVersionedBytes;
validateDependencies(dependencies: readonly IRResourceDependency[]): boolean;
```

`IRVersionedBytes = { readonly bytes: Uint8Array; readonly dependencies: readonly IRResourceDependency[] }` 同步捕获字节副本与覆盖全部单元的依赖；零长仍验端点且依赖为空。副本可修改但不影响存储，返回外壳、依赖数组及依赖对象不可修改。`IRResourceDependency = { readonly resource: IRResourceIdentity; readonly unit: IRVersionUnitIdentity; readonly version: IRResourceVersion }`，三个字段都是不透明、不可修改的对象 token，无公共构造器/数值计数器。验证仅接受本实例读取所产生的依赖对象；过期、伪造（包括复制依赖外壳）、跨资源/实例或非法形状返回 false，空集合 true。

每个存储实例的各资源有独立身份；单元边界为 `floor(offset / unitBytes)`，声明后固定。尾部短单元、unitBytes 大于容量合法；零容量没有单元（默认 unitBytes 为 0，显式 unitBytes 仍须正安全整数）。单元身份固定，非零更新为每个覆盖单元产生新版本 token，未覆盖单元/其他资源保持不变，无数值溢出、回绕或身份复用。token 只在当前进程/实例有效，不是序列化或持久化格式。

普通 store/copy **不改变版本**；把可变 RAM 用于 Provider 生成时，未来必须配置覆盖所有写入来源的版本化路径，不能仅凭 unitBytes 或此读取接口宣称缓存正确。这里仅实现资源基础，不创建 Provider 缓存（#60），也不校验/恢复正在运行的旧生成产物（#61）。执行错误、定位、预算与故障锁定继续沿用 #46。`resource.test.ts` 覆盖真实 builder→validateIR→interpreter 集成，`resource-storage.test.ts` 覆盖存储边界/原子性/身份隔离，`resource.type-test.ts` 覆盖正反公共类型合同。

## 当前限制

以下能力属于后续任务，本包明确不实现：

- 事件、输出、消息桥接及 JS 作者侧 `api.updateBytes` 请求队列。
- Provider 生成缓存（#60）、运行中恢复/checkpoint（#61）与 JIT。

`module.functions` 中的函数体在 `.body` 成功返回后可见；尚未定义的函数保持 `body: undefined`，会被 `validateIR` 拒绝。本包不会把“可构建”或“静态检查通过”等同于“可执行”。

## 开发与验证

使用仓库现有 pnpm catalog、TypeScript、Vite、vite-plugin-dts 与 Vitest：

```bash
pnpm --filter @mica-js/ir typecheck   # 包含 builder、storage、interpreter 等正反类型用例
pnpm --filter @mica-js/ir test        # 模型、建图、校验、标量、存储与参考解释器测试
pnpm --filter @mica-js/ir build
```

类型测试只做编译期检查，不执行构建、不创建子进程或临时消费方。
