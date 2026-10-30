---
'@mica-js/simulator': minor
---

统一 IR 的全局引脚空间上限从 256 提升到 `UNIFIED_PIN_CAPACITY = 4096`，单设备引脚上限 `DEVICE_PIN_STRIDE` 从 32 提升到 512，板级原理图不再因为「一个 40 脚 MCU 就超限」而编译失败。

共享的 `pin_mode` / `pin_output` / `pin_input` 内存改为按电路实际声明的引脚数分配，容量常量只作为分配期上限；因此提高上限不增加每个电路的内存与创建、`reset()` 开销。`createPinMemory(module, capacity?)` 新增可选参数以支持按需分配，缺省仍为全容量。`compiled.pins.capacity` 仍报告上限值。
