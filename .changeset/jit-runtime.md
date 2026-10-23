---
'@mica-js/ir': minor
---

新增 `createIRJIT` JIT 执行引擎（#147）：与参考解释器共享创建契约、`storage` 与 `execute` 接口，并在 `values`、`steps` 与 `IRExecutionError` 上逐项等价。

- 模型函数首次调用时降级并编译，编译后的函数替换 `H.fns` 槽；Provider 产物在首次 `dispatch` 或 checkpoint 恢复时编译，按产物身份缓存。
- `dispatch` 与失效 checkpoint 通过 `TAIL` 哨兵和 `runTail()` 蹦床执行，派发链不增长 JS 栈；产物以 `artifact.index` / `artifact.name` 降级，错误位置与调用栈与参考一致。
- 每次派发校验产物依赖，并递归检查整条 Provider 调用链；深层依赖失效时重新生成并重编译。
- `maxSteps`、`stepObserver`、`stepBudget` 保持参考语义；执行结束时提交已开始的步骤。
- `IRJITTuning` 支持 `tier`、`codegen`、`warmup`、`artifactWarmup`、`maxCompiledDepth`、`optimizations` 与 `debug.verify`；非法值报 `invalid-options`。
- `new Function` 不可用时 `codegen: 'auto'` 静默回落到共享同一 `storage` 的参考解释器；`codegen: 'require'` 在创建期以 `invalid-options` 拒绝。
