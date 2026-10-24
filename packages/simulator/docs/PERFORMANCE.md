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
脚本本身带回归门槛（例如批处理必须比调度器基线快 10× 以上），所以波动不会掩盖真实退化。

## 结果摘要

| 场景                                    |     调度器路径 |       统一 IR |     加速比 |
| --------------------------------------- | -------------: | ------------: | ---------: |
| MCU + LED，单步（每 tick 一次宿主调用） |         8.1 µs |        371 ns |  **21.9×** |
| MCU + LED，批处理（每批一次宿主调用）   |         8.1 µs |        6.8 ns | **~1200×** |
| Teaching MCU 批处理（U03 口径）         | 0.160 M inst/s | 11.2 M inst/s |    **70×** |
| Teaching M3 批处理（U03 口径）          | 0.160 M inst/s | 27.1 M inst/s |   **169×** |

## 1. MCU + LED：调度器 vs 统一 IR

同一张电路、同一套器件逻辑（`mcu.PA0 → led.anode`、`led.cathode → GND`）：

- **调度器路径**：每器件一个 IR module，挂在 `@mica-js/core` 的调度器上，网络在 JavaScript 里桥接
  ——每 tick 三次宿主入口（MCU、解网、LED）。
- **统一 IR**：两个器件、解算器和主循环在同一个 module 里。

| 变体                                        | ns/tick | 相对基线 |
| ------------------------------------------- | ------: | -------: |
| 调度器：2 个 IR module + JS 解网            |  8120.8 |     1.0× |
| 统一 IR：每 tick 一次 `step()`              |   370.8 |    21.9× |
| 统一 IR：每 2000 tick 一次 `runBatch(2000)` |     6.8 |  1199.7× |

单步的上限由 `@mica-js/ir` 的每次执行入口开销决定（空 module 也约 400 ns，见微基准）；
吞吐路径是 `runBatch`。

### 绝对吞吐

MCU + LED，预热 100k tick 后连续跑 1,000,000 tick：

| 指标    | 观测值                                    |
| ------- | ----------------------------------------- |
| 耗时    | 17.8 ms（另一次运行 11.7 ms）             |
| 每 tick | 17.8 ns（另一次 11.7 ns）                 |
| 吞吐    | **56.2 M tick/s**（另一次 85.2 M tick/s） |

## 2. 器件组合

| 场景                             |          吞吐 | ns/tick |
| -------------------------------- | ------------: | ------: |
| MCU + 8 个 `ideal-led`（8 条网） | 30.1 M tick/s |    33.2 |
| 按钮（去抖）+ 富 LED（`led-ir`） | 64.7 M tick/s |    15.5 |

8 个负载让每 tick 多出 8 次解算与 8 次 `update`，仍然是每 tick 数十纳秒量级。

## 3. Teaching MCU：真实固件

两个口径都保留，因为"每 tick 执行多少指令"会显著影响单指令成本：

### 3.1 时间切片（`instructionsPerTick: 1000`，本页基准）

blinky 固件（GPIO MMIO 写 ODR）驱动一个 LED，`runBatch(20_000)`：

| 指标         | 观测值                            |
| ------------ | --------------------------------- |
| tick 吞吐    | 0.3 M tick/s（3436 ns/tick）      |
| 实际退休指令 | 20,030,492（来自 guest `cycles`） |
| 指令吞吐     | **320 M inst/s**（62.6 ms）       |

### 3.2 长切片（U03 性能测试口径）

`teaching-mcu.performance.test.ts` 用同一台机器、更长的切片和 `maxBlockInstructions: 4096`，
并与旧调度器器件直接对比：

| 路径                     |           吞吐 | 相对调度器 |
| ------------------------ | -------------: | ---------: |
| 旧调度器器件             | 0.160 M inst/s |       1.0× |
| 统一 teaching ISA 批处理 | 11.24 M inst/s |      70.4× |
| 统一 M3 批处理           | 27.06 M inst/s |     169.4× |
| 统一 teaching ISA 单步   |  1.72 M inst/s |      10.8× |

切片越长，每个 tick 内的边界检查与块切换占比越低，但单次 `tick` 的延迟也越大。
时间切片（3.1）是仿真器的默认工作方式；长切片（3.2）用于测引擎上限。

## 4. 微基准

| 操作                                                           |         成本 |
| -------------------------------------------------------------- | -----------: |
| `compileCircuit(mcu + led)`（含校验）                          |      0.40 ms |
| `Circuit.reset()`（恢复 3×256 数组 + 器件状态 + `initialize`） |        69 µs |
| `step()`（单器件，引擎入口开销）                               |       405 ns |
| `runBatch(1000)`（单器件 LED）                                 |  3.7 ns/tick |
| `runBatch(1000)`（按钮 + 富 LED）                              | 15.3 ns/tick |
| `devices.led.isOn()`                                           |      56.5 ns |
| `getPin('led.anode')`                                          |      68.4 ns |
| `setPin('mcu.PA0')`                                            |      79.1 ns |

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

# U03 的调度器对照（含旧器件）
pnpm --filter @mica-js/simulator exec vitest run \
  src/unified-ir/examples/teaching-mcu/teaching-mcu.performance.test.ts \
  --disableConsoleIntercept
```

基准文件：

| 文件                             | 内容                                            |
| -------------------------------- | ----------------------------------------------- |
| `bench/current-architecture.ts`  | 调度器基线：两个 module + JS 解网，同一张电路   |
| `bench/unified-simple.bench.ts`  | 调度器 vs 统一 IR、单步 vs 批处理、1M tick 门槛 |
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
