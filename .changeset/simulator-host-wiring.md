---
'@mica-js/simulator': patch
---

为 `DeviceSimExecutor` 增加宿主接线口 `DeviceSimExecutorOptions.host`：工厂在每次 `loadSchematic` / `reset()` 建运行时各调用一次，拿到该运行时自己的 `scheduler` 与 `schematic`，返回逐实例的 `pinHost`、`topology`、`instanceOptions`（例如 `updateResources: ['firmware']`）以及实例销毁后的 `dispose`。执行器仍不拥有电路定义，只负责透传与生命周期排序（先销毁实例，再释放宿主接线）；工厂抛错时按“先建后换”保留旧运行时，`dispose` 抛错转成 `simulator/dispose-failed` 诊断。这样 `b.pin.*` / `b.observeDigital` / `b.connection.apply` 的器件（例如 `packages/device/examples` 的按钮、继电器与教学 MCU）才能真正通过执行器运行；未配置 `host` 时的行为不变。
