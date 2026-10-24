---
'@mica-js/simulator': minor
---

新增统一 IR 教学 MCU（U03，`src/unified-ir/examples/teaching-mcu/`）：把真实的 Cortex-M3 级教学器件迁移到统一 IR 架构，验证编译器与运行时在复杂器件上的可用性。

- `createTeachingMCUIR(id, config)`：返回 `IRDevice`，包含独立 `@mica-js/ir` module（`initialize` / `tick` / `update`）、布局、验证授权和 `device`（可直接交给 `Circuit.create`）。支持 16 个 32 位寄存器、NZCV、flash/RAM/外设统一地址空间、PA0–PB15 GPIO、32 路 NVIC、异常压栈/返回、WFI 睡眠与 `m3`/`teaching` 两种指令集。
- 指令执行使用按 PC 缓存的 Provider 基本块，块内直接发射 IR；`instructionsPerTick` 控制每个 tick 的指令片，`maxBlockInstructions` 控制翻译块上限。GPIO 写入在块末尾同步到共享 `pin_mode` / `pin_output`，host 通过访问器写入的 ODR/DIR 也会立即同步；所有引脚参与电气网络求解。
- `buildAccessor(deviceId, storage, layout?, options?)` + `TeachingMCUAccessor`：寄存器（`r0`–`r15`、`pc`、`sp`、`lr`、`xpsr`、`cycles`、`ipsr`）、内存（`readMemory` / `writeMemory` / block 读写、flash 写保护）、GPIO（ODR/DIR/IDR、引脚读写）、NVIC（enable/pending/active/priority、`raiseInterrupt` 等）、`step` / `run`、`snapshot` 与兼容 `McuAccessor` 的 `readRegister` / `writeRegister`。
- `patchFirmware(address, bytes)` 保留 legacy `firmwarePatch` 能力：host 通过 versioned update 修改只读指令 flash，自动失效受影响的 provider 块并同步可写数据镜像；guest 仍然不能写 flash。编译器新增可选的 `DeviceDescription.updateResources`，用于给只读字节区授予 host `update` 权限。
- 编译器新增 `DeviceDescription.kernel` 钩子：在 phase 函数体之前声明器件私有数组/字节内存/Provider，并可直接返回 phase 函数 ref（无 wrapper）；`DeviceDescription.accessor` 让器件自带类型化访问器。两者都是向后兼容的可选字段。
- 运行时 `Circuit.reset()` 现在也会恢复**可写 bytes** 内存（此前只恢复 array/state），因此 MCU 的 flash/RAM/外设镜像可以完整复位。
- 新增 `teaching-mcu.test.ts`（45 例：配置、M3 与 legacy ISA、标志位、内存、GPIO、NVIC、异常周期、固件补丁、访问器）、`teaching-mcu.integration.test.ts`（12 例：`Circuit.create` 类型化访问器、固件补丁、LED、GPIO MMIO、IRQ handler、单步/批处理一致、reset、dispose、便捷工厂）与 `teaching-mcu.performance.test.ts`（真实 legacy 调度器基线 vs 统一 JIT；本机实测 teaching 批处理 ≈13 M inst/s（≈70×），M3 批处理 ≈30–34 M inst/s（≈170–190×），单步 ≈2.1 M inst/s（≈11×））。
- 现有 `mcu`/`teaching-mcu` 内置内核、U01 编译器与 U02 运行时路径保持兼容；`Circuit` 的通用引脚/状态访问器不变。
