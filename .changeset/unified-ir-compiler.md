---
'@mica-js/simulator': minor
---

新增统一 IR 编译器（U01，`src/unified-ir/compiler/`）：把多个器件描述与引脚连线直接编译成一个 `@mica-js/ir` module，器件 tick、电气解算、器件 update 和主循环共用一块全局引脚/状态空间。

- `compileCircuit({ devices, connections }, options?)`：主入口，返回 `CompiledCircuit`（`module`、`entryPoints`（名称 + 可执行 ref）、`pinMap`、`deviceMap`、`netlist`、`pins`、`states`、`validation`、`executionOrder`）。生成后自动跑 `validateIR`。
- `GlobalResourceAllocator`：引脚按声明顺序连续编号（每器件 ≤ 32，整块 ≤ 256）且永不重叠；器件状态按标量类型分配进共享 `device_state_<type>` 数组，`DeviceMetadata` 给出 `pinOffset` / `stateOffset` / 状态槽。
- `NetworkTopologyAnalyzer`：连接图 → 并查集连通分量 → 按首次出现编号的网；区分 `drivers` / `loads` / `sinks`，支持 `GND`/`VCC`/`VDD` 及自定义固定电平轨；输出 `driver-conflict`、`power-short`、`rail-conflict`、`floating-net` 诊断。
- `DeviceIRGenerator`：每个 phase 一个函数（`<id>_initialize` / `<id>_tick` / `<id>_update`），域指令内联为 `pin_mode` / `pin_output` / `pin_input` 上的 `array.load/store`；内置 `mcu`/`teaching-mcu` 与 `led`/`ideal-led` 内核（提取自原型 `device-mcu.ts` / `device-led.ts`），其它类型用 `description.behaviors` 声明行为；无 `initialize` 但有输出引脚时自动生成推挽配置。
- `ElectricalSolverGenerator`：每张网一个 `solve_net_<id>`，单驱动为无分支 `mode == push-pull && output`；`allowMultiDriver` 时按线与（wired-OR）解算；无驱动网读取轨电平或常量低。
- `MainLoopGenerator`：`unified_initialize`、`unified_tick`（一次完整步进，驱动 → 解网 → 负载）与 `unified_tick_batch(count)`（模块内循环，一次引擎调用跑完整批）；器件按驱动/负载依赖排序，反馈环回退声明顺序。
- 错误统一为 `UnifiedIRCompilerError`（`invalid-input`、`duplicate-device`、`unknown-device`、`pin-not-found`、`state-not-found`、`invalid-connection`、`capacity-exceeded`、`unsupported-device`、`driver-conflict`、`power-short`、`rail-conflict`、`invalid-ir`），引脚错误消息形如 `Pin 'mcu1.PA0' not found. Available: [...]`。
- 新增 `compiler.test.ts`（50 例：分配、拓扑、器件/解算/主循环生成、错误路径、确定性）与 `integration.test.ts`（11 例：JIT 上 MCU → LED 信号传播、VCC/GND 轨、自定义器件、双向引脚、类型化状态、JIT/参考解释器一致、批处理、编译 < 200 ms 与 1000 tick（约 0.4 ms）性能门槛）。
