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
脚本本身带回归门槛（例如 1M tick 批处理必须满足绝对吞吐下限），所以波动不会掩盖真实退化。

> **口径提示**：本页数字取自内建 `mcu` / `led` 最小内核还在包内时（以及 Playground 的教学 MCU 模型）
> 的测量。这些器件模型已经移出 `@mica-js/simulator`，现在的 `bench/unified-simple.bench.ts`
> 使用包内的 driver / sink 测试夹具（同样的网络形状、同样的器件逻辑），第 1 节的绝对吞吐与
> 第 4 节微基准可直接复现；第 2、3 节保留历史记录，复现需要对应的器件包。

## 结果摘要

| 场景                                    |          统一 IR |
| --------------------------------------- | ---------------: |
| MCU + LED，单步（每 tick 一次宿主调用） |       318–371 ns |
| MCU + LED，批处理（每批一次宿主调用）   |       6.6–6.8 ns |
| Teaching MCU 批处理（U03 口径）         | 527–561 M inst/s |
| Teaching M3 批处理（U03 口径）          | 449–465 M inst/s |

## 1. driver + sink（原 mcu + led）：统一 IR

同一张电路、同一套器件逻辑（`driver.PA0 → sink.anode`、`sink.cathode → GND`），两个器件、
解算器和主循环在同一个 module 里。

| 变体                                        | ns/tick |
| ------------------------------------------- | ------: |
| 统一 IR：每 tick 一次 `step()`              | 318–371 |
| 统一 IR：每 2000 tick 一次 `runBatch(2000)` | 6.6–6.8 |

单步的上限由 `@mica-js/ir` 的每次执行入口开销决定（空 module 也约 400 ns，见微基准）；
吞吐路径是 `runBatch`。

### 绝对吞吐

driver + sink，预热 100k tick 后连续跑 1,000,000 tick：

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

超级块翻译同样作用在这一路径上：`instructionsPerTick: 1000` 时每个 tick 的循环体
（约 333 次迭代）留在同一个翻译单元里，因此小切片也能拿到接近长切片的单指令成本。

超级块翻译同样作用在这一路径上：`instructionsPerTick: 1000` 时每个 tick 的循环体
（约 333 次迭代）留在同一个翻译单元里，因此小切片也能拿到接近长切片的单指令成本。

### 3.2 长切片（U03 性能测试口径）

本轮测量使用当时随包提供的教学 MCU 模型（现已在 Playground 器件库中），同一台机器、更长的切片和 `maxBlockInstructions: 4096`。
批处理数字取稳态中位数（宿主已完成译码、V8 已把生成代码
升到优化层），这也是实时仿真真正运行的区间：

| 路径                     |                        吞吐 |
| ------------------------ | --------------------------: |
| 统一 teaching ISA 批处理 |            527–561 M inst/s |
| 统一 M3 批处理           |            449–465 M inst/s |
| 统一 teaching ISA 单步   | 3.6–4.1 M tick/s（~620 ns） |

两个 ISA 都远高于"实时仿真 72 MHz 教学板"所需的 72 M inst/s。超级块翻译消除了
每基本块一次的 provider 派发：一个 60,000 次迭代的 M3 倒计数循环在整条 tick 内只
进入翻译单元一次（`dispatches/tick = 1.00`），循环体就是宿主 JavaScript 的循环。

### 3.3 冷启动与单步延迟

- **冷启动**：新进程里的第一条 `tick()` 只有 ~0.1 M inst/s。这一步支付的是宿主编译
  翻译单元与 V8 首次编译生成函数的成本；它与翻译器无关（`MICA_DISABLE_SUPERBLOCK=1`
  时同样如此），每个进程只发生一次。
- **单步延迟**：`jit.execute` 的单次入口开销约 364–405 ns（见第 4 节），因此单步路径
  的下限就在 ~400 ns 量级，实测 600–700 ns/tick；"150 ns/步"低于引擎自身的入口成本，
  需要改造引擎入口才可能达到。

切片越长，每个 tick 内的边界检查与块切换占比越低，但单次 `tick` 的延迟也越大。
时间切片（3.1）是仿真器的默认工作方式；长切片（3.2）用于测引擎上限。

## 4. 微基准

| 操作                                                        |              成本 |
| ----------------------------------------------------------- | ----------------: |
| `compileCircuit(driver + sink)`（含校验）                   |      0.31–0.40 ms |
| `Circuit.reset()`（恢复引脚内存 + 器件状态 + `initialize`） |            3–4 µs |
| `step()`（单器件，引擎入口开销）                            |        364–405 ns |
| `runBatch(1000)`（单器件 sink）                             |   3.5–3.7 ns/tick |
| `runBatch(1000)`（按钮 + 带状态 sink）                      | 15.1–15.3 ns/tick |
| `devices.sink.getState('lamp')`                             |          53–57 ns |
| `getPin('sink.anode')`                                      |          59–68 ns |
| `setPin('drive.PA0')`                                       |          79–85 ns |

编译成本只在创建电路时支付一次；之后 `runBatch` 是纯执行路径。共享的引脚内存按电路实际声明的
引脚数分配（`UNIFIED_PIN_CAPACITY` 只是分配期上限），所以创建与 `reset()` 的成本只随实际引脚数增长，
与上限值无关。

## 电阻求解数值实验（2026-10-30）

```sh
pnpm --filter @mica-js/simulator bench:resistive
```

独立配置直接使用源码，不需要预构建 sandbox；实验不改变产品求解器。
[基准源码](../bench/resistive-number.bench.ts) 比较相同的三节点线性电阻网络：
节点间 A-B、B-C 各 1 mS，节点到三个已知电压源的电导分别为 3、2、2 mS。
固定导纳矩阵在计时前求逆，每 tick 切换第一个源电压，执行三行矩阵向量乘法，
保存三个节点电压及三个数字门限结果。两种实现采用相同的运算顺序和输入。

- IR 路径使用当前 `createIRJIT`、f64 数组及批处理循环。
- 原生路径使用普通 JS number、`Float64Array` 和 `Uint8Array`，不提供 IR 的权限、
  暂停检查、资源版本跟踪或特殊 NaN 位模式保真合同，只作为专用数值内核的性能参考。
- 计时前每种实现预热 500k tick；随后交替执行顺序，各测 9 轮，每轮 1M tick。
  输出全部样本、最小值及中位数，不设机器相关的速度断言。
- 正确性检查独立于计时：与 reference interpreter 对比奇偶 tick、拆分批次、零长度批次、
  数字结果与电压，并检查三个节点的 KCL 残差小于 `1e-12`（以 mS、V 为数值单位）。

Node v24.18.0、Windows x64，两个独立进程的观测值：

| 路径              | 最小值 / ns/tick | 中位数 / ns/tick |
| ----------------- | ---------------: | ---------------: |
| 当前 IR f64 JIT   |    30.65 / 34.83 |    35.68 / 42.46 |
| 原生 Float64Array |      3.94 / 4.20 |      5.35 / 5.64 |

该形状下中位数相差约 6.7–7.5 倍，但不能把差值全部归因于浮点内存表示，
也不能承诺 IR 能获得同等加速：两条路径的检查、资源跟踪和优化机会不同。
此前临时探针的约 477 ns/tick 未被这次受控实验复现，不应继续用它估算产品成本。
此实验也不包含动态电导、矩阵重分解、非线性迭代、脏组检测、器件执行或完整电路调度。
它证明小型固定线性网络的算术成本可以很低，而不是完整模拟引擎已经具备该吞吐。

## 5. 复现步骤

```sh
# 全部基准（约 35 s）
pnpm --filter @mica-js/simulator bench

# 带控制台输出的原始数字
pnpm --filter @mica-js/simulator exec vitest bench --run --disableConsoleIntercept

# 只跑某个文件
pnpm --filter @mica-js/simulator exec vitest bench --run bench/unified-simple.bench.ts

```

基准文件：

| 文件                            | 内容                                                   |
| ------------------------------- | ------------------------------------------------------ |
| `bench/unified-simple.bench.ts` | 单步 vs 批处理、1M tick 门槛与 step / batch 一致性检查 |

## 口径说明

- **`step()` vs `runBatch(n)`**：两者语义相同；`step()` 每次付一次引擎入口，`runBatch` 把循环留在
  module 里，所以吞吐差两个数量级。单步数据用于调试路径，不要拿它推断仿真吞吐。
- **基准不测导出 getter**：Vitest 的 module-runner 默认会给每个导出包一层计数 getter，这会主导
  指令派发的成本。`vite.config.ts` 里设置 `benchmark.suppressExportGetterWarnings: true`
  关闭该追踪，否则本机实测会慢 100 倍以上。
- **参考解释器**：`engine: 'reference'` 用于逐值对照，比 JIT 慢一个数量级以上；性能数据均为 JIT。

## 线性电阻 Circuit 端到端基准

```sh
pnpm --filter @mica-js/simulator exec vitest run --config bench/electrical-circuit.config.ts
```

`electrical-circuit.bench.ts` 使用公共 `Circuit`，同一电路包含分压、电位器、DAC、触点和输入负载。计时前比较 reference/JIT 的引脚、电阻电流、普通状态及 reset，检查真实分压和变更效果；计时为 JIT `runBatch` 的普通循环，不使用 Tinybench。

可通过 `MICA_BENCH_TICKS`、`MICA_BENCH_WARMUP_TICKS`、`MICA_BENCH_ROUNDS` 调整轮长；默认每轮 2000 tick、预热 1000 tick、5 轮。以下是 Windows x64、Node v24.18.0 的一次本地运行，单位 μs/tick：

| 场景                           |   最佳 | 中位数 |
| ------------------------------ | -----: | -----: |
| 稳定，无电气失效               |   0.71 |   1.20 |
| 每 tick 修改电位器两支阻值     | 223.89 | 242.97 |
| GPIO 模拟电压改变，仅 RHS 更新 |  52.62 |  61.80 |
| 每 tick 切换理想触点           | 202.98 | 261.20 |

这些数字覆盖器件阶段、失效、当前稠密求解和批处理时钟，不含建图/JIT、RPC、UI、诊断 getter 或大规模网络。固定电路、缓存命中和持续调阻不是同一种负载；此结果不能推广为整机吞吐。当前独立分组和单节点闭式路径尚未实现，动态场景明显慢于缓存场景；此前算术微内核的 ns 数字不是这一基准的替代值。
