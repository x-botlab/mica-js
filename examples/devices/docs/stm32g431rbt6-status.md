# STM32G431RBT6 能力状态（2026-11-19）

本文逐项列出独立 `example:stm32g431rbt6` 与 ct117e fused 模型的真实支持边界。
“模块已提供”不等于“已接入两个消费者”；中央注册表见
`examples/stm32g431rbt6-core/src/peripherals.ts`，只有其中列出的模块才会进入 JIT 的
`machine().peripherals` 与 `SERVICE_TICK`。

## 中央集成边界

- **静态 MMIO**：`bus.ts` 在翻译期确定静态地址，只发射命中的模块。
- **动态 MMIO**：动态写先做紧凑的模块区间匹配，命中后转到该模块的写服务块；动态单
  寄存器读（有目标寄存器）登记为延迟读，由模块读服务块写回。RCC/GPIO/USART/Flash/PWR/
  generic 也各有独立核心写服务块，`SERVICE_WRITE` 只内联 SRAM/CCM；Flash 代码/别名写
  与 SYSTEM 写再走独立服务块。模块 body 不再内联到 `SERVICE_WRITE`/`SERVICE_READ` 热
  路径。没有目标寄存器的动态读（多寄存器/写 PC）仍落到 `generic` 后备；该后备是
  1024 个「地址 tag + 值」槽，tag 不匹配读 0；同槽新地址会 evict 旧值，因此它是
  最后写入值的隔离缓存，不是完整寄存器持久图。
- **时间推进**：每个时间模块有独立 `SERVICE_ADVANCE + slot` 服务块，`SERVICE_TICK`
  只调度活动槽，不内联全部外设的 advance。
- **fused profile**：ct117e 通过板级 `CT117E_PERIPHERALS` 注册共享 ADC 和 TIM 模块，
  不改变共享 `FUSED_PERIPHERALS`。固定 `FUSED_WIRES` 与板级 DDL 只为 PB12/PB14/PB15
  三个模拟节点提供电压，为 PB4/PA15 两个 555 节点提供捕获边沿；PB6/PB7 的板载 I²C
  走 GPIO bit-bang，不启用硬件 I²C 控制器。这不代表独立器件的其他外设也接入了 ct117e。
- **复位**：独立 MCU 的 NRST 由 DDL reaction 处理；软件复位由 `nvic.ts`/`reset.ts`
  统一进入 `applyReset`。两项都从 `code[0]`/`code[4]` 重新取 SP/PC，不清 code/SRAM/CCM。
- `periph` 仍是既有 RCC/GPIO/USART1–3/FLASH/PWR 分区；新增模块使用专属 memory：
  `analog`、`i2c`、`spi`、`tim`、`serial`、`exti`、`syscfg`、`dma`、`crc`、`rng`、`rtc`、
  `watchdog`、`flashState`、`usb`、`can`、`ucpd`、`generic`。

## CPU / 异常

| 项目                                  | 状态                                  | 说明                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Thumb-16                              | 已支持                                | 复位取向量、整数 ALU、分支、访存、IT 块等既有路径保持                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Thumb-2 整数子集                      | 部分                                  | 常用数据处理/移位/位域/乘除/LDM/STM/独占/表跳转；未覆盖编码仍 fault                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| DSP/SIMD / 饱和                       | 部分                                  | `dsp.ts` 提供部分编码；不等同完整 ARMv7E-M DSP                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| FPU/VFP                               | 未实现                                | 生产 decode 不建模 FPU：`0xEC00` 编码空间按 unsupported 指令 fault，`VMSR`/`VMRS` 与 VFP 算术、VSTM/VLDM 均不执行；不提供 FPCCR/FPSCR 存储，也不做 FP 扩展栈帧。硬浮点固件在首个 VFP 指令处停止                                                                                                                                                                                                                                                                                                             |
| SVC/BKPT                              | 部分                                  | NVIC 重写含 SVCall；BKPT/调试语义不完整                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 优先级/嵌套/PRIMASK/BASEPRI/FAULTMASK | 部分                                  | NVIC 支持 4 位优先级与基本嵌套；MemManage/BusFault/UsageFault 独立入口未完整                                                                                                                                                                                                                                                                                                                                                                                                                               |
| MPU                                   | 未实现                                | 仅保留寄存器兼容；不模拟访存权限                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 低功耗 WFI/WFE                        | 近似                                  | 按 tick 推进并等待 pending；无真实 Sleep/Stop/Standby 电流与唤醒时序                                                                                                                                                                                                                                                                                                                                                                                                                                       |

## 时钟、复位与系统

| 项目                    | 状态                | 说明                                                                                                                                                                                                                 |
| ----------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RCC HSI/HSE/PLL/AHB/APB | 部分                | `rcc.ts`/`clock-tree.ts` 计算实际时钟、门控与复位；CSS/LSE 晶振/精确抖动未建模。动态 `cpuCyclePs` 已由 RCC 写入刷新，同一次 `runUntil` 内 PLL/HSI 切换影响 CPU 与 SysTick；I2C/SPI 周期已在各自 owner 接入运行期周期 |
| 时钟对定时器/串口影响   | 部分                | TIM 使用 APB 实际时钟；USART 在时钟变化后重算位时长；I2C/SPI 的 requestedTick 使用运行期 CPU 周期；ADC 仍有模块内近似                                                                                                |
| `clockFrequency` 属性   | 保留                | 作为复位/未写 RCC 时的 fallback；写入 RCC 后 CPU 使用运行期 `cpuCyclePs`，不是全部外设时钟的唯一来源                                                                                                                 |
| NRST                    | 已接入独立 MCU      | 低电平 halted，释放执行 MCU 复位；ct117e 声明 NRST，但 LCD 侧仍恒高                                                                                                                                                  |
| SYSRESETREQ/VECTRESET   | 部分                | `reset.ts`/`nvic.ts` 路径；软件复位计数/原因在 sys 中保留                                                                                                                                                            |
| PWR VOS/VOSF            | 已支持              | 启动轮询兼容；无真实电压爬升/低功耗模式                                                                                                                                                                              |
| RTC/TAMP                | 部分                | `rtcModule` 已注册（日历/闹钟/唤醒基础）；TAMP 与低功耗唤醒未完整                                                                                                                                                    |
| IWDG/WWDG               | 部分                | `watchdogModule` 已注册（计数/复位/窗口基础）；低功耗时钟与精确喂狗时序有限                                                                                                                                          |
| RNG                     | 部分                | `rngModule` 已注册（熵源/就绪/错误注入基础）；不保证熵质量                                                                                                                                                           |
| CRC                     | 已提供模块          | `crcModule` 已注册；DMAMUX 与 DMA 控制器已注册（默认 DmaBus/请求源）                                                                                                                                                 |
| Flash 编程/擦除/IAP     | 未提供 IAP 生产接入 | Flash 控制器基础与实验 fixture 保留；MCU IAP adapter/覆盖初始映像/SRAM 执行未验收，本轮明确不要求。`flash-iap.test.ts` 的 skip 不计交付                                                                              |
| 选项字节/BOOT           | 未实现              | 不模拟 BOOT0、选项字节和保护位                                                                                                                                                                                       |
| 调试/追踪               | 未实现              | 无 SWD/ITM/ETM                                                                                                                                                                                                       |

## GPIO 与复用

| 项目                 | 状态   | 说明                                                                                                                              |
| -------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------- |
| GPIOA/B/C/D/F        | 已支持 | 既有 MODER/OTYPER/PUPDR/IDR/ODR/BSRR/BRR/AFR 路径                                                                                 |
| GPIOF                | 已支持 | PF0/PF1 等封装脚；无 port E                                                                                                       |
| AF 推挽/开漏         | 已支持 | `AlternateDriver.openDrain` 与 OTYPER；开漏高电平释放到 PUPDR                                                                     |
| USART/I2C/SPI/TIM AF | 部分   | USART TX/RX、I2C SCL/SDA、SPI SCK/MISO/MOSI 已注册；TIM 输入捕获与 PA0/TIM2_CH1 1 MHz PWM 已通过真实引脚回归；NSS/互补/编码器未接 |
| EXTI 边沿与唤醒      | 部分   | EXTI/SYSCFG 模块注册；低功耗唤醒未建模                                                                                            |
| LCKR                 | 已支持 | LCKK 三步写 + 读确认；只锁配置字段，不锁 ODR/BSRR/BRR                                                                             |
| 电气细节             | 简化   | 25 Ω 驱动、40 kΩ 内部拉、无驱动强度/ESD/模拟开关                                                                                  |

## 串行总线

| 模块            | 状态             | 说明                                                                                                                                                                         |
| --------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| USART1–3 TX     | 已支持           | 轮询/中断发送、TXE/TC、BRR、发送引脚 AF                                                                                                                                      |
| USART1–3 RX     | 已支持（模块级） | RXNE/ORE/FE/NE/IDLE、接收引脚采样与 IRQ；未接硬件流控                                                                                                                        |
| UART4 / LPUART1 | 部分             | 已注册 `usart-ext` 模块与 TX 通道；LPUART 仅基础位时序，未验收全部低功耗特性                                                                                                 |
| I2C1/2/3        | 部分             | 主机模型、7 位地址、开漏 AF；从机/多主机仲裁/时钟拉伸细节有限。引脚以 G431 RM0440/CMSIS 为准，不包含 PB6 的虚构 I2C1_SCL 映射；CT117E 的 GPIO bitbang 不作为通用 MCU AF      |
| SPI1/2/3        | 部分             | 主机 TX/RX 移位、8/16 位真实回环与 SPI DMA1 CH1 TX/CH2 RX 已过；NSS、I2S、CRC、完整 DMA 请求矩阵未完整                                                                       |
| USB             | 未提供           | 本轮明确不需要 USB。`USB_MODULE` 不进入生产 `PERIPHERALS`，adapter 不暴露 USB host 方法/输入通道；实验源码和独立 module 测试保留在实验边界，不计入本 MCU 支持矩阵            |
| FDCAN1          | 部分             | `FDCAN_MODULE` 提供寄存器/Message RAM 与内部 loopback；无外部总线/仲裁/错误帧。当前模块与 MCU 固件 e2e 用例已启用；`advance` IR 作用域旧阻塞已修复，具体通过项以测试状态为准 |
| UCPD1           | 部分             | `UCPD_MODULE` 已注册（CC 电阻检测/基础寄存器）；PD 协议、BIST、完整 Type-C 状态机未建模                                                                                      |
| SAI1            | 未实现           | 地址常量保留，无寄存器/音频行为                                                                                                                                              |

## 定时、模拟与 DMA

| 模块                      | 状态   | 说明                                                                                                                                          |
| ------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| TIM1/2/3/4/6/7/8/15/16/17 | 部分   | 计数、PSC/ARR/RCR、更新/比较/输入捕获、IRQ；PA0/TIM2_CH1 1 MHz PWM 已过真实引脚回归；中心对齐/编码器/从模式/滤波/break/死区/互补未完整        |
| LPTIM1                    | 未实现 | 地址常量保留，不复用通用 TIM 布局                                                                                                             |
| ADC1/ADC2                 | 部分   | 外部通道、采样/转换、EOC/EOS/IRQ；内部通道/过采样/校准/双 ADC 细节有限                                                                        |
| DAC1                      | 部分   | `createDacModule()` 已注册；输出用 Thevenin 电阻意图近似，无真实电压源 intent                                                                 |
| COMP1–4 / OPAMP1–3        | 部分   | OPAMP 与 COMP 模块已注册；COMP 支持 EN/输入选择/POLARITY/VALUE 基础，迟滞/消隐/输出路由/中断未建模                                            |
| DMA1/DMA2/DMAMUX          | 部分   | `dmamuxModule` 与 `dmaModule` 均已在冻结的 `PERIPHERALS` 生产注册；默认 `DmaBus`/USART 请求源已接。Flash 编程、完整请求矩阵与优先级细节未验收 |
| CORDIC                    | 未实现 | 地址/内存预留；无三角函数/向量行为                                                                                                            |
| FMAC                      | 未实现 | 地址/内存预留；无滤波/卷积行为                                                                                                                |
| CAN/UCPD DMA 请求         | 未完整 | DMA 控制器已注册；这些外设的完整请求矩阵未验收；USB 本轮不提供                                                                                |

## 存储与启动

| 项目                      | 状态                | 说明                                                                                             |
| ------------------------- | ------------------- | ------------------------------------------------------------------------------------------------ |
| Flash 128 KiB 取指        | 已支持              | `code` 内存、0x08000000 与 0 别名                                                                |
| SRAM1 22 KiB / CCM 10 KiB | 已支持              | `sram` 0x20000000、`ccm` 0x10000000                                                              |
| Flash 写/擦除/IAP         | 未提供 IAP 生产接入 | 见上；本轮不接 codeRegions/codeMetadata/覆盖 victim/SRAM 执行，不宣称 IAP 后自修改代码可安全执行 |
| 选项字节/BOOT0            | 未实现              | 不模拟启动模式                                                                                   |
| 位带                      | 未实现              | 无 bit-band 别名                                                                                 |

## 事件 / 方法（独立器件）

- 既有：`onDidUart1Tx`–`onDidUart3Tx`、`onDidFault`、`readSerial`、`getSerialStatus`、
  `getLastFault`。
- 新增：`onDidUart4Tx`、`onDidLpuart1Tx`（见 `package.json`；UART4/LPUART1 基础发送）。
- 本轮不提供 USB host 方法、USB 输入通道或 USB 生产事件；FDCAN/UCPD 也没有 typed
  host 事务 API。实验源码不在生产 adapter 暴露。

## 验证口径

- 独立器件：`examples/devices/test/stm32g431rbt6`（原有 24 项基线 + 各模块代理测试）。
- ct117e：`test/device.test.ts` 的 MCU+LCD 固定工作量基线保留为回归参照；板载产物
  定向验收结果见 [CT117E-M4 README](../../ct117e-m4/README.md#当前板载器件验收)。
- 性能：`bench/stm32g431rbt6/perf.test.ts`（gpio-blink）与
  `hal-throughput.test.ts`（HAL_06_LCD）只作为回归，不以通过功能测试代替性能验收。

本文件中的“部分/未实现”是交付边界，不是待办清单的自动完成声明；USB 与 FPU 本轮明确不提供。
未实现的能力不会因 `generic` 后备读回而被计为已支持。
