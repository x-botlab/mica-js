---
'@mica-js/simulator': minor
---

新增统一 IR 的 LED 与按钮器件（U04，`src/unified-ir/devices/`）：第一批按统一 IR 契约实现的生产形状器件，每个器件都有 IR 工厂、类型化访问器、声明文件、错误码与测试。

- `createLedIR(id, config)` / `LED_IR_TYPE`：两终端 LED，支持 `color`、`forwardVoltage`、`activeLow`、`maxBrightness`、`initialBrightness`；器件状态为 `lamp` / `level` / `brightness`，`LedAccessor` 提供 `isOn()`、`isForwardBiased()`、`setBrightness()`、`getBrightness()`、`readAnode()`、`readCathode()`、`refresh()`、`step()` / `run()` 与 `snapshot()`。
- `createButtonIR(id, config)` / `BUTTON_IR_TYPE`：两终端按钮，支持 `debounceTicks`、`activeLow`、`initialPressed`；`ButtonAccessor` 区分原始位置与去抖触点（`press()` / `release()` / `toggle()` / `isPressed()` / `isClosed()` / `isBouncing()` / `getPressCount()` / `getHoldTicks()` / `getLineLevel()` / `snapshot()`）。去抖在生成的 tick 内完成，不依赖宿主轮询。
- 两个器件都导出 `device`（可直接放进 `Circuit.create` 的 `devices`），器件类型 `led-ir` / `button-ir` 进入 `Circuit` 的访问器类型推导，`circuit.devices.sw1.press()` 无需断言。
- 共享辅助 `StorageAccessor`、`SimplePinMemory`、`SimpleDeviceAccessorOptions` 与 `buildAccessor` / `register*Layout` 供自定义器件复用。
- `led.ts` 的 `lamp` 与内置 `ideal-led` 内核逐 tick 对齐（每个 tick 用同一个 MCU 驱动两者并比较）；`performance.test.ts` 覆盖吞吐（LED≈29.9 M tick/s、内置 ideal-led≈32.7 M tick/s、按钮电路≈11.7 M tick/s）。
