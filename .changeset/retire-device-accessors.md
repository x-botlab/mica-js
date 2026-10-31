---
'@mica-js/simulator': major
---

移除通用器件访问器与电路级调试查询，器件通信统一经步边界钩子进行。

- 移除 `DeviceAccessor` 系列类型、`Circuit.devices`、自定义访问器，以及 `Circuit.jit`、`getPin`、`getVoltage`、`getCurrent` 与 `getDiagnostics`。
- 移除 `SchematicDeviceBinding.read` / `deliver` 状态适配器；通过 `DeviceSimulationHost.deliver` 排队输入，由工厂的 `applyInputs` 消费、`flushOutputs` 发布结果。
- 移除未完整实现步边界输入输出的 `createCircuitDeviceSimulationHost` 及其选项类型；使用 `createSchematicDeviceSimulationHost` 或 sandbox 入口集成宿主。

迁移说明见 [电气模型迁移指南](../docs/migration/resistive-electrical-model.md)。
