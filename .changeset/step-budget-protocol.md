---
'@mica-js/ir': minor
---

新增可选的 `stepBudget` 批量计步协议：`IRInterpreterOptions.stepBudget` 接受 `{ remaining(ctx), consume(ctx, n) }`，引擎可以把多步合并为一次 `consume` 调用。参考解释器每步调用 `consume(ctx, 1)` 且从不调用 `remaining`；`stepBudget` 与 `stepObserver` 互斥，同时提供时以 `invalid-options` 拒绝。
