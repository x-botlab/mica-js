# @mica/ir

领域无关的 IR 数据模型、同步类型化建图器与静态校验/链接诊断，对应 [#41](https://github.com/x-botlab/mica-js/issues/41)、[#42](https://github.com/x-botlab/mica-js/issues/42)。规范依据为 [IR SPEC #26](https://github.com/x-botlab/mica-js/issues/26) 与 [器件作者 API #8](https://github.com/x-botlab/mica-js/issues/8)。

本包负责**建图与静态校验/链接诊断**：声明标量资源与函数、构造 SSA 值、基本块和终结指令，并通过 `validateIR` 检查实际内存模型、控制流与能力策略。另提供独立的浮点单指令语义求值（见下文），但不运行整个 IR，也不提供解释器、存储语义、资源更新、Provider、消息桥接或 JIT。校验通过不代表已经安装或执行，尚未实现的能力不会以空操作伪装为成功。

## 公共入口

唯一公开入口为 `@mica/ir`，构建生成 `dist/index.js`（ESM）与声明文件。主要导出：

- `createIRModule()`：创建独立的模块声明/建图上下文，返回 `IRModule`。
- `validateIR(input, options)`：返回 `IRValidationResult`，通过 `IRDiagnostic` / `IRDiagnosticLocation` 报告静态错误；能力策略及领域扩展类型见下文。
- `IRDeclarations`：`state`、`array`、`bytes`、`inbox`、`func`、`entry`、`lifecycle` 静态声明。
- `FunctionBuilder<R>`：常量、标量运算、资源访问、普通 `call`、基本块、分支、循环与终结指令。
- `IRModule`：除声明方法外，提供只读的 `memories`、`functions`、`domainDeclarations`、`instructions` 模型视图。
- 类型边界：`FunctionRef`、`EntryRef`、`LifecycleRef`、`BlockRef` 使用独立引用类别；`StateRef`、`ArrayRef`、`BytesRef`、`InboxRef` 不可互换。

## 建图示例

```ts
import { createIRModule } from '@mica/ir';

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
import { createIRModule, validateIR } from '@mica/ir';

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
- `resources` 按句柄身份授予 `read`、`write` 或 `read-write`。读取/写入逐条核验；写权限不能突破资源固有只读性，也不能授权输入外的资源。同名不等于同一资源。
- 领域指令还必须存在声明、匹配操作数/结果布局，并通过 `validators` 中对应 `op` 的独立扩展校验器。`validate(context)` 返回只读字符串消息列表；空列表表示领域静态规则通过，消息产生 `domain-validation`。上下文提供模块、函数、块、指令、定位与资源授权；具体领域读写约束由可信扩展核验。回调只能同步运行；async/generator 在调用前拒绝，抛错、Promise 或非法返回产生 `extension-error`。
- 核心不导入任何领域包。扩展不能替换核心指令，也不能启用保留的 Provider/checkpoint/dispatch、资源版本更新或 kernel-only 指令。

SSA 值和静态句柄以对象身份关联，块边目标必须是本函数 `body.blocks` 中的实际对象；块 ID 在函数内唯一。`FunctionDefinition.ref` 和 `DomainDeclaration.ref` 显式保存声明句柄。校验交叉核验句柄类别、函数签名、资源布局及初值，拒绝重复身份、布局不一致与跨函数使用。对象的附加调试字段不充当 SSA ID；内存模型仍不是冻结的序列化格式。

函数入口块参数对应函数参数；参数在全函数内有效。其余定义必须支配使用，同块必须先定义后使用。循环回边允许；不可达块仍完整校验，其局部定义只保证支配本块，不允许跨不可达块借用值（函数参数除外）。每个函数都必须有函数体，每个块必须已定义且具有合法终结；包括未被入口调用的函数和不可达块。

诊断具有稳定的 `code`、`message`、`location`。`location.path` 总是存在，例如 `functions[0].body.blocks[1].instructions[2]`；函数/块/指令使用从 0 开始的 `functionIndex`、`blockIndex`、`instructionIndex`，并附 `functionName`、`blockId`。终结位置使用 `.terminator` 路径与 `terminator: true`，不伪造指令序号。声明、策略或畸形外围上下文中不存在的字段会省略；读取输入抛错时定位为 `$`。稀疏数组和错误结构明确拒绝。

返回值仅针对本次稳定输入和策略有效，不是冻结的已链接产物或运行授权令牌。调用方必须在任何安装/执行前检查 `ok`，输入、策略或后端变化后重新检查；未来执行器仍需承担动态约束与运行故障处理。本包目前没有安装/执行入口，不把后端支持列表当作执行实现。

## 浮点单指令语义（#44）

`evaluateFloatInstruction(instruction: InstructionNode, operands: readonly RuntimeScalar[]): RuntimeScalar` 复用建图器/校验器的指令模型，不解释函数、分支或存储。`operands` 仅含 SSA 操作数的运行值，按其在指令中的顺序排列；谓词、目标类型、常量等 literal 已在指令节点中，不重复传入。

- `FloatBits = { readonly type: FloatType; readonly bits: HexBits }` 保存原始位，f32 必须恰好 8 个十六进制位，f64 恰好 16 位，均以 `0x` 开头。`RuntimeScalar = boolean | number | FloatBits` 是语义层值；两者统一定义在 `src/types.ts`，从包入口导出，供浮点与存储共用。不改变作者层 `Value` / `JSScalar` 或声明初值合同，也不引入 u64 算术。
- 所有浮点结果均为 `FloatBits`，整数/布尔结果仍为 number/boolean。浮点 number 输入按 SSA 声明精度量化，仅用于数值入口；需要保留 NaN 载荷/符号/信号位必须传 `FloatBits`，不得经过 JS number 往返。
- 支持浮点 `const` / `const.bits` / `select`、`float.add/sub/mul/div/fma/cmp/isNaN/isFinite`、`convert.intToFloat/floatToInt/float` 及仅 f32 与 u32/i32 间的 `bitcast`。这里采用模型中的 camelCase 操作名，不另造文本 IR 解析器。
- 内部使用无依赖的 BigInt 精确二进制整数/有理数计算，四则及 FMA 直接按目标精度最近值、居中取偶数舍入。每个 f32 操作独立舍入，FMA 不舍入中间乘积，保留次正规数及正确的有符号零；不会用 `a*b+c` 或 f64 中间结果冒充融合运算。
- 算术与浮点精度转换得到的 NaN 分别规范为 `0x7fc00000` / `0x7ff8000000000000`；`const.bits`、浮点选择与 bitcast 保留原始位。后续状态/数组/字节移动应直接搬运此位值，不将其解码为 number 再编码。此项未实现存储或公共总 dispatcher；#43 的 number-only 标量入口保持独立，不作为原始浮点位传输路径。
- 整数到浮点先验证来源整数范围，再按目标精度舍入；浮点到整数先按来源精度读取并向零截断，再严格检查目标范围，整数零规范为 number `0`。NaN、无穷或越界抛 `IRFloatEvaluationError`，`code` 为 `integer-overflow`；错误布局为 `invalid-instruction`，错误运行值为 `invalid-operand`，未实现的操作为 `unsupported-operation`。这些执行错误不复用静态校验诊断。

```typescript
import { createIRModule, evaluateFloatInstruction } from '@mica/ir';

const module = createIRModule();
module
  .func('fused', { params: ['f32', 'f32', 'f32'], results: ['f32'] })
  .body((b, [a, c, d]) => b.return([b.float.fma(a, c, d)]));
const instruction = module.functions[0]!.body!.entry.instructions[0]!;
const result = evaluateFloatInstruction(instruction, [1 + 2 ** -23, 1 - 2 ** -23, -1]);
// result: { type: 'f32', bits: '0xa8800000' }，即 -2^-46；非融合结果为正零。
```

`src/float.test.ts` 包含可复用的表驱动边界向量，包括融合/非融合、f32 经 f64 的双舍入差异、溢出抵消、次正规数、转换范围及带载荷 NaN 位移动，并使用真实 builder 节点与 `validateIR` 联合检查。`src/float.type-test.ts` 检查上述公开合同。

## 当前限制

以下能力属于后续任务，本包明确不实现：

- 整数/布尔运算及整数内部转换的执行语义（#43）。
- 状态、数组、普通字节存储的执行语义（#45）。
- 参考解释器、预算和异常定位（#46）。
- `resource.updateBytes` / `resource.fillBytes` 的版本化更新（#47）。
- 事件、输出、消息桥接、Provider 生成/checkpoint 与 JIT。

`module.functions` 中的函数体在 `.body` 成功返回后可见；尚未定义的函数保持 `body: undefined`，会被 `validateIR` 拒绝。本包不会把“可构建”或“静态检查通过”等同于“可执行”。

## 开发与验证

使用仓库现有 pnpm catalog、TypeScript、Vite、vite-plugin-dts 与 Vitest：

```bash
pnpm --filter @mica/ir typecheck   # 包含 src/api.type-test.ts 的正反类型用例
pnpm --filter @mica/ir test        # 运行期模型与建图结构测试
pnpm --filter @mica/ir build
```

类型测试只做编译期检查，不执行构建、不创建子进程或临时消费方。
