# STM32G431RBT6 器件包

ST 的 Arm Cortex-M4F 32 位 MCU（LQFP64，128 KiB Flash / 22 KiB SRAM + 10 KiB CCM SRAM）的
Mica 统一器件工程。器件 ID 是 `example:stm32g431rbt6`：JIT 按 PC 翻译一段连续的
Thumb/Thumb-2 指令（按复杂度预算合批，硬上限 36 条）。GPIO/RCC/PWR/SysTick/NVIC、
USART1–3 与新增的 TIM/ADC/I2C/SPI/EXTI/SYSCFG/DMAMUX/CRC/UART4/LPUART1 按
`PeripheralModule` 合同注册；每项能力的真实边界见
[`stm32g431rbt6-status.md`](./stm32g431rbt6-status.md)。构建产物是
`dist/stm32g431rbt6/{package.json, model.js}`；当前只提供无头仿真模型，暂无新视图或
编辑器接入。

属性：`firmware`（firmware，默认 `null`）按 `code` 空间装载到 `0x08000000` 起的 128 KiB
Flash，前两字是初始 SP 与复位入口；`clockFrequency`（number，默认 16000000 Hz，DDL 断言
落在 1000–170000000）给出指令耗时、SysTick 与 USART 的时间基准。`null` 表示空 Flash
（SP=0、PC=0），不是错误。

器件源码位于 `examples/devices/stm32g431rbt6`，作为独立单器件项目构建；子项目不登记为
pnpm workspace 包，由 `examples/devices` 聚合脚本执行 `mica prepare`、`mica build` 与
`tsc --noEmit`。它依赖 `@mica-js/sdk`、`@mica-js/simulator` 与
`@mica-js/stm32g431rbt6-core` 的 `workspace:*`（走 `source` 导出条件，不需要先构建
packages）。

MCU 内核位于 `examples/stm32g431rbt6-core`（包名 `@mica-js/stm32g431rbt6-core`）：Thumb/Thumb-2
译码与执行、总线与内存布局、GPIO/RCC/PWR/SysTick/NVIC/USART 模型、寄存器常量与寄存器事实
都由共享包提供，并按模块导出子路径。器件库与 `examples/ct117e-m4` 共用这份内核；器件 ID、
属性、DDL 模型、JIT 合批与服务块编排仍在本工程。单器件构建在构建期把该依赖打进
`dist/stm32g431rbt6/model.js`，该模块自包含，运行时不加载共享包。

## 固件与模型接口

`firmware` 是统一器件的复合属性，不在 DDL 中声明。框架把 BIN/HEX/ELF 解析为
`FirmwareImage`；工厂按 `code` 空间绝对地址换算 `0x08000000` 偏移后调用 `ctx.loadBytes`，
保留段间空洞，不把非连续段拼成连续镜像。JIT 只从装载后的 `code` 内存取指；寄存器事实与
HAL_Delay 轮询分析都读取模型内存快照，装载后另做一次一致性复核。

| 成员 | 载荷 | 说明 |
| ---- | ---- | ---- |
| `onDidUart1Tx` / `onDidUart2Tx` / `onDidUart3Tx` | `SerialData` | 对应 USART 每批发送字节 |
| `onDidUart4Tx` / `onDidLpuart1Tx` | `SerialData` | UART4 / LPUART1 每批发送字节 |
| `onDidFault` | number | 未实现指令/非法访存的 PC |
| `readSerial({ channel, cursor })` | `SerialChunk` | 读取游标之后的保留历史，返回独立副本 |
| `getSerialStatus({ channel })` | `SerialStatus` | 容量、最旧/下一个游标与累计丢弃字节 |
| `getLastFault(null)` | number | 最近一次故障 PC；无故障为 -1 |

本轮明确不提供 USB，也不提供完整 FPU 能力：不暴露 USB host 方法/输入通道；生产 decode
只支持 `VMSR FPSCR, Rt` 的可支持子集（CPACR 权限/真实 NOCP、FPSCR 可写位、FPCCR
ASPEN/LSPEN、ASPEN→CONTROL.FPCA）。FP context 仍不支持：LSPACT=1、FPCA=1 的异常
入口、EXC_RETURN bit4=0 的扩展返回均显式 `0x21` halt；basic return 清 FPCA。VMRS、
VFP 算术、lazy PreserveFPState、FP 扩展栈帧与 VSTM/VLDM 仍按未实现 fault。实验源码保留
在独立边界，不计入本器件支持矩阵。

串口通道 ID 是 DDL 名：`uart1Tx`、`uart2Tx`、`uart3Tx`、`uart4Tx`、`lpuart1Tx`。
每通道保留最近 4096 字节；
`SerialData.cursor` 是本批第一个字节的序号，`SerialChunk` 的 `start`/`end`/`dropped`
明确给出返回范围与请求游标之后已丢弃的数量。事件与历史查询可能重叠，界面按游标去重；
不维护无界数组。实现位于 `examples/devices/shared/serial.ts`，构建时打包进自包含的
`model.js`，发布物不依赖共享源码目录。

当前版本只实现仿真引擎运行适配，清单不含 `view2d`，不提供二维/HTML 视图或编辑器接入。

## 性能

**主路径是运行时的默认值 `execution: 'throughput'`**（直接后端）。性能读数用真实工程固件，
不用合成夹具：`HAL_06_LCD.bin` 是 CT117E-M4 的 Keil 产物，复位后要跑完时钟树（HSI16 → PLL
80 MHz，轮询 PWR 的 VOSF）、`MX_GPIO_Init`、`MX_USART1_UART_Init`，然后是 ILI9325 的 BSP
初始化（背光、寄存器序列、多次 `HAL_Delay`）。`HAL_Delay` 靠 SysTick 中断推进 `uwTick`，
因此同一段窗口覆盖 GPIO、RCC、PWR、USART、SysTick、NVIC 与 Flash 取指。

测量口径：裸 MCU 板（只接 VDD/VSS，不接 LCD 或探针）、80 MHz（固件自己配置的主频）。
GPIO 仍按原边界发布。三轮分别记录墙钟与进程 CPU 时间，不把同一进程内复用翻译缓存的后两轮
当成冷启动。实时倍率用仿真时间除以墙钟时间。

### 实测（`bench/stm32g431rbt6/hal-throughput.test.ts` / `bench/stm32g431rbt6/hal-precise.test.ts`）

| 仿真窗口   | 固件在做什么                                           |
| ---------- | ------------------------------------------------------ |
| 0–0.2 ms   | 建板、复位、时钟设置和 LCD 初始化的第一段              |
| 0.2–220 ms | LCD 初始化；220 ms 时仍在 `HAL_Delay` 内轮询           |
| 220–360 ms | 等待约 350 ms 时结束，开始清屏并首次翻译绘图路径       |
| 360–390 ms | 稳定清屏：104,338 次 WR 采样变化，无新翻译、编译或回退 |
| 390–440 ms | 清屏结束，执行后续绘图代码，再进入等待                 |

2026-11-19 同固件、同裸板、无探针对照：GPIO 发布中断 direct 执行时，新增翻译并不使已有
代码失效。只修正失效判断、仍用原重建阈值时，`throughput` 的 220–440 ms 直接程序编译
从 59 次降为 3 次，暂时回退从 124 次增至 2,337 次；墙钟三轮由约 11.55 s / 985 ms / 760 ms 降至
10.91 s / 863 ms / 697 ms。两边到 440 ms 均为 157,338 次 WR 采样变化。这些数字不与
CT117E-M4 联合板的历史读数横比。

最终策略仍只在 220–440 ms 编译 3 次，但按 PC 统计重复回退，避免新热路径迟迟得不到补编译，
将该段回退降至 334 次。只测 360–390 ms 时，修复重编译判断的前后都有 417,472 次 direct 调用，
墙钟没有稳定改善，说明重编译不是清屏稳态的瓶颈。

另一组同进程交错对照只开关直接续跑：继续完成每次发布，但无其他调度工作时直接恢复指令，
把 30 ms 清屏的墙钟中位数从 401 ms 降到 365 ms（约 9%，仍只有约 0.08× 实时）。
计时轮次不记录逐边沿轨迹；单独的轨迹轮次中，WR 采样版本及其发布时间戳一致。
`precise` 是同固件解释器对照，清屏窗的 WR 采样变化数相同，墙钟约 1.26–1.30 s。
读数随宿主和 V8 状态变化，以测试输出为准。

在生成代码内加入发布检查点后，运行时仍先刷新脏状态及内存、完成电气发布与捕获，再判断
当前指令的续段能否原地完成；遇到调度工作、截止点或代码失效，仍走原续段路径。续段结束后
必须返回运行时，不能顺势执行下一条指令。同一份候选生成代码仅开关检查点的交错对照（各四轮）
中，360–390 ms 直接执行调用从 417,472 次降至 208,799 次，墙钟中位数从 340 ms 降至 312 ms
（约 8%）。最终版与 `b98207b` 的独立进程无探针对照（各六轮，首轮单列）中，后五轮的
墙钟中位数从 352 ms 降至 298 ms（约 15%，相当于约 0.10× 实时）。各轮均为 104,338 次 WR
采样变化，稳定窗均无新翻译、编译或回退。

单独记录的 WR 采样版本和发布时间戳与 `b98207b` 一致。带 LCD 的 440 ms 联合板以独立总线
oracle 核对了 157,338 次 WR 边沿、77,351 次 GRAM 写入与 3 帧发布；GRAM 与帧字节的跨版本
签名相同。全外设合成负载的 220 窗状态、内存及外设输出签名也一致，末 40 个 2 ms 窗的墙钟
中位数为 1.48 ms，通过实时门槛。

静态 BSRR/BRR 写会直接生成 ODR 与引脚 intent；若该写可能改变引脚，基本块在其后收束，让宿主
电气边界看到完整脉冲。`0x08001104..0x08001152` 因此形成 8 个边沿块，而不是一个会吞掉 WR
低→高跳变的大块。真实 ILI9325 联合测试和 `gpio-sync` 的 `[2,0,1,0]` 历史断言覆盖这一约束。

### 轻量基线（`bench/stm32g431rbt6/perf.test.ts`）

`gpio-blink`、1 MHz、20 ms 预热 + 500 ms 测量、11 引脚夹具（探针 + 驱动源）：

| 指标                               | 读数                                                                     |
| ---------------------------------- | ------------------------------------------------------------------------ |
| `coldMs`（搭板 + 首次翻译 + 预热） | 约 0.5–0.7 s                                                             |
| `wallMs`（稳态 500 ms 仿真）       | 约 3 ms                                                                  |
| `slowdown`（墙钟 / 仿真时间）      | 约 0.01×                                                                 |
| `jit`                              | `direct: true`；`cache: 12`（11 个指令块 + GPIOA 服务块），`programs: 1` |

这个夹具的延时是 `subs; bne` 忙等循环，`delayLoops` 会把整圈折算成一次时间推进，所以它的
墙钟/MIPS **不能**当作逐指令成本；`bench/stm32g431rbt6/measure.mjs` 的 BARE 行同理，只适合同口径对照。

`gpio-input` 是已知的慢用例：它在指令块里反复采样浮空引脚并等待电平，每个采样都要触发电气
求解，属于器件电学模型的成本，与后端无关。

### 器件侧的做法

指令块只保留「指令数据通路 + 累加耗时 + 一次服务判定」，外设推进、异常派发与 GPIO 引脚
意图全部搬进按需翻译的服务块（`SERVICE_TICK`、`SERVICE_GPIO + port`、`SERVICE_SYNC`、
`SERVICE_READ`、`SERVICE_WRITE`）：

- **连续指令合成一个块**：`collectBatch` 从批首起按复杂度预算收集顺序指令（硬上限 36 条），
  发射进同一个块体，块尾只 `elapse` 一次（时长为已执行指令的周期和）。四条收块规则：
  写 pc 的指令之后收块；可能改变 GPIO 引脚的静态写之后收块，保证电气边界看到完整脉冲；
  自旋 `b .` 与忙等循环头独占或收尾一个块（否则直接后端的轮次折算失效）；不在 IT 块中间收块。
- **pc 守卫表达「已离开顺序路径」**：每条指令前把 `pc` 复位成它的顺序后继。分支/异常返回
  写成目标、服务块接手写成服务 PC，两者都让下一条之前的守卫停掉批内剩余指令；`tick` 因此
  可以继续把 `pc` 当作服务返回位置。
- **节拍粒度按活跃外设取值**：`tickPs` 由 `refreshTick` 在会改变条件的寄存器写入处重算——
  SysTick 使能时取它的周期，有发送活动时取 1 µs，两者同时活跃取较小值；都不活跃时
  `tickActive` 为 false，指令块直接跳过时间判定，空闲固件不付这份成本。
- **服务判定归并成一个字**：`serviceMask` 的 bit0–bit3 对应 GPIO 写、IDR 读、外设写、引脚刷新，
  bit4 是 `irqDirty && primask == 0` 的镜像；指令块每条指令从 9 次 state 读降到 3 次。单槽延迟
  状态必须逐条取走，时间条件（`pendingPs >= tickPs`）则推到批尾。
- **IT 守卫按需发射**：`decode` 给出 `endsBatch` 与 `itCount`，批处理静态跟踪 IT 掩码，只有
  真正受 IT 控制的指令才读 `itState` 并发射条件选择链。
- **延时环折算计入服务累加器**：声明的 `delayLoops` 带 `pending`，折算停在下一次服务边界并把
  折叠掉的时间记进 `pendingPs`，否则 SysTick/USART 会因为跳过轮次而饿死。
- **HAL_Delay 使用时间事件轮询**：识别 `bl HAL_GetTick; subs; cmp; bcc` 等待形态，在 SysTick
  边界推进模型并回到轮询头复查；`consume` 放行一轮，避免终点后多等一个 tick。`PRIMASK`
  屏蔽时只保留 pending，USART 活跃或 SysTick 未使能时回到逐指令服务路径。
- **USART 字节发布延迟到服务块**：TDR 写入只锁存待发字节，发布统一发生在服务块，使通道
  发布与节拍边界对齐、指令块保持无 `send` 的均匀成本。直接后端已支持内联 `send`，这条
  仍保留是因为它让发布时机可预期，而不是后端限制。

### 直接后端的剩余成本

- **首次执行**：Thumb 翻译、IR 构建与校验，以及宿主编译都发生在第一次走到新路径时，
  不只发生在 `0–0.2 ms`。resident shard 可复用未改变的指令体和已封闭的 shard。
- **稳定 GPIO 输出**：静态写已内联 ODR/intent。每次边沿仍需要提交状态、同步电气采样，
  并按时序继续执行；不能用合并发布来减少调用，否则会吞掉 WR 等外部可观察脉冲。
- **板上只能有一个 JIT 设备**：`runDirect` 在 `board.jits.length !== 1` 时关闭，多 MCU 板会
  静默退回解释器。

## 验证

```bash
cd examples/devices/stm32g431rbt6
mica prepare && tsc --noEmit
mica build
cd ..
pnpm exec vitest run test/stm32g431rbt6
pnpm exec vitest run --config vitest.perf.config.ts bench/stm32g431rbt6
```

`test/stm32g431rbt6/harness.ts` 通过 `adaptModelFactory` 装载源码或 `dist/stm32g431rbt6/model.js`，
把统一事件映射回旧话题供既有电气/固件回归使用。`firmware-mapping.test.ts` 覆盖非零绝对
地址、分段空洞、输入快照隔离与 128 KiB 边界；`device.test.ts` 同时验证 USART 历史游标与
`getLastFault`。

`pnpm run bench` 会运行本包全部基准；与 STM32 相关的是 `bench/stm32g431rbt6/perf.test.ts`（`gpio-blink`，1 MHz，500 ms 仿真，结果
**追加**到 `bench/stm32g431rbt6/results.jsonl`）、`bench/stm32g431rbt6/hal-throughput.test.ts` 与 `bench/stm32g431rbt6/hal-precise.test.ts`
（`HAL_06_LCD`，80 MHz，分段输出 `HAL {...}`）。读墙钟时避免与其他基准争抢 CPU；
不要把三个轮次的最小值拼成一次运行。`throughput` 应启用 direct JIT，且仅要求
360–390 ms 稳定清屏窗没有新翻译、编译或回退。

两个 HAL 基准必须**分开进程**运行：器件的翻译缓存是模块级的，同进程里先跑完一种模式会把
缓存焐热，另一种模式的冷启动读数就不可信了。

`bench/stm32g431rbt6/measure.mjs` 用**进程 CPU 时间**重跑 `gpio-blink` 与 `systick` 的多主频读数
（BENCH / BARE 两类 JSON 行）。注意这两条固件的延时都能被 `delayLoops` 折算，BARE 行只适合
同口径对照，不代表逐指令成本。

```powershell
node bench/stm32g431rbt6/measure.mjs
```

`test/stm32g431rbt6/fixtures/generate.py` 用 Keystone 生成裸二进制固件（开发期工具，不参与运行期）：
`gpio-blink`（PA5 推挽翻转）、`gpio-input`（IDR 镜像到 ODR）、`arith`（32 位逻辑/位段/条件分支）、
`uart2-tx`（USART2 发送 `OK`）、`systick`（1 ms SysTick 中断翻转 PA5）。用例覆盖复位取向量、
推挽输出、IDR 采样、Thumb-2 数据处理、USART 字节发送与 SysTick 异常入口/返回。

### 80 MHz 完整外设配置的稳态实时验收

`bench/stm32g431rbt6/full-peripheral-steady.test.ts` 使用独立 MCU 的完整外设配置，
固件实际驱动 SysTick、TIM2/NVIC、PA5 和 USART2，并使用动态 SRAM 读写。仿真预热
4 ms 后，`throughput` 连跑 220 个 2 ms 仿真窗，逐窗校验主循环、中断计数、GPIO 边沿和
串口字节。`G431_STEADY_RESULT` 报告最后 40 窗的墙钟中位数和达实时的窗数，前 40 窗和
全程的中位数单独报告，不计入稳态验收。

在受控性能机上，从 `examples/devices` 运行以下命令；末 40 窗的墙钟中位数超过 2 ms
即失败。不设 `STEADY_REQUIRE_REALTIME` 时只报告耗时，不因宿主负载而失败。
如需同固件正确性对照，改用 `STEADY_MODE=precise` 并去掉实时门槛，仍只跑 5 窗。

```bash
STEADY_REQUIRE_REALTIME=1 pnpm exec vitest run --config vitest.perf.config.ts --no-cache \
  bench/stm32g431rbt6/full-peripheral-steady.test.ts
```
