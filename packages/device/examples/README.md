# 器件作者示例：理想按钮、理想继电器与教学 MCU

本目录存放已提交的真实器件模型。每个器件遵循 [器件定义](https://github.com/x-botlab/mica-js/issues/11) 的同目录同名配对：描述与实现分别使用 `<id>.json` 与 `<id>.js`，加载时由宿主 `IDeviceProvider` 读取两份文件，`loadDeviceModule` 只导入实现源码。

| 器件       | 文件            | 行为                                                                                                                                                     |
| ---------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 理想按钮   | `ideal-button/` | 话题 `pressed` 驱动被动双向触点 `contact`（`A`–`B`）；initialize 与 reset 复位为断开；不驱动任何引脚                                                     |
| 理想继电器 | `ideal-relay/`  | `IN` 的边沿由 `observeDigital` 捕获；`apply` 用捕获电平在同一 patch 原子切换 `normallyOpen`（`COM`–`NO`）与 `normallyClosed`（`COM`–`NC`）；不声明 reset |
| 教学 MCU   | `teaching-mcu/` | #8 §8.2 / #26 §16.4 的两字节合成 ISA：`0x10` ADD、`0x20` JMP、`0x30` JNZ、`0x00` HALT；Provider 按 PC 生成一个客体基本块，块末写 GPIO 并安排下一次入口   |

按钮/继电器只使用已确认的作者面：`api.ir` 静态声明、`b.pin`、`b.observe`、`b.connection`、`api.subscribe` / `api.post` 与生命周期绑定；没有运行期 JS 解码引脚协议，也没有用宿主输出代替被动触点。

教学 MCU 使用 `ir.provider` 的受追踪读取、`b.pin.writeDigital`、`b.event.at` 与 `api.subscribe` / `api.updateBytes`。固件固定为 12 B、按 8 B 版本单元划分；`firmwarePatch` 输入端口接受字节载荷并从偏移 0 更新固件。示例的两种重要限制：

- 每条合成指令计 10,000 ps，模型只在块边界可观察；GPIO 是块末 `r0` 最低位的教学调试镜像。它不是 AVR/8051 等真实 ISA，不模拟中断、流水线、MMIO 或逐周期时序，也不允许据此声称真实 MCU 可以无条件整块提前提交。
- 固件声明为 `readonly: true`，客体生成代码只读取它。宿主通过实例选项 `updateResources: ['firmware']` 单独授予 `api.updateBytes` 更新路径；`readonly` 本身不授予该权限，也不允许普通客体写入。

## 与实现的关系

- 这些文件不是 `@mica-js/device` 的包实现：`tsconfig.build.json` 只包含 `src`，`package.json` 的 `files` 仅含 `dist`，因此它们不会进入 `dist` 或发布包。
- 放在 `examples/` 而不是 `src/`：模型是器件作者产物，保留原始 JSON/JS 配对便于宿主、文档和后续 Playground 直接复用；同时与包源码和测试辅助代码区分。
- 端到端回归在 [`../src/e2e/button-relay.test.ts`](../src/e2e/button-relay.test.ts)：从磁盘读取按钮/继电器文件，走 `loadDeviceModule` → `createDeviceInstance` → scheduler/IR → `createPowerRuntime` → `b.connection.apply` → topology 的完整链路，断言网络电压、观察投递、原子切换、复位、实例隔离、掉电门控与电气冲突行为。
- 教学 MCU 回归在 [`../src/e2e/teaching-mcu.test.ts`](../src/e2e/teaching-mcu.test.ts)：从磁盘读取 `teaching-mcu.json` / `.js`，走 `loadDeviceModule` → `createDeviceInstance` → `validateIR` → scheduler → `createPowerRuntime` → Provider 生成/缓存 → 消息更新 → HALT 的完整链路；断言 PC/R0/GPIO/事件时间轨迹、运行时条件分支与 u32 回绕、8 B 单元更新后的生成次数、256 B/整资源单元的保守失效，以及缺少固件/非法地址/非法指令/HALT 行为。checkpoint 不自修改重放在 [`../src/e2e/self-modifying-checkpoint.test.ts`](../src/e2e/self-modifying-checkpoint.test.ts) 中以 helper 自修改 fixture 验证。

## 已知前提

端到端用例依赖两处**非公共合同**前提：同刻控制条目按实例注册顺序执行（`initialize` 补丁顺序断言即由此而来），以及测试板的 `VCC`/`LOAD` 供电、`COIL*`/`NO*`/`NC*` 上下拉与 `board` 电源域绑定属于宿主侧电路。改动调度器同刻 control 排序或该测试板接线都会改变断言，需要同步更新。

教学 MCU 用例另外依赖宿主提供 `updateResources: ['firmware']` 的独立更新授权，以及测试板把 `mcu.GPIO` 与 `board.SENSE` 接在同一网络、`SENSE` 下拉开漏且 `board` 逻辑域由 5 V `VCC` 供电。它不依赖真实芯片的电气时序。

## 运行

在仓库根目录运行：

```powershell
pnpm --filter @mica-js/device test
pnpm --filter @mica-js/device typecheck
```

按钮/继电器只覆盖理想模型语义：无抖动、无接触电阻、无机械延迟、无线圈电流或吸合阈值。教学 MCU 只覆盖块边界的合成 ISA 语义，不覆盖真实指令集、中断、流水线、MMIO、块内观察者或真实周期时序。模拟量完整行为与协议库不在本目录范围。
