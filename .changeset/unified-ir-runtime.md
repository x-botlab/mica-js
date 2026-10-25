---
'@mica-js/simulator': minor
---

新增统一电路运行时（U02，`src/unified-ir/runtime/`）：在 U01 编译产物之上提供批处理、单步、重置和类型化器件访问器，替代"调度器 + IRSchedulerInstance"的宿主侧写法。

- `Circuit.create(input, options?)`：调用 `compileCircuit` → `validateIR`（可关）→ `createIRJIT`，并自动执行一次 `initialize`；`const` 泛型推断器件 id 与类型，`circuit.devices.led1.isOn()` / `circuit.devices.mcu1.readRegister('R0')` 直接有类型。
- `runBatch(count)`：走模块内 `unified_tick_batch` 入口，一次引擎调用跑完整个 u32 批次，`tickCount`（bigint）在调用成功后才累加；`step()` 为单步入口，供调试使用。
- `reset()`：把 `module.memories` 的声明初值写回所有引脚数组与器件状态，再重跑 `initialize`，`tickCount` 归零，行为与新建电路一致。
- `getPin('mcu1.PA0')` / `setPin(...)`：按 `<器件>.<引脚>` 读写；有感知的引脚读解算结果，纯驱动引脚读 `mode == push-pull && output`；`setPin` 对驱动引脚写输出锁存、对感知引脚覆盖解算值直到下一次 tick。
- 器件访问器：LED（`led`/`ideal-led`）提供 `isOn()`/`lampState`；MCU（`mcu`/`teaching-mcu`）提供 `readRegister`/`writeRegister`（bool/整数状态当 `bigint` 寄存器）及 `readPin`/`writePin`；所有器件都有 `getState`/`setState`，未知类型保留通用表面。
- 便捷工厂：`createSingleDeviceCircuit(type)` 用内置内核造单器件电路；`createCircuitFromSchematic(schematic, { devices, resolveDevice })` 从 `deriveSchematicTopology` 网表生成电路，designator 作为器件 id（非法字符自动规范化并去重）。
- 错误统一为带 `code` 的 `CircuitError`（`invalid-options`、`invalid-count`、`pin-not-found`、`pin-not-writable`、`state-not-found`、`invalid-state-value`、`register-not-found`、`invalid-register-value`、`unresolved-device`、`disposed`），引脚/状态/寄存器缺失时消息列出所有可选值；`dispose()` 幂等，之后连同已取出的访问器一起拒绝调用。
- 新增 `runtime.test.ts`（30 例：创建、批处理、单步、重置、访问器、寄存器、引脚与错误路径）、`integration.test.ts`（17 例：MCU → LED 传播、大批量计数、JIT/参考解释器一致、线与、自定义电平轨、工厂与原理图转换）与 `performance.test.ts`（创建、批处理、单步性能观测，只输出数字、不断言；本机实测约 37 ms / 60–90 M tick/s / 0.45–0.5 µs）。
- 现有 `createDeviceSimExecutor`、调度器、电气层与 U01 编译器路径完全不变。
