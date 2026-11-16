# @mica-js/stm32g431rbt6-core

STM32G431RBT6 的 MCU 内核，作为内部 workspace 包被两个器件工程共用：

- `examples/devices`（STM32G431RBT6 器件）
- `examples/ct117e-m4`

包内包含 Thumb/Thumb-2 译码与执行、总线与内存布局、GPIO/RCC/PWR/SysTick/NVIC/USART
模型、寄存器常量与寄存器事实，通过 `bus`、`cpu`、`decode`、`gpio`、`ir`、`layout`、
`machine`、`memory`、`nvic`、`pwr`、`rcc`、`register-facts`、`systick`、`thumb16`、
`thumb32`、`tick`、`usart` 子路径导出。器件 ID、属性、DDL 模型、JIT 合批与服务块编排
仍留在两个 example 各自工程中。

两个 example 都以 `workspace:*` 依赖本包，开发期走 `source` 导出条件直接读取 `src`，
不需要先构建本包。执行 `mica build` 时，构建器把内核代码打进该工程的
`dist/devices/<器件 ID>/device.js`，该模块自包含，运行时不加载本包。

开发命令：

```sh
pnpm --filter @mica-js/stm32g431rbt6-core typecheck
pnpm --filter @mica-js/stm32g431rbt6-core build
```
