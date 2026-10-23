---
'@mica-js/core': minor
---

feat(core): IR 实例默认使用 JIT 引擎

- 新增 `IRSchedulerInstanceDefinition.engine` 选项（'jit' | 'reference'，默认 'jit'）
- 切换到 `stepBudget` 协议实现批量步数检查
- 两种引擎的可观测行为完全等价
- 性能提升约 256×（相对参考解释器）
