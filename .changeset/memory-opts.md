---
'@mica-js/ir': minor
---

新增 JIT 内存优化 passes（#152），在保持 C5 的前提下消除 DBT 风格 IR 的存储访问瓶颈：

- `jit/passes/load-elim.ts`：基于资源身份别名分析的前向数据流。冗余加载改写为 `forward`（保留原 `node`/`loc`/步数），存储转发仅在 `D` 浮点值上启用；`U` 浮点、`bytes` 宽度/字节序不一致、宿主指令与 `call`/`checkpoint` 屏障都会按规格失效。
- `jit/passes/scalar-promotion.ts`：把循环内热点的 `state` 资源与常量下标 `array` 元素提升为局部变量（`ps<n>` + 脏标记）。入口与每个屏障后重载；宿主指令、`call`、`checkpoint`、`return`、`dispatch` 前写回，之后失效重载；`catch` 中先写回所有脏值再重抛。`state.store`/`array.store` 的原位置保留挂起检查，经公开存储方法抛出原错误。
- `jit/passes/bounds-elim.ts`：复用 #151 的区间分析做静态越界检查消除；对基本归纳变量的循环生成 `bounds.guard` 并在前置块用分支选择「无检查的克隆循环 / 原循环」。守卫不计步、不可抛，慢路径保持原指令，越界仍在原位置报错。
- `jit/passes/memory-model.ts`：三个 pass 共用的位置、别名与屏障模型。
- `jit/passes/index.ts`：`runMemoryPasses`（`loadElim → scalarPromotion → boundsElim`）与 `runJitOptimizationPipeline`（#151 标量流水线之后接入内存 passes）。
- MIR/代码生成：新增 `forward`、`promote.load`、`promote.store`、`promote.reload`、`bounds.guard` 与 `MFunction.promotions`、`MInst.uncheckedBounds`；`check` 支持 `none`/`divzero`/`f2i`/`bounds` 四种形式。
- 测试：`passes/*.test.ts` 覆盖加载消除、标量提升、越界外提、16×u32 DBT 寄存器文件、故障/预算/宿主回调时的存储一致性，并注册到 pass matrix。
