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

读数方式：`bench/measure.mjs` 用**进程 CPU 时间**（不是挂钟）测量，同机多轮取最小值；
`bench/perf.test.ts` 的挂钟读数受宿主负载影响更大。下表的读数为 Node 24.18 / Windows x64、
单进程独占运行，仅用于同机前后对照。

### 交付基准（`bench/perf.test.ts`）

`gpio-blink`、1 MHz、20 ms 预热 + 500 ms 测量，11 引脚夹具（探针 + 驱动源）：

| 指标                               | 读数                                                                     |
| ---------------------------------- | ------------------------------------------------------------------------ |
| `coldMs`（搭板 + 首次翻译 + 预热） | 约 0.9 s                                                                 |
| `wallMs`（稳态 500 ms 仿真）       | 约 0.1 s                                                                 |
| `slowdown`（墙钟 / 仿真时间）      | 约 0.2×                                                                  |
| `jit`                              | `direct: true`；`cache: 20`（19 条指令块 + GPIOA 服务块），`programs: 1` |

### 裸板多主频

只有 MCU + 电源网络，100 ms 仿真，排除夹具的探针与驱动源开销。宿主为共享机器，同一份代码
的读数在本机可相差 ±40%，下表给出多次运行的范围：

| `clockFrequency` | `gpio-blink` slowdown | `gpio-blink` MIPS | `systick` slowdown | `systick` MIPS |
| ---------------- | --------------------- | ----------------- | ------------------ | -------------- |
| 1 MHz            | 0.16×                 | 6.3               | < 0.01×            | > 100          |
| 16 MHz（默认）   | 1.6–2.4×              | 7–10              | 0.6×               | 26             |
| 80 MHz           | 8–11×                 | 9–10              | 2.3–4.2×           | 19–34          |
| 100 MHz          | 7.7–12×               | 11–13             | 2.8–3.3×           | 30–36          |
| 170 MHz          | 13×                   | 13                | 4.5–7.8×           | 22–38          |

`systick` 与 `gpio-blink` 处于同一量级：`SERVICE_TICK` 现在也走直接后端，只做计数与异常
派发，路径比 GPIO 翻转短。两条固件的瓶颈都是「每条指令的固定成本」，因此降低实时倍率要
看引擎的派发与块开销，而不是固件本身。

`gpio-input` 是已知的慢用例（约 0.26 MIPS，两种后端都一样）：它在指令块里反复采样浮空引脚
并等待电平，每个采样都要触发电气求解，属于器件电学模型的成本，不是 direct 后端的问题。

### 器件侧的做法

指令块只保留「指令数据通路 + 累加耗时 + 一次粒度比较」，外设推进、异常派发与 GPIO 引脚
意图全部搬进按需翻译的服务块（`SERVICE_TICK`、`SERVICE_GPIO + port`、`SERVICE_SYNC`）：

- **节拍粒度按活跃外设取值**：`tickPs` 由 `refreshTick` 在会改变条件的寄存器写入处重算——
  SysTick 使能时取它的周期，有发送活动时取 1 µs，两者同时活跃取较小值。两者都不活跃时
  `tickActive` 为 false，指令块直接跳过服务，空闲固件完全不付这份成本。
- **USART 字节发布延迟到服务块**：TDR 写入只锁存待发字节，发布统一发生在服务块，使通道
  发布与节拍边界对齐、指令块保持无 `send` 的均匀成本。直接后端已支持内联 `send`，这条
  仍保留是因为它让发布时机可预期，而不是后端限制。
- **IT 块只在 `itState` 非零时求值**：指令体只发射一次（结果写进 local），条件码用
  「bit0 取反 + bit3..1 选 8 个基条件」的选择链，而不是 14 路逐值比较。

指令块因此只剩 150–200 个 IR 操作；`SERVICE_GPIO + port` 只在固件真的写某个端口时才翻译。

### 直接后端的派发成本

早期版本把常量与分支标签都发射成闭包数组下标（`case C[0]:`、`S[i] = C[17]`），每条指令都要
线性扫描块表，19 块器件上限约 11 MIPS。引擎侧已完成三项修复：

- `case` 标签、`pc`/`nextPc`、时长与安全整数/布尔/字符串常量都按字面量发射，派发不再走
  `C[]`；
- 服务块结尾的 `elapse(0)` 也能进入直接后端（零时长不需要续点），因此 `SERVICE_TICK`、
  `SERVICE_GPIO`、`SERVICE_SYNC` 不再退回解释路径；
- 超过 8 条指令的直接程序按「局部槽预算」切成若干 `stepShardN` 函数，由轻量 `run` 派发：
  单个函数保持在 V8 可优化的大小内，服务块这类巨型块单独成片。

修复前后同机对照（`bench/measure.mjs`，100 MHz，进程 CPU 时间，取多次运行的低端值）：
`gpio-blink` 约 5.1 → 11 MIPS，`systick` 约 2.8 → 30 MIPS。

剩余成本分两类：一是冷启动，首次翻译与每次新增块的整程序重编译仍占大头（`coldMs` 约
0.9 s，其中稳态仿真仅约 0.1 s）；二是服务块体量，`SERVICE_TICK` 展开后约 1300 个 SSA
局部槽，只能靠分片隔离而不能靠指令级优化。按块增量编译（而不是整程序重建）是下一步的
主要方向。

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
