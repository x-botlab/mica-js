# @mica/ir

领域无关的 IR 数据模型、同步类型化建图器、实例存储与静态校验/链接诊断，对应 [#41](https://github.com/x-botlab/mica-js/issues/41)、[#42](https://github.com/x-botlab/mica-js/issues/42)、[#45](https://github.com/x-botlab/mica-js/issues/45)。规范依据为 [IR SPEC #26](https://github.com/x-botlab/mica-js/issues/26) 与 [器件作者 API #8](https://github.com/x-botlab/mica-js/issues/8)。

本包负责**建图、实例存储与静态校验/链接诊断**：声明标量资源与函数、构造 SSA 值、基本块和终结指令，为每个实例建立独立的声明资源存储，并通过 `validateIR` 检查实际内存模型、控制流与能力策略。它不执行 IR，也不提供解释器、资源版本化更新、Provider、消息桥接或 JIT。校验通过不代表已经安装或执行，尚未实现的能力不会以空操作伪装为成功。

## 公共入口

唯一公开入口为 `@mica/ir`，构建生成 `dist/index.js`（ESM）与声明文件。主要导出：

- `createIRModule()`：创建独立的模块声明/建图上下文，返回 `IRModule`。
- `createIRStorage(module)`：为模块的声明资源创建一份独立实例存储，返回 `IRStorage`；每次调用互不别名。
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

## 实例存储

`createIRStorage(module)` 按声明初值建立固定容量的实例存储。底层 buffer 不公开，读写只能经过带完整校验的方法：

```ts
import { createIRModule, createIRStorage } from '@mica/ir';

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
- 普通 `store` / `copy` 只改变内容，不维护或更新任何资源版本；版本化更新由后续 [#47](https://github.com/x-botlab/mica-js/issues/47) 提供。
- `state.load` / `array.load` / `bytes.load` 返回 `StorageValue<T>`：`bool` 为 `boolean`、整数为 `number`、浮点为 `FloatBits`。浮点 load 返回原始位模式，移动不会解码/重编码 NaN；`store` 接受 `number`（数值入口，NaN 使用规范编码）或同类型 `FloatBits`。
- 失败抛出 `IRStorageError`，`code` 为 `invalid-resource`、`invalid-value`、`invalid-argument`、`out-of-bounds`、`readonly-resource` 或 `allocation-failure`。资源授权仍由 `validateIR` 的 `resources` 静态核验；存储负责运行期的类别、可写性和范围检查，二者互不替代。

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

## 当前限制

以下能力属于后续任务，本包明确不实现：

- 整数/布尔/浮点运算的执行语义（#43、#44）。
- 将存储接入参考解释器、预算和异常定位（#46）。
- `resource.updateBytes` / `resource.fillBytes` 的版本化更新（#47）。
- 事件、输出、消息桥接、Provider 生成/checkpoint 与 JIT。

`module.functions` 中的函数体在 `.body` 成功返回后可见；尚未定义的函数保持 `body: undefined`，会被 `validateIR` 拒绝。本包不会把“可构建”或“静态检查通过”等同于“可执行”。

## 开发与验证

使用仓库现有 pnpm catalog、TypeScript、Vite、vite-plugin-dts 与 Vitest：

```bash
pnpm --filter @mica/ir typecheck   # 包含 src/api.type-test.ts、src/storage.type-test.ts 的正反类型用例
pnpm --filter @mica/ir test        # 运行期模型、建图结构与实例存储测试
pnpm --filter @mica/ir build
```

类型测试只做编译期检查，不执行构建、不创建子进程或临时消费方。
