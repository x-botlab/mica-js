# 规范符合性测试

依据 [仿真规范](../../docs/spec/index.rst) 检验公开行为。每份 `.case.md` 同时保存验收说明、输入、执行步骤和断言。目录中的器件模型是代表性样本，不是真实芯片完整模型。

## 运行

```powershell
pnpm test:conformance
pnpm test:conformance:report
pnpm typecheck:conformance
```

默认加载并运行 Markdown 用例。未提供真实实现时，编译和执行用例标记 `UNCONNECTED` 并跳过。报告显示用例数量和实际执行结果。

## 接入实现

提供一个 ESM 模块，以默认对象导出 [适配接口](../../packages/conformance/src/adapter.d.ts) 中的函数：DDL 编译、器件库建立、板建立及两个 Builder 工厂。适配器仅转接真实实现，模型和预期由测试提供，不在适配器中实现求解、调度或测试特例。

```powershell
$env:MICA_CONFORMANCE_ADAPTER = 'D:\path\to\real-adapter.mjs'
pnpm test:conformance
pnpm test:conformance:strict
```

显式配置的适配器导入失败或缺少入口时测试失败。严格模式要求接入真实适配器。

## 用例说明

每份 `.case.md` 用正文说明规范来源、前提、操作和预期，用代码块提供输入、执行步骤与断言。默认围绕一项清晰行为编写；验证交互时写清完整的操作序列和预期。规范引用、断言充分性和重复行为在 review 中检查。

框架统一执行用例，报告通过、失败、跳过和未运行的数量。`--report` 仅生成用例统计，执行状态记为未运行。

## Markdown 样本

一个 `*.case.md` 文件就是一个独立案例，也是唯一的用例格式。加载器递归扫描六个用例层目录中的 `*.case.md`，层级由所在目录决定。`templates/` 与 `examples/` 供复制和阅读，不登记为用例。共享模型和辅助模块可以独立保存，由 Markdown 显式引用。

| kind         | 必填二级章节，按执行顺序      | 模板                                         |
| ------------ | ----------------------------- | -------------------------------------------- |
| `compile`    | 输入 → 执行步骤 → 断言        | [编译模板](templates/compile.template.md)    |
| `simulation` | 模型 → 装配 → 执行步骤 → 断言 | [仿真模板](templates/simulation.template.md) |
| `comparison` | 对照输入 → 执行步骤 → 断言    | [对照模板](templates/comparison.template.md) |

frontmatter 只包含 `kind`，用例名称由相对文件路径生成。每个必填执行章节恰好一个非空围栏代码块；正文可穿插解释文字，说明章节自由组织。加载器按上述执行章节顺序提取代码。

模型使用 `ddl`；装配使用 `json`。输入与对照输入使用 `ddl` 或 `json`；执行步骤与断言使用 `typescript`。JSON 输入会解析成对象，DDL 输入保持原文。Builder 在执行步骤中通过 `adapter` 调用。

执行器注入：

- `adapter`：真实编译器与运行时适配器。
- `assert`：`node:assert/strict`。
- `t`：Node 测试上下文，使用 `t.after(() => board.dispose())` 注册清理。
- `modelSource`、`description`：仿真类的模型原文与装配对象。
- `input`：编译类输入；`inputs`：对照类输入。
- `importModule('./fixture.mjs')`：相对当前 Markdown 文件加载共享辅助模块，仅接受 `./` 或 `../` 相对路径。

执行步骤和断言共享同一个异步作用域，按顺序执行；各案例重新创建局部作用域与 JSON 对象。加载时检查结构与 TypeScript 语法，即使未配置适配器也执行这些检查；TypeScript 转译不等于静态类型检查。错误报告包含 Markdown 文件、章节及行号。

这些代码是受信任的仓库测试代码，以 Node 权限执行，不是安全沙箱。代码块通过 `importModule` 复用辅助模块，模块自身可以使用正常 ESM 导入。代码块中使用 `importModule`，而不是静态 `import`、`export` 或原生动态 `import()`。资源释放由 `t.after` 负责。

## 组织与断言

- `static/language/`、`static/ir/`：语言接受/拒绝、作用域、效果与 IR 校验；精确类型反例沿用 [类型合同测试](../../docs/spec/contracts/type-tests.ts)。
- `semantics/electrical/`、`semantics/scheduling/`、`semantics/memory/`、`semantics/channels/`：电气、调度与 reaction、存储、通道执行语义。
- `host/`、`jit/`：生命周期、批次、指令边界、中断与失效。
- `devices/`：12 类器件的模型、适配源码及端到端案例；只有被执行案例引用并断言的行为计为测试。
- `consistency/`：等价入口与推进切片等差异验证，仍需独立预期。

执行框架位于私有 workspace 包 [@mica-js/conformance](../../packages/conformance/README.md)，包含 Markdown 加载执行、用例发现、元数据解析、断言辅助和结果统计。依赖由该包声明；用例说明、器件模型、具体断言和项目运行入口留在本目录，入口直接使用该包。

每个用例的输入、执行步骤与预期就近保存在 Markdown 中。共享辅助模块只提供模型构造、收集或断言工具，案例自身保留被验证的操作与关键断言。板实例在 `finally` 或 `t.after` 中释放。断言可观察输出、内存、话题、时间与错误，不读取内部调度队列。

电压使用用例显式给出的容差，时间、阈值和事件次序按合同精确比较。随机用例固定种子或四字状态。涉及未读输入清理的推进切片不能无条件宣称结果相同。无限循环及无限反馈的外部终止测试需独立进程隔离后接入，不在主测试线程执行。
