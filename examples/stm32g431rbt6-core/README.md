# @mica-js/stm32g431rbt6-core

STM32G431RBT6 的 MCU 内核，作为内部 workspace 包被两个器件工程共用：

- `examples/devices`（STM32G431RBT6 器件）
- `examples/ct117e-m4`

包内包含 Thumb/Thumb-2 译码与执行、总线与内存布局、GPIO/RCC/PWR/SysTick/NVIC/USART
模型、寄存器常量与寄存器事实。外设通过 `peripheral.ts` 的 `PeripheralModule` 合同注册：
`peripherals.ts` 显式列出独立 MCU profile 与 ct117e fused profile 启用的模块，中央
`bus`/`tick` 只展开当前 profile 的模块。已提供的子路径包括 `adc`、`analog`、`bus`、
`clock-tree`、`comparator`、`cpu`、`crc`、`decode`、`dma`、`dma-default`、`dma-sources`、`dmamux`、`dsp`、`exti`、`flash`、`gpio`、
`i2c`、`ir`、`layout`、`machine`、`memory`、`nvic`、`peripheral`、`peripherals`、`pending`、
`pwr`、`rcc`、`register-facts`、`reset`、`spi`、`syscfg`、`system`、`systick`、`thumb16`、
`thumb32`、`tick`、`tim`、`ucpd`、`usart`、`usb`、`watchdog`。器件 ID、属性、DDL 模型、JIT 合批与服务块编排仍留在
两个 example 各自工程中。

资源与接口合同见 [中央集成合同](../devices/docs/stm32g431rbt6-status.md)。关键边界：

- 独立 MCU 的模块静态 MMIO 访问走 `PeripheralModule`；运行期动态外设地址在未实现
  延迟模块服务前落到 `generic` 后备，不宣称完整支持。
- ct117e 的 `FUSED_PERIPHERALS` 默认空：fused 只支持现有数字 LCD 总线，ADC/TIM/I2C
  等需要独立引脚或模拟量的模块不进入该 profile。
- NRST 复位、FDCAN/UCPD 等能力按状态文档逐项标注；USB 本轮明确不提供。FPU 只在
  生产 decode 中支持 `VMSR FPSCR, Rt` 的可支持子集：CPACR 权限/真实 NOCP、FPSCR 可写
  位、FPCCR ASPEN/LSPEN 与 ASPEN→CONTROL.FPCA。FP context 仍不支持：LSPACT=1、
  FPCA=1 的异常入口、EXC_RETURN bit4=0 的扩展返回均显式 `0x21` halt；basic return
  清 FPCA。lazy PreserveFPState、FP 栈帧、VMRS、VFP 算术、VSTM/VLDM 不在范围内，也
  不 import 实验 `fpu.ts`/`softfloat.ts`，不把 `generic` 后备读回当作已实现。

两个 example 都以 `workspace:*` 依赖本包，开发期走 `source` 导出条件直接读取 `src`，
不需要先构建本包。执行 `mica build` 时，构建器把内核代码打进该工程的
`dist/devices/<器件 ID>/device.js`，该模块自包含，运行时不加载本包。

开发命令：

```sh
pnpm --filter @mica-js/stm32g431rbt6-core typecheck
pnpm --filter @mica-js/stm32g431rbt6-core build
```
