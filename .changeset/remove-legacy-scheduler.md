---
'@mica-js/core': minor
---

移除旧调度器执行引擎：`createScheduler`、`createIRSchedulerInstance`、`Scheduler*` 类型与 `SchedulerError`、`createPowerRuntime` / `Power*`、`createTopologyRuntime` / `Topology*` 不再导出；整数皮秒时间工具继续从包根导出。

`@mica-js/device` 以 0.3.0 为最后一个版本，后续不再发布；器件模型改由调用方基于统一 IR 的 `DeviceDescription` 提供。
