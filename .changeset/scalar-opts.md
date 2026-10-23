---
'@mica-js/ir': minor
---

新增 JIT 标量优化 pass（#151）：`sccp`（稀疏条件常量传播、分支折叠与不可达块删除）、`gvn`（支配树作用域上的全局值编号/CSE，含纯但可抛指令）、`range`（整数区间分析、循环头加宽与分支细化）、`licm`（循环不变量外提）与 `dce`（死代码消除，可抛操作降级为 `Check`）。

- 每个 pass 都是 `MFunction → MFunction` 的纯函数；`packages/ir/src/jit/passes/{sccp,gvn,range,licm,dce}.ts` 可单独开关。
- 步数不变量保持不变：被删除或移动的指令在原位置留下 `step = 1` 的 `Check`，外提指令使用 `step = 0`。
- `IRJITOptimization` 新增 `sccp`、`gvn`、`range`、`licm`、`dce` 开关，默认全部开启；`pass-matrix` 为每个 pass 增加单独关闭的行。
