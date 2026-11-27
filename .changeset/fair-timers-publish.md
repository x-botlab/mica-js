---
'@mica-js/compiler': minor
'@mica-js/simulator': minor
'@mica-js/sdk': minor
---

支持可观察的 JIT 停驻与可中断的外设合批。JIT 按原指令时刻发布停驻前缀，依赖失效后从实际 PC 恢复并保留剩余耗时。合批支持 16 位填充和搬运、关联状态和带时间戳的逐项输出，并允许外设在 CPU 等待期间使用经调度验证的时间窗。SDK 器件入口导出停驻检查点类型。
