---
'@mica-js/simulator': minor
---

新增 RFC 0002 完整电压求解器与模拟 I/O：统一 IR 现在为每条网络解出实际电压，支持模拟输入/输出、门限判定与强驱动冲突暂停。

- 内存：`CompiledCircuitMemory` 新增 `pin_voltage`（`f32`，解算电压）、`pin_voltage_intent`（`f32`，模拟输出意图）、`pin_low_threshold` / `pin_high_threshold`（`f32`，按引脚电源域初值缩放）与 `electrical_fault`（`u8`，冲突标志）。`createPinMemory` 先按域电压播种门限：3.3 V 引脚默认 `0.8 V / 2.0 V`，1.8 V 与 5 V 域按比例缩放。
- 仲裁：新增 `compiler/voltage-solver.ts`，单遍（非迭代）解算 `rails > strong > weak > floating`。推挽输出驱动域电压/0 V，开漏仅拉低，模拟模式驱动 `pin_voltage_intent`；上下拉为弱偏置；无任何贡献的节点为 `0 V`。纯函数 `resolveVoltageNetwork` 与生成的 IR 共用同一套规则。
- 门限：`solve_net_<id>` 在没有开关的节点上用电压与引脚门限得出数字电平（`< low` 为 0、`> high` 为 1，中间保持上一次 `pin_input`）；开关节点继续使用布尔合并电平，保持既有开关语义。
- 冲突：同一节点两个强驱动电压相差超过 `0.001 V` 时锁存 `electrical_fault`；`unified_tick` / `unified_tick_batch` 在解网后立即返回，`Circuit.step()` / `runBatch()` 抛 `CircuitError('electrical-conflict')`。新增 `Circuit.electricalFault` 与 `clearElectricalFault()`；`reset()` 清除标志和电压。
- 器件 API：`pin.writeAnalog(voltage)`（写入意图并切换到 `analog`）、`pin.sampleAnalog()`（读解算电压，断电域返回 0）；`pin.configure({ mode?, lowThreshold?, highThreshold? })` 可覆盖门限。
- 宿主 API：`Circuit.samplePinVoltage(symbol, pin)` 返回伏特值；`DeviceSimExecutor.samplePinVoltage` 让探针同时采样数字与模拟轨迹。`electrical.supplyVoltage`（默认 3.3 V）与按名称解析的电源轨（`3V3`、`+5V`、`12V`）决定无域引脚的驱动电平。
- 测试：新增 `compiler/voltage-solver.test.ts`（47 项）覆盖纯仲裁、门限缩放、轨命名、模拟 I/O、门限迟滞、参考引擎一致性、电源域电压与冲突暂停。
