---
'@mica-js/simulator': minor
---

统一 IR 架构收尾（U05–U09）：公开 API、迁移文档、性能基准与旧路径弃用。

- **公开统一 IR**：包入口新增 `Circuit` / `CircuitError` / `compileCircuit` / `UnifiedIRCompilerError` /
  `createCircuitFromSchematic` / `createSingleDeviceCircuit` / `createLedIR` / `createButtonIR` /
  `createTeachingMCUIR` / `createTeachingMCUCircuit`，以及 `LedIRAccessor`、`ButtonIRAccessor`、
  `TeachingMCUAccessor`、`DeviceAccessor`、`StorageAccessor`、`CircuitRuntimeOptions`、
  `CircuitCompilationInput`、`DeviceDescription` 等类型和 `UNIFIED_PIN_CAPACITY` / `DEVICE_PIN_STRIDE` /
  `PIN_MODE` 常量。`createMcuDescription()` 与 `createLedDescription()` 提供内置内核的描述。
- **弃用调度器路径**：`createDeviceSimExecutor()` 与 `createCircuitHost()` 在 TSDoc 中标记
  `@deprecated`，新电路代码应使用 `Circuit.create()`。它们仍是"原理图 → 器件模块实例 + widget 消息"
  的唯一路径，保持完整支持与缺陷修复，不早于 1.0 移除；状态与时间表见 `docs/DEPRECATIONS.md`。
- **移除内部原型**：删除从未导出的 v0 原型（`createUnifiedCircuit`、`generateUnifiedIR`、
  `planUnifiedCircuit` 与 `fixtures/` 的硬编码 mcu/led/net 生成器），共 7 个文件、净减 1524 行；
  `createModuleValidation` 与引脚空间常量迁到 `unified-ir/validation.ts`、`unified-ir/pin-space.ts`。
  由于原型从未出现在包的 `exports` 中，此改动不影响对外 API。
- **文档与示例**：新增 `docs/MIGRATION.md`（旧 API 对照、器件迁移、自定义器件、错误处理、FAQ）、
  `docs/API.md`（`Circuit`、`compileCircuit`、器件工厂与访问器参考）、`docs/PERFORMANCE.md`
  （环境、结果、口径、复现）与 `examples/`（LED 闪烁、按钮控制 LED、教学 MCU 真实固件、吞吐基准）。
  `pnpm --filter @mica-js/simulator examples` 会执行并校验全部示例。
- **性能**：MCU + LED 同场景对比调度器路径 8.1 µs/tick → 单步 371 ns（21.9×）→ 批处理 6.8 ns
  （约 1200×）；1M tick 实测 56–85 M tick/s；教学 MCU 时间切片 320 M inst/s，长切片对照
  teaching ISA 11.2 M inst/s（70×）、M3 27.1 M inst/s（169×）。新增 `bench/unified-micro.bench.ts` 与
  `bench/unified-devices.bench.ts`，并把 `bench/unified-simple.bench.ts` 改写到 `Circuit` API。
