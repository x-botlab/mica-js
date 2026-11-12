# STM32G431RBT6 器件包

ST 的 Arm Cortex-M4F 32 位 MCU（LQFP64，128 KiB Flash / 22 KiB SRAM + 10 KiB CCM SRAM）的
Mica 器件工程。器件 ID 是 `stm32g431rbt6`：JIT 按 PC 翻译一条 Thumb/Thumb-2 指令，GPIO、
RCC、SysTick、NVIC 与 USART1/2/3 发送器按寄存器建模。

属性：`firmware`（bytes，默认空）写入 `0x08000000` 起的 Flash，前两字是初始 SP 与复位入口；
`clockFrequency`（number，默认 16000000 Hz，DDL 断言落在 1000–170000000）给出指令耗时、
SysTick 与 USART 的时间基准。

工程位于 `examples/stm32g431rbt6`，作为 `@mica-js/example-stm32g431rbt6` 加入工作区，依赖
`@mica-js/sdk` 与 `@mica-js/simulator` 的 `workspace:*`（走 `source` 导出条件，不需要先构建
packages）。`mica build` 把产物写到包内 `dist/devices/stm32g431rbt6/{device.json, device.js}`。

## 性能现状

读数方式：`taskset` 绑核，用**进程 CPU 时间**而不是挂钟（本机常有其他编译任务，同一份代码
的挂钟读数可差 1.6 倍）；每档跑多轮取最小值。

### 交付基准（`bench/perf.test.ts`）

`gpio-blink`、1 MHz、20 ms 预热 + 500 ms 测量，11 引脚夹具（探针 + 驱动源）：

| 指标                               | 读数                                                                     |
| ---------------------------------- | ------------------------------------------------------------------------ |
| `coldMs`（搭板 + 首次翻译 + 预热） | 0.30 s                                                                   |
| `wallMs`（稳态 500 ms 仿真）       | 0.27 s                                                                   |
| `slowdown`（墙钟 / 仿真时间）      | 0.54×                                                                    |
| `jit`                              | `direct: true`；`cache: 20`（19 条指令块 + GPIOA 服务块），`programs: 1` |

### 裸板多主频

只有 MCU + 电源网络，100 ms 仿真，排除夹具的探针与驱动源开销：

| `clockFrequency` | `gpio-blink` slowdown | `gpio-blink` MIPS | `systick` slowdown | `systick` MIPS |
| ---------------- | --------------------- | ----------------- | ------------------ | -------------- |
| 1 MHz            | 0.45×                 | 2.2               | 0.43×              | 2.3            |
| 16 MHz（默认）   | 4.5×                  | 3.5               | 6.7×               | 2.4            |
| 80 MHz           | 22×                   | 3.6               | 34×                | 2.4            |
| 100 MHz          | 28×                   | 3.5               | 42×                | 2.4            |
| 170 MHz          | 48×                   | 3.5               | 72×                | 2.4            |

吞吐基本不随主频变化（约 2.2–3.6 M 条 guest 指令/秒），因为瓶颈是「每条指令的固定成本」：
主频越高，实时差距按比例放大。

`systick` 比 `gpio-blink` 低约三分之一：它每个 SysTick 周期都要进一次 `SERVICE_TICK`，而
服务块按设计不进直接后端（块尾是 `elapse(0)`），只能走解释路径。

### 器件侧的做法

指令块只保留「指令数据通路 + 累加耗时 + 一次粒度比较」，外设推进、异常派发与 GPIO 引脚
意图全部搬进按需翻译的服务块（`SERVICE_TICK`、`SERVICE_GPIO + port`、`SERVICE_SYNC`）：

- **节拍粒度按活跃外设取值**：`tickPs` 由 `refreshTick` 在会改变条件的寄存器写入处重算——
  SysTick 使能时取它的周期，有发送活动时取 1 µs，两者同时活跃取较小值。两者都不活跃时
  `tickActive` 为 false，指令块直接跳过服务，空闲固件完全不付这份成本。
- **USART 字节发布延迟到服务块**：TDR 写入只锁存待发字节，不在指令块里 `send`；否则含外设
  写的块会被直接后端整块拒绝，永远走解释路径。
- **IT 块只在 `itState` 非零时求值**：指令体只发射一次（结果写进 local），条件码用
  「bit0 取反 + bit3..1 选 8 个基条件」的选择链，而不是 14 路逐值比较。

指令块因此只剩 150–200 个 IR 操作；`SERVICE_GPIO + port` 只在固件真的写某个端口时才翻译。

### 剩余差距在引擎的直接后端

`compiler/src/direct-jit.ts` 生成的 `run` 是 `switch (H.checkPc(S[pc])) { case C[0]: … }`：
**case 标签取自闭包常量数组 `C[]` 而不是字面量**。JavaScript 的 `case` 表达式按顺序逐个
求值，所以每条指令都要线性扫描一遍块表。同机实测（Node 24，同样的块体与状态访问）：

| 块数 | `case C[n]`（引擎现状） | `case` 字面量            |
| ---- | ----------------------- | ------------------------ |
| 19   | 89 ns/指令（11 MIPS）   | 5.96 ns/指令（168 MIPS） |
| 64   | 228 ns/指令（4.4 MIPS） | 8.07 ns/指令（124 MIPS） |

数值常量也走 `C[]`（不是字面量），单独成本约 31–34 ns/指令（与块数无关）。两者叠加后，
19 块器件的直接后端上限约 11 MIPS、64 块约 4.4 MIPS——这是引擎的派发成本，器件侧无法
消除。引擎自带的 `packages/compiler` 基准测的是 `compileBody` 生成器路径（1.29 亿
rounds/s），不经过这条逐指令派发，因此不能用它推断器件指令吞吐。

要达到默认 16 MHz 实时，需要引擎把 case 标签与数值常量按字面量发射（语义等价，实测
19 块可到 168 MIPS）；80/100 MHz 还要求固件的工作集块数保持在中几十以内。

## 验证

```powershell
cd examples/stm32g431rbt6
pnpm run typecheck        # mica prepare && tsc --noEmit
pnpm run test             # mica build + vitest（源码用例 + 交付产物用例）
pnpm run bench            # mica build + vitest --config vitest.perf.config.ts（性能基准）
```

`pnpm run bench` 跑 `bench/perf.test.ts`（`gpio-blink`，1 MHz，500 ms 仿真），把一次
`{device, firmware, clockFrequency, simMs, coldMs, wallMs, slowdown, jit}` 结果**追加**到
`bench/results.jsonl`，并同时打印到标准输出。基准要求独占 CPU：每轮只跑一次、需要读数时
连跑 3 次取最小值；`jit.direct` 应为 `true`、`programs` 为 1（`direct:false` + `programs:1`
说明整程序被直接后端拒绝并写了否定缓存）。

`bench/measure.mjs` 用**进程 CPU 时间**重跑同样的口径，并额外给出裸板多主频读数
（BENCH / BARE 两类 JSON 行），受宿主负载影响小，适合与上面的表对照：

```powershell
node bench/measure.mjs
```

`test/fixtures/generate.py` 用 Keystone 生成裸二进制固件（开发期工具，不参与运行期）：
`gpio-blink`（PA5 推挽翻转）、`gpio-input`（IDR 镜像到 ODR）、`arith`（32 位逻辑/位段/条件分支）、
`uart2-tx`（USART2 发送 `OK`）、`systick`（1 ms SysTick 中断翻转 PA5）。用例覆盖复位取向量、
推挽输出、IDR 采样、Thumb-2 数据处理、USART 字节发送与 SysTick 异常入口/返回。
