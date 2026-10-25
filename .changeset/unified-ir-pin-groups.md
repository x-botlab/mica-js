---
'@mica-js/simulator': minor
---

新增统一 IR 的引脚组 I/O（RFC 0004，`api.pinGroup([...])`）：把一组有序引脚当成一个 `u32` 位域批量读写，位序为 LSB 在前（组内第一个引脚是 bit 0）。

- `DeviceBehaviorApi.pinGroup(names)` 与 `DeviceTopicHandlerApi.pinGroup(names)` 返回 `DevicePinGroupApi`。组成员必须是器件已声明的引脚，数量 1–32 且不可重复；未声明的名称报 `pin-not-found`，空组、重复名称或超过 32 位报 `invalid-input`。
- `writeDigital(value: Value<'u32'> | number)` 逐位写入 `pin_output`：`number` 作为编译期常量，`Value<'u32'>` 用于运行时位图（寄存器、topic 负载等）。`readDigital()` 逐位读取电学求解后的 `pin_input` 并拼成一个 `u32`，组内第 `i` 个引脚对应第 `i` 位。
- `group.pin(name)` 返回绑定同一 builder 的 `DevicePinHandle`，可继续 `configure` / `writeDigital` / `sampleDigital` / `readDrivenDigital`；传入组外名称时报 `pin-not-found` 并列出组成员。
- 引脚组只在行为与 topic 入口内可用（句柄绑定当前函数的 builder），不新增运行时指令、状态或宿主跳转，生成的 IR 仍是共享引脚内存上的 `array.load` / `array.store`；LCD 数据口、并行 ADC、DIP 开关等器件可直接使用。
- 测试：`compiler/device-gen.test.ts` 覆盖 `0xA5` 的 LSB 位序、32 位组（含 bit 31）、u32 动态写入、跨网络批量读取、`group.pin` 单引脚访问、topic 入口内使用及全部错误路径。
