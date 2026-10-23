---
'@mica-js/ir': minor
---

新增 JIT 基线代码生成（#146）：把 MIR 编译为可用 `new Function` 构造的 JavaScript 源码。

- `jit/codegen/compile.ts`：`compileFunction(mfn, env)` / `compileFunctionWithSource`，按函数与环境缓存生成源码；宿主禁止动态代码时抛出 `JitCodegenUnavailable`，供后续层级回落。
- `jit/codegen/structure.ts`：支配树 + 后支配树 Stackifier（Ramsey 思路），生成 `if/else`、带标签 `for(;;)`、`continue`/`break`；不可归约或无法结构化的 CFG 自动回落到 `switch (pc)` 派发。
- `jit/codegen/segments.ts`：按宿主边界（`call`、executor、event、bridge、`checkpoint`）与终结符划分步段，计算 `stepsAfter` 并分配精确副本的独立 `LocId`。
- `jit/codegen/ops.ts`：完整操作表。整数运算以 `W(T, x)` 回绕、浮点按 D/U 表示生成原生运算、存储走 J3 typed array 快路径（大端宿主回退 DataView）、宿主调用经 `beforeHost`/`afterHost`。
- `jit/codegen/emit.ts`：生成函数外壳（局部变量、`L`、`try/catch`、`sourceURL`），所有字面量经 `k[i]` 常量表引用，绝不把用户字符串拼进源码。
- `jit/runtime-core.ts`：`JitRuntime` 计步状态机（`none`/`observer`/`budget`、`limitReached`、`flush`、`beforeHost`/`afterHost`）、`TAIL` 尾转移哨兵、`JitUnwind` 帧收集与 `createJitHelpers`。
- `jit/testing/compile-module.ts`：仅测试用的最小装配，编译整模块并驱动 `TAIL` 链；测试与参考解释器逐值、逐步数、逐错误对比。

以上模块仅供内部 JIT 使用，不从包入口导出。
