# 基于规范的生成测试

人工 `.case.md` 定义语义，生成器探索组合空间，独立 Oracle 判断正确性。生成测试通过 `ConformanceAdapter`、`loadAdapter` 和已有的 `semantics/fixture.mjs` 接入编译器与运行时。

## 当前范围

- `domains/expressions.mjs`：按结果类型递归构造 `number` / `bool` AST，覆盖算术、位运算、比较、逻辑短路、条件选择和属性/state 读取。相同 AST 分别输出 DDL 和手工 IR。IR 发射器以规范的 `DeviceIR` / `OperationIR` 合同进行类型检查。
- `oracles/expressions.mjs`：独立树解释器以 AST 和绑定值为输入，按语言规定的 JavaScript binary64 运算计算预期值。简单过程参考状态机按生成的等待序列计算 tick、时间与输出；DDL、手工 IR、不同 `runUntil` 切片分别与该预期比较。
- `domains/electrical.mjs`：按构造规则生成含明确参考点的连通正电阻网络、阈值与合法推进序列。独立节点方程与带选主元的消元计算预期电压；按测试定义的浮点误差范围比较实际电压，检查数字电平，以及电阻整体缩放、并联拆分和推进切片性质。

规则来自 [表达式](../../docs/spec/language/expressions.rst)、[类型](../../docs/spec/language/types.rst)、[IR 操作](../../docs/spec/ir/operations.rst)、[电气模型](../../docs/spec/electrical.rst)、[调度](../../docs/spec/execution/scheduling.rst) 和 [通道](../../docs/spec/channels.rst)，由生成器与 Oracle 显式编码。规范变化时同步审查两者。

每个 domain 提供生成规则和预期结果检查；调度与 JIT 的组合测试可通过同一接口扩展。

## 执行

```powershell
pnpm test:generated:unit
pnpm typecheck:generated
$env:MICA_CONFORMANCE_ADAPTER = 'D:\path\to\real-adapter.mjs'
pnpm test:generated --require-adapter
pnpm test:generated:daily --require-adapter
pnpm test:generated:fuzz --require-adapter
```

Oracle 的已知答案、生成合法性和缩减不变量检查可独立执行。语义测试通过真实 adapter 执行；adapter 缺省时报告 `UNCONNECTED`，执行报告状态为 `unconnected`。`--require-adapter` 要求已连接的执行环境。

| Profile | 每个 domain 的固定 seed 数 | 每个 seed 的生成预算 | 结构深度/规模参数 | 每次检查超时 | 每个 seed 总预算 |
| --- | --- | --- | --- | --- | --- |
| `pr` | 1 | 50 | 3 | 5 秒 | 30 秒 |
| `daily` | 4 | 2,000 | 5 | 5 秒 | 120 秒 |
| `fuzz` | 8 | 10,000 | 7 | 3 秒 | 300 秒 |

这些数值用于分配执行预算。所有 profile 都使用代码中固定的 int32 seed 列表；可以用 `--domain expressions`、`--seed 123`、`--runs 100` 和 `--timeout 2000` 调整实验。

所有被测 adapter 调用及其 Oracle 比较均在子进程中运行，每个进程的 V8 堆上限为 512 MiB，进程总资源由运行环境管理。生成及缩减协调器在父进程中运行。超时或崩溃后终止被测进程，后续缩减在新进程执行。初始化单独限制为 30 秒，配置错误归入执行错误。相同 campaign 内成功的检查复用进程，每次检查都创建并释放独立板。

## 反例与回归

fast-check 对失败输入继续 shrinking。类型化生产式和拓扑构造在缩减过程中保持输入有效。失败候选先原子写入 `test-results/generated/*.pending.json`；完成后写入 `regressions/*.json`，后续生成测试自动先回放这些回归。

反例包含具体 AST/拓扑/序列、seed、fast-check 版本、缩减路径、规模和单次超时。失败输出提供完整的 `--replay` 命令，按保存的具体输入和超时回放；`--timeout` 可覆盖回放超时。

Shrinking 完成时保存基于当前缩减关系的局部最小反例；时间预算耗尽时保存最新已知失败输入，并标记 `shrink.completed: false`。其余时间预算耗尽的情况归入执行错误。自动持久化的 JSON 是普通回归源文件，可随修复提交；人工用例使用现有 `.case.md` 体系。

执行状态保存在 `test-results/generated/report.json`，分别记录通过、失败、未连接和执行错误。

## CI

[Generated Conformance](../../.github/workflows/generated-tests.yml) 在 PR 与主分支变更时运行 `pr`；每天 UTC 19:23 运行 `daily`；手动 dispatch 可选择 `fuzz` 并指定 seed/预算。失败与执行状态始终上传为 30 天保留的 artifact，包括未完成缩减的 checkpoint。

仓库变量 `MICA_CONFORMANCE_ADAPTER` 指向 checkout 中 adapter 模块的相对路径，模块将调用转发给实际编译器和运行时。配置完成后，CI 按对应 profile 执行差分与性质检查。当前语义测试状态为 `unconnected`，Oracle 与生成器检查可直接运行。
