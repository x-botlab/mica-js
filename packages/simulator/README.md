# @mica-js/simulator

在虚拟时钟上运行电路与原理图器件。`@mica-js/simulator` 提供统一 IR 的 `Circuit`，以及用于原理图集成的 `DeviceSimulationHost`；`@mica-js/simulator/sandbox` 提供沙箱宿主接入。本包不内建任何具体器件模型，器件定义由调用方提供。

**迁移提示：**新电路代码使用 `Circuit.create()` 的统一 IR 路径；`createDeviceSimExecutor()` + `createCircuitHost()` 调度器路径仅为现有原理图/画布集成维护，不早于 1.0 移除。
