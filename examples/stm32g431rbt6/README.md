# STM32G431RBT6 器件包

ST 的 Arm Cortex-M4F 32 位 MCU（LQFP64，128 KiB Flash / 22 KiB SRAM + 10 KiB CCM SRAM）的
Mica 器件工程。器件 ID 是 `stm32g431rbt6`：JIT 按 PC 翻译一段连续的 Thumb/Thumb-2 指令
（按复杂度预算合批，硬上限 36 条），GPIO、RCC、SysTick、NVIC 与 USART1/2/3 发送器按寄存器建模。

属性：`firmware`（bytes，默认空）写入 `0x08000000` 起的 Flash，前两字是初始 SP 与复位入口；
`clockFrequency`（number，默认 16000000 Hz，DDL 断言落在 1000–170000000）给出指令耗时、
SysTick 与 USART 的时间基准。

工程位于 `examples/stm32g431rbt6`，作为 `@mica-js/example-stm32g431rbt6` 加入工作区，依赖
`@mica-js/sdk`、`@mica-js/simulator` 与 `@mica-js/stm32g431rbt6-core` 的 `workspace:*`（走
`source` 导出条件，不需要先构建 packages）。

MCU 内核位于 `examples/stm32g431rbt6-core`（包名 `@mica-js/stm32g431rbt6-core`）：Thumb/Thumb-2
译码与执行、总线与内存布局、GPIO/RCC/PWR/SysTick/NVIC/USART 模型、寄存器常量与寄存器事实
都由共享包提供，并按模块导出子路径。本工程与 `examples/ct117e-m4` 共用这份内核；器件 ID、
属性、DDL 模型、JIT 合批与服务块编排仍在本工程。
`mica build` 在构建期把该依赖打进 `dist/devices/stm32g431rbt6/device.js`，该模块自包含，
运行时不加载共享包。

## 性能

**主路径是运行时的默认值 `execution: 'throughput'`**（直接后端）。性能读数用真实工程固件，
不用合成夹具：`HAL_06_LCD.bin` 是 CT117E-M4 的 Keil 产物，复位后要跑完时钟树（HSI16 → PLL
80 MHz，轮询 PWR 的 VOSF）、`MX_GPIO_Init`、`MX_USART1_UART_Init`，然后是 ILI9325 的 BSP
初始化（背光、寄存器序列、多次 `HAL_Delay`）。`HAL_Delay` 靠 SysTick 中断推进 `uwTick`，
因此同一段窗口覆盖 GPIO、RCC、PWR、USART、SysTick、NVIC 与 Flash 取指。

测量口径：裸 MCU 板（只接 VDD/VSS，去掉 LCD 与探针）、80 MHz（固件自己配置的主频）、
进程 CPU 时间、三轮取最小值。三个窗口：**冷启动** 0 → 200 µs；**官方稳态** 200 µs → 220 ms；
**无重建稳态** 220 ms → 440 ms。

### 实测（`bench/hal-throughput.test.ts` / `bench/hal-precise.test.ts`）

2026-11-14 当前快照（精确值随宿主和 V8 状态变化，以测试 stdout 为准）：

| 指标                    | `throughput`（主路径，三次独立进程） |
| ----------------------- | ------------------------------------ |
| 0 → 200 µs 冷启动       | 约 236–243 ms CPU                    |
| 200 µs → 220 ms 稳态    | 约 415–433 ms CPU                    |
| 220 ms → 440 ms 无重建  | 约 161–179 ms CPU                    |
| 官方稳态实时倍率        | 约 0.51–0.53×                        |
| 无重建实时倍率          | 约 1.23–1.36×                        |
| 整段 220 ms（含冷启动） | 约 658–670 ms                        |
| 缓存指令块              | 311                                  |
| resident shard          | 71                                   |
| 程序编译次数 / fallback | 21 / 2873                            |

`throughput` 已按 PC 缓存已编译 `Instruction`，并将已生成的 shard 函数常驻在 direct cache 中；
每个程序修订只生成小的 PC dispatcher，新增块通常只重发开放尾 shard，并按容量回填相邻的
稀疏 shard。220 ms 后 `directCompiles` 保持为 21，220 ms → 440 ms 没有新增编译或 fallback。
剩余冷启动成本主要是首次设备 Thumb 翻译、IR builder 与校验，以及 V8 首次优化和 GC。
`precise` 只作为同固件对照，精确值以 `bench/hal-precise.test.ts` 输出为准。

静态 BSRR/BRR 写会直接生成 ODR 与引脚 intent；若该写可能改变引脚，基本块在其后收束，让宿主
电气边界看到完整脉冲。`0x08001104..0x08001152` 因此形成 8 个边沿块，而不是一个会吞掉 WR
低→高跳变的大块。真实 ILI9325 联合测试和 `gpio-sync` 的 `[2,0,1,0]` 历史断言覆盖这一约束。

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

当前基准缓存 311 个块、71 个 resident shard。`0x08001104` 边沿块生成约 36.6 KB JS；
8 个 LCD 边沿块合计约 251 KB。静态 GPIO 写不再经过 GPIOB service：220 ms → 440 ms 窗口
中 GPIOB service 仅 54 次、GPIOC service 892 次，全部块入口 1,372,502 次。

### 直接后端的剩余成本

- **冷启动**：首次设备 Thumb 翻译、IR builder 与校验占大头；直接程序的 shard 常驻已消除
  每轮重拼完整源码和重新优化已封闭 shard。311 个块仍需要首次翻译和 21 次增量程序组装，
  `0 → 200 µs` 约 0.24 s。
- **GPIO 边沿块**：静态写已内联 ODR/intent，GPIOB service 基本消失；剩余成本集中在 intent
  树、`sample('VDD1')` 与每边沿一次 ODR 状态提交。ODR 的全部宽度和地址路径统一从状态
  读写，`periph` 不再保存重复副本。不能通过合块继续削减，否则会吞掉
  WR 等外部可观察脉冲。
- **shard/dispatcher**：最终程序 71 个 step shard。8 个 LCD 边沿块仍分散在多个 shard，
  dispatcher 约占稳态 24.4% self samples；后续优先热 shard compaction / 下一 shard 句柄。
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
