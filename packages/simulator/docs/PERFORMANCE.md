# 性能基准

统一 IR 的核心承诺：把整块电路（器件 tick、电气解算、主循环）编译进一个 `@mica-js/ir` module，
让一个 tick 只付一次引擎调用，让一整批 tick 只付一次宿主调用。

## 测试环境

| 项目     | 值                                        |
| -------- | ----------------------------------------- |
| CPU      | AMD Ryzen 5 5600G（6 核 / 12 线程）       |
| 内存     | 16 GiB DDR4-3200                          |
| 操作系统 | Windows 11 专业版 10.0.26300              |
| Node.js  | v24.18.0                                  |
| 引擎     | `@mica-js/ir` JIT（默认 `engine: 'jit'`） |
| 运行器   | Vitest bench（Tinybench，交错采样）       |

数值是单机、单次运行的观测值；同一台机器上不同运行之间通常有 ±10–20% 波动。
性能文件与基准**只输出观测值，没有任何阈值或断言**：性能从不决定测试通过与否，
`pnpm test` / CI 也不会执行它们（见 `vite.config.ts` 的 `exclude`）。

## 结果摘要

| 场景                                    |     调度器路径 |          统一 IR |     加速比 |
| --------------------------------------- | -------------: | ---------------: | ---------: |
| MCU + LED，单步（每 tick 一次宿主调用） |     6.3–8.1 µs |       318–371 ns |     20–22× |
| MCU + LED，批处理（每批一次宿主调用）   |     6.3–8.1 µs |       6.6–6.8 ns | ~960–1200× |
| Teaching MCU 批处理（U03 口径）         | 0.160 M inst/s | 527–561 M inst/s |     ~3300× |
| Teaching M3 批处理（U03 口径）          | 0.160 M inst/s | 449–465 M inst/s |     ~2900× |

## 1. MCU + LED：调度器 vs 统一 IR

同一张电路、同一套器件逻辑（`mcu.PA0 → led.anode`、`led.cathode → GND`）：

- **调度器路径**：每器件一个 IR module，挂在 `@mica-js/core` 的调度器上，网络在 JavaScript 里桥接
  ——每 tick 三次宿主入口（MCU、解网、LED）。
- **统一 IR**：两个器件、解算器和主循环在同一个 module 里。

| 变体                                        |   ns/tick | 相对基线   |
| ------------------------------------------- | --------: | ---------- |
| 调度器：2 个 IR module + JS 解网            | 6334–8121 | 1.0×       |
| 统一 IR：每 tick 一次 `step()`              |   318–371 | 20–22×     |
| 统一 IR：每 2000 tick 一次 `runBatch(2000)` |   6.6–6.8 | ~960–1200× |

单步的上限由 `@mica-js/ir` 的每次执行入口开销决定（空 module 也约 400 ns，见微基准）；
吞吐路径是 `runBatch`。

### 绝对吞吐

MCU + LED，预热 100k tick 后连续跑 1,000,000 tick：

| 指标    | 观测值             |
| ------- | ------------------ |
| 耗时    | 12.5–17.8 ms       |
| 每 tick | 12.5–17.8 ns       |
| 吞吐    | **56–80 M tick/s** |

## 2. 器件组合

| 场景                             |               吞吐 | ns/tick |
| -------------------------------- | -----------------: | ------: |
| MCU + 8 个 `ideal-led`（8 条网） | 26.5–30.1 M tick/s |   33–38 |
| 按钮（去抖）+ 富 LED（`led-ir`） | 64.7–66.9 M tick/s |      15 |

8 个负载让每 tick 多出 8 次解算与 8 次 `update`，仍然是每 tick 数十纳秒量级。

## 3. Teaching MCU：真实固件

两个口径都保留，因为"每 tick 执行多少指令"会显著影响单指令成本：

### 3.1 时间切片（`instructionsPerTick: 1000`，本页基准）

blinky 固件（GPIO MMIO 写 ODR）驱动一个 LED，`runBatch(20_000)`：

| 指标         | 观测值                            |
| ------------ | --------------------------------- |
| tick 吞吐    | 0.3 M tick/s（3.1–3.4 µs/tick）   |
| 实际退休指令 | 20,030,492（来自 guest `cycles`） |
| 指令吞吐     | **~390 M inst/s**（51 ms）        |

region 编译器同样作用在这一路径上：`instructionsPerTick: 1000` 时每个 tick 的循环体
（约 333 次迭代）由 tick 内的 region 融合执行，因此小切片也能拿到接近长切片的单指令成本。

### 3.2 长切片（U03 性能测试口径）

`teaching-mcu.performance.test.ts` 用同一台机器、更长的切片和 `maxBlockInstructions: 4096`，
并与旧调度器器件直接对比。批处理数字取稳态中位数（宿主已完成译码、V8 已把生成代码
升到优化层），这也是实时仿真真正运行的区间：

| 路径                     |                        吞吐 |  相对调度器 |
| ------------------------ | --------------------------: | ----------: |
| 旧调度器器件             |               0.13–0.18 M/s |        1.0× |
| 统一 teaching ISA 批处理 |            486–505 M inst/s | ~2900–3300× |
| 统一 M3 批处理           |            583–595 M inst/s | ~3400–3900× |
| 统一 teaching ISA 单步   | 4.2–4.6 M tick/s（~570 ns） |     ~25–28× |

两个 ISA 的观测吞吐都远高于"实时仿真 72 MHz 教学板"所需的 72 M inst/s（450 M inst/s
的融合目标仅作为记录参考，测试并不对其断言）。provider 每次只翻译一个基本块，热循环的跨块派发由 JIT 的 region 编译器
消除：一个 60,000 次迭代的 M3 倒计数循环在整条 tick 内只进入 region 一次
（`dispatches/tick = 1.00`），循环体就是宿主 JavaScript 的循环。provider 侧的超级块
（window-CFG）翻译已删除。

teaching ISA 的固件是每块 2–3 条指令的 5 指令循环，块边界因此最密。它达到同一量级
靠的是 J16 的"跨指令边界"优化，也就是把 checkpoint 粒度从每指令放宽到 tick：

- region 内的常量下标数组元素（寄存器堆）提升为 region 局部量，跨成员可见；
- 常量偏移的 `bytes` 区间（GPIO 的 ODR/DIR）同样提升，块内不再读写 `DataView`；
- 步数计数器与 `ctl.suspended` / 存储epoch 提升为 region 局部量，只在 region 出口写回；
- 每个 artifact 只有一个边界块（后继 PC 作为值传递），因此 region 成员可以被结构化，
  而不是退化成 `switch (pc)` 循环。

这些优化只在 `checkpointGranularity: 'per-tick'`（默认）下生效；
`'per-instruction'` 关闭它们，让每个 MIR 块都可观测（单步调试用）。

### 3.3 冷启动与单步延迟

- **冷启动**：新进程里的第一条 `tick()` 只有 ~0.1 M inst/s。这一步支付的是宿主编译
  翻译块与 V8 首次编译生成函数的成本，每个进程只发生一次。
- **单步延迟**：`jit.execute` 的单次入口开销约 364–405 ns（见第 4 节），因此单步路径
  的下限就在 ~400 ns 量级，实测 600–700 ns/tick；"150 ns/步"低于引擎自身的入口成本，
  需要改造引擎入口才可能达到。

切片越长，每个 tick 内的边界检查与块切换占比越低，但单次 `tick` 的延迟也越大。
时间切片（3.1）是仿真器的默认工作方式；长切片（3.2）用于测引擎上限。

## 4. 微基准

| 操作                                                           |              成本 |
| -------------------------------------------------------------- | ----------------: |
| `compileCircuit(mcu + led)`（含校验）                          |      0.31–0.40 ms |
| `Circuit.reset()`（恢复 3×256 数组 + 器件状态 + `initialize`） |          66–69 µs |
| `step()`（单器件，引擎入口开销）                               |        364–405 ns |
| `runBatch(1000)`（单器件 LED）                                 |   3.5–3.7 ns/tick |
| `runBatch(1000)`（按钮 + 富 LED）                              | 15.1–15.3 ns/tick |
| `devices.led.isOn()`                                           |          53–57 ns |
| `getPin('led.anode')`                                          |          59–68 ns |
| `setPin('mcu.PA0')`                                            |          79–85 ns |

编译成本只在创建电路时支付一次；之后 `runBatch` 是纯执行路径。

## 5. 复现步骤

```sh
# 全部基准（约 35 s）
pnpm --filter @mica-js/simulator bench

# 带控制台输出的原始数字
pnpm --filter @mica-js/simulator exec vitest bench --run --disableConsoleIntercept

# 只跑某个文件
pnpm --filter @mica-js/simulator exec vitest bench --run bench/unified-simple.bench.ts

# 文档示例（LED 闪烁 / 按钮 / 教学 MCU 固件 / 吞吐）
pnpm --filter @mica-js/simulator examples

# 全部性能观测（不含任何断言，只看数字；不参与 `pnpm test` / CI）
pnpm --filter @mica-js/simulator test:perf

# U03 的调度器对照（含旧器件）
pnpm --filter @mica-js/simulator exec vitest run \
  src/unified-ir/examples/teaching-mcu/teaching-mcu.performance.test.ts \
  --disableConsoleIntercept
```

> 性能文件只做观测：它们**没有任何阈值或断言**，并且被 `vite.config.ts`
> 排除在 `pnpm test` 之外——机器繁忙时不会让测试失败。正确性由
> `*.test.ts` 中的结构性断言保证（例如 `region-debug.test.ts` 断言 region
> 已形成、每个 tick 退休的 guest 指令数）。

基准文件：

| 文件                             | 内容                                            |
| -------------------------------- | ----------------------------------------------- |
| `bench/current-architecture.ts`  | 调度器基线：两个 module + JS 解网，同一张电路   |
| `bench/unified-simple.bench.ts`  | 调度器 vs 统一 IR、单步 vs 批处理、1M tick 观测 |
| `bench/unified-micro.bench.ts`   | 编译、单步、批处理、`reset()`、访问器与引脚     |
| `bench/unified-devices.bench.ts` | MCU + 8 LED、按钮 + 富 LED、教学 MCU 真实固件   |

## 口径说明

- **`step()` vs `runBatch(n)`**：两者语义相同；`step()` 每次付一次引擎入口，`runBatch` 把循环留在
  module 里，所以吞吐差两个数量级。单步数据用于调试路径，不要拿它推断仿真吞吐。
- **基准不测导出 getter**：Vitest 的 module-runner 默认会给每个导出包一层计数 getter，这会主导
  指令派发的成本。`vite.config.ts` 里设置 `benchmark.suppressExportGetterWarnings: true`
  关闭该追踪，否则本机实测会慢 100 倍以上。
- **调度器基线是"刻意保留边界"的**：`bench/current-architecture.ts` 每 tick 三次宿主入口，
  用来量化统一 IR 去掉的正是这些边界，不代表调度器路径的最优写法。
- **参考解释器**：`engine: 'reference'` 用于逐值对照，比 JIT 慢一个数量级以上；性能数据均为 JIT。
