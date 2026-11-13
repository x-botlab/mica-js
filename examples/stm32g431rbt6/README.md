# STM32G431RBT6 器件包

ST 的 Arm Cortex-M4F 32 位 MCU（LQFP64，128 KiB Flash / 22 KiB SRAM + 10 KiB CCM SRAM）的
Mica 器件工程。器件 ID 是 `stm32g431rbt6`：JIT 按 PC 翻译一段连续的 Thumb/Thumb-2 指令
（默认最多 8 条一批），GPIO、RCC、SysTick、NVIC 与 USART1/2/3 发送器按寄存器建模。

属性：`firmware`（bytes，默认空）写入 `0x08000000` 起的 Flash，前两字是初始 SP 与复位入口；
`clockFrequency`（number，默认 16000000 Hz，DDL 断言落在 1000–170000000）给出指令耗时、
SysTick 与 USART 的时间基准。

工程位于 `examples/stm32g431rbt6`，作为 `@mica-js/example-stm32g431rbt6` 加入工作区，依赖
`@mica-js/sdk` 与 `@mica-js/simulator` 的 `workspace:*`（走 `source` 导出条件，不需要先构建
packages）。`mica build` 把产物写到包内 `dist/devices/stm32g431rbt6/{device.json, device.js}`。

## 性能

**主路径是运行时的默认值 `execution: 'throughput'`**（直接后端）。性能读数用真实工程固件，
不用合成夹具：`HAL_06_LCD.bin` 是 CT117E-M4 的 Keil 产物，复位后要跑完时钟树（HSI16 → PLL
80 MHz，轮询 PWR 的 VOSF）、`MX_GPIO_Init`、`MX_USART1_UART_Init`，然后是 ILI9325 的 BSP
初始化（背光、寄存器序列、多次 `HAL_Delay`）。`HAL_Delay` 靠 SysTick 中断推进 `uwTick`，
因此同一段窗口覆盖 GPIO、RCC、PWR、USART、SysTick、NVIC 与 Flash 取指。

测量口径：裸 MCU 板（只接 VDD/VSS，去掉 LCD 与探针）、80 MHz（固件自己配置的主频）、
进程 CPU 时间、三轮取最小值。两个窗口：**冷启动** 0 → 200 µs；**稳态** 200 µs → 220 ms。

### 实测（`bench/hal-throughput.test.ts` / `bench/hal-precise.test.ts`）

2026-11-14 当前快照（精确值随宿主和 V8 状态变化，以测试 stdout 为准）：

| 指标                    | `throughput`（主路径） |
| ----------------------- | ---------------------- |
| 0 → 200 µs 冷启动       | 约 358–361 ms CPU      |
| 200 µs → 220 ms 稳态    | 约 1.007–1.013 s CPU   |
| 稳态实时倍率            | 约 0.22×               |
| 整段 220 ms（含冷启动） | 约 1.368–1.370 s       |
| 缓存指令块              | 411                    |

`throughput` 已按 PC 缓存已编译 `Instruction`，首个 200 µs 的 25 次程序级重建不再重复执行
块级 `emit/compact/rewrite`；剩余冷启动成本主要是 full dispatcher/shard 组装和 V8 首次优化。
`precise` 只作为同固件对照，精确值以 `bench/hal-precise.test.ts` 输出为准。

### 轻量基线（`bench/perf.test.ts`）

`gpio-blink`、1 MHz、20 ms 预热 + 500 ms 测量、11 引脚夹具（探针 + 驱动源）：

| 指标                               | 读数                                                                     |
| ---------------------------------- | ------------------------------------------------------------------------ |
| `coldMs`（搭板 + 首次翻译 + 预热） | 约 0.5–0.7 s                                                             |
| `wallMs`（稳态 500 ms 仿真）       | 约 3 ms                                                                  |
| `slowdown`（墙钟 / 仿真时间）      | 约 0.01×                                                                 |
| `jit`                              | `direct: true`；`cache: 12`（11 个指令块 + GPIOA 服务块），`programs: 1` |

这个夹具的延时是 `subs; bne` 忙等循环，`delayLoops` 会把整圈折算成一次时间推进，所以它的
墙钟/MIPS **不能**当作逐指令成本；`bench/measure.mjs` 的 BARE 行同理，只适合同口径对照。

`gpio-input` 是已知的慢用例：它在指令块里反复采样浮空引脚并等待电平，每个采样都要触发电气
求解，属于器件电学模型的成本，与后端无关。

### 器件侧的做法

指令块只保留「指令数据通路 + 累加耗时 + 一次服务判定」，外设推进、异常派发与 GPIO 引脚
意图全部搬进按需翻译的服务块（`SERVICE_TICK`、`SERVICE_GPIO + port`、`SERVICE_SYNC`、
`SERVICE_READ`、`SERVICE_WRITE`）：

- **连续指令合成一个块**：`collectBatch` 从批首起收集最多 8 条顺序指令，发射进同一个块体，
  块尾只 `elapse` 一次（时长为已执行指令的周期和）。三条收块规则：写 pc 的指令之后收块；
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
- **USART 字节发布延迟到服务块**：TDR 写入只锁存待发字节，发布统一发生在服务块，使通道
  发布与节拍边界对齐、指令块保持无 `send` 的均匀成本。直接后端已支持内联 `send`，这条
  仍保留是因为它让发布时机可预期，而不是后端限制。

当前 411 个可编译块共约 310,231 个含嵌套 IR 操作、186,350 条发射语句、约 5.4 MB 生成源码。
普通块平均约 733 个嵌套操作、438 条语句；`SERVICE_GPIO + port` 只有固件写到对应端口时才翻译，
但执行频率很高。块结构与根因见 `docs/mcu-jit-block-inflation.md`，缺陷与限制见
`docs/stm32g431rbt6-issues.md`。

### 直接后端的剩余成本

- **冷启动**：首次翻译与整程序重建占大头。直接程序暴露它编译过的 PC 集合，翻译只增不改，
  因此旧程序对已覆盖的 PC 继续有效；重建按 `max(步长, 已编译块数)` 摊薄，并对反复回退的 PC
  提前触发。即便如此，411 个块仍要 25 次重建、近 1 s。
- **服务块体量**：`SERVICE_WRITE` / IDR 大块主要影响首次翻译；GPIO 写服务在稳态也高频执行。
  已改为按 ODR/BSRR/BRR 的实际变化位生成精确掩码，并按 4 位分组刷新引脚意图；同引擎 A/B
  下 GPIO 服务优化约带来 11% 稳态提升。
- **shard/dispatcher**：最终程序约 146 个 step shard，220 ms 内平均每个 shard 只执行约 1.32 个块；
  16 路以上已改用平衡区间树路由，稳定窗口约再提升 5%。
- **板上只能有一个 JIT 设备**：`runDirect` 在 `board.jits.length !== 1` 时关闭，多 MCU 板会
  静默退回解释器。

## 验证

```powershell
cd examples/stm32g431rbt6
pnpm run typecheck        # mica prepare && tsc --noEmit
pnpm run test             # mica build + vitest（源码用例 + 交付产物用例）
pnpm run bench            # mica build + vitest --config vitest.perf.config.ts（性能基准）
```

`pnpm run bench` 跑三个文件：`bench/perf.test.ts`（`gpio-blink`，1 MHz，500 ms 仿真，结果
**追加**到 `bench/results.jsonl`）、`bench/hal-throughput.test.ts` 与 `bench/hal-precise.test.ts`
（`HAL_06_LCD`，80 MHz，冷启动 + 稳态，只把 `HAL {...}` 打到标准输出）。基准要求独占 CPU：
每轮只跑一次、需要读数时连跑 3 次取最小值；`jit.direct` 应为 `true`、`programs` 为 1
（`direct:false` + `programs:1` 说明整程序被直接后端拒绝并写了否定缓存）。

两个 HAL 基准必须**分开进程**运行：器件的翻译缓存是模块级的，同进程里先跑完一种模式会把
缓存焐热，另一种模式的冷启动读数就不可信了。

`bench/measure.mjs` 用**进程 CPU 时间**重跑 `gpio-blink` 与 `systick` 的多主频读数
（BENCH / BARE 两类 JSON 行）。注意这两条固件的延时都能被 `delayLoops` 折算，BARE 行只适合
同口径对照，不代表逐指令成本。

```powershell
node bench/measure.mjs
```

`test/fixtures/generate.py` 用 Keystone 生成裸二进制固件（开发期工具，不参与运行期）：
`gpio-blink`（PA5 推挽翻转）、`gpio-input`（IDR 镜像到 ODR）、`arith`（32 位逻辑/位段/条件分支）、
`uart2-tx`（USART2 发送 `OK`）、`systick`（1 ms SysTick 中断翻转 PA5）。用例覆盖复位取向量、
推挽输出、IDR 采样、Thumb-2 数据处理、USART 字节发送与 SysTick 异常入口/返回。
