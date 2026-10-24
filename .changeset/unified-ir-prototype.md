---
'@mica-js/simulator': minor
---

新增统一 IR Module 原型（`src/unified-ir/`）：把整块电路的器件逻辑、电气网络解算和主循环生成到**一个** `@mica-js/ir` module，去掉"每器件一个 module + 调度器 + 宿主边界"的每 tick 开销。

- `createUnifiedCircuit(config, options)`：顶层 API，编译生成好的 module 并暴露 `tick()` / `run(count)` / `readPinMode` / `readPinInput` / `readPinOutput` / `ledOn` / `pinOf`，`engine: 'reference'` 可切到参考解释器逐值对照。
- `generateUnifiedIR(config)`：生成器。按依赖顺序生成 `mcu_tick`、`solve_net_N`、`led_update`，再生成 `unified_step`（一次完整步进）与 `unified_tick(steps)`（模块内的批处理循环）；整批 tick 只需要一次引擎调用。
- 全局引脚空间 8 器件 × 32 引脚：`pin_mode[256]`（u8，0 高阻 / 1 推挽 / 2 开漏 / 3 模拟）、`pin_output[256]`、`pin_input[256]`、`led_state[8]`。
- `planUnifiedCircuit(config)`：生成前校验引脚偏移 32 对齐、引脚不跨网复用、`globalPinId` 与器件布局一致、器件 id 与生成函数名不冲突；错误统一为 `UnifiedCircuitError`。
- `createMcuLedCircuit()` 提供 MCU + LED 的标准电路（`mcu.PA0 → led.anode`，`led.cathode → ground`）；`createModuleValidation(module)` 从模块自身收集指令授权，供基准里的多 module 对照使用。
- 性能（本机，MCU + LED，每 op 2000 tick）：现有架构约 8.2 µs/tick；统一 module 单次宿主调用约 390 ns/tick（≈21×），模块内批处理约 7 ns/tick（>1000×）；1M tick 约 15 ns/tick（≈68 M tick/s）。单次 `tick()` 的下限由 `@mica-js/ir` 的每次执行入口开销决定（空 module 也约 300 ns），因此吞吐路径是 `run(count)`。
- 新增 `bench/unified-simple.bench.ts`（`pnpm --filter @mica-js/simulator bench:unified`）做与现有架构的对比，并用 `bench/current-architecture.ts` 复现"两个 IR module + 调度器 + JS 解网"的基线；`circuit.test.ts` 覆盖引脚翻转、网络传播、LED 状态、高阻、参考解释器等价、多器件、配置校验与性能门槛。
- 现有 `createDeviceSimExecutor` + 调度器 + 电气层路径完全不变，原型是独立实现。
