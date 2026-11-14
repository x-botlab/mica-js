# 直接后端重建成本：冷启动与稳态的共同瓶颈

- 日期：2026-11-14
- 范围：`packages/compiler/src/direct-jit.ts`、`packages/simulator/src/runtime/jit.ts`
- 复现对象：`examples/ili9325/test/fixtures/HAL_06_LCD.bin`（裸 MCU、80 MHz、`execution: 'throughput'`）
- 关联文档：缺陷与口径见 `docs/stm32g431rbt6-issues.md`，块结构见 `docs/mcu-jit-block-inflation.md`，
  执行期深挖见 `docs/stm32g431rbt6-execution-bottlenecks.md`

本文记录对**重建开销**的定位结论与实测数据。前 7 节保留优化前的归因快照；第 8 节记录
shard 常驻与增量 dispatcher 的落地设计和最终读数。2.2、2.3、2.5 三节修正了
`docs/stm32g431rbt6-issues.md` 中已被测量推翻的三处结论，其余读数不重复维护。

> 2026-11-14 复核（增量缓存、区间树 dispatcher、GPIO 服务优化已实现）：当前发射规模为
> **411 个可编译块、310,231 个含嵌套 IR 操作、186,350 条语句、约 5.4 MB 生成源码**。
> 旧稿中的 353 / 273,233 / 164,076 快照已移除。精确性能读数随 V8、宿主和代码版本变化，
> 以 `bench/hal-throughput.test.ts` 的输出为准。

## 1. 结论摘要

1. **完整程序组装曾是最主要单项，块级发射已先被复用**：按 PC 缓存 `Instruction` 后，
   重复修订不再重新执行 `emit/compact/rewrite`；后续常驻 shard 又消除了完整源码重拼。
2. **重建贵在发射器自身，不在 V8 解析**：CPU 采样里发射相关函数约占 80%，V8 编译生成源码不到 2%。
3. **单次全量发射仍与总块数线性相关**：约 1.05 ms/块，411 块约 448 ms；缓存消除的是重复部分。
4. **发布读数是三轮最小值**，首次运行（用户第一次跑）冷启动约 6.6–7.2 s，是发布读数的约 18–20 倍。
5. 次要瓶颈：每次 `program.run` 有约 3–7 µs 的固定成本（约 82 个 state 全量读入、dirty 位图清零、
   约 83 个写回槽逐个检查），只在宿主步长极小时才显著。
6. 体积问题要分开看：`SERVICE_WRITE` / IDR 的大块主要影响首次翻译；GPIO 写服务在稳态也高频执行，
   已完成变化引脚掩码与分组刷新优化，但仍是模型热路径。

## 2. 测量口径

| 维度      | 取值                                                                |
| --------- | ------------------------------------------------------------------- |
| 运行时    | Node 24.20.0（`~/.nvm/versions/node/v24.20.0`），vitest 5.0.5       |
| 入口      | `examples/stm32g431rbt6/bench/hal-throughput.test.ts`               |
| 计时      | `process.cpuUsage`，三轮取最小值                                    |
| 稳态步长  | 宿主 10 ms（`hal-bench.ts` 的 `10 * PS_PER_MS`）                    |
| profiling | `node:inspector` 的 `Profiler`，冷启动 100 µs 采样、稳态 20 µs 采样 |

宿主步长会显著改变读数，本文所有对照都标明步长；跨步长的数字不可直接比较。

## 3. 基线复现

| 指标                 | 最终观测      |
| -------------------- | ------------- |
| 冷启动 0 → 200 µs    | 约 361–365 ms |
| 稳态 200 µs → 220 ms | 约 605–630 ms |
| 整段                 | 约 967–995 ms |
| 缓存块 / 直接程序    | 411 / 1       |
| 程序修订次数 / 回退  | 21 / 5041     |

优化前同一口径约为冷启动 1.02–1.07 s、稳态 2.74–2.85 s；增量缓存先把发布读数推进到约
0.36 s / 1.01 s，常驻 shard 与时间事件轮询再把稳态推进到约 0.61–0.63 s。上表保留最终范围，
不维护易漂移的单次精确值。

## 4. 瓶颈一：整程序重建（优化前快照）

以下 4.1–4.5 描述增量 Instruction 缓存已经存在、shard 尚未常驻时的实现。当时
`runDirect` 在「当前程序未覆盖目标 PC」或「攒够 stride」时调用 `compileDirectJit`，
`compileDirectJit` 会遍历全部块重新发射；第 8 节记录后续修复。
`jit.ts:29-33` 的 `DIRECT_REBUILD_LINEAR_LIMIT` / `DIRECT_REBUILD_MIN_BLOCKS` /
`DIRECT_REBUILD_PATIENCE` 控制的只是触发时机。

### 4.1 冷启动 CPU 采样（历史快照，5684 个样本）

| 占比     | 函数                                               | 位置                         | 性质           |
| -------- | -------------------------------------------------- | ---------------------------- | -------------- |
| 16.4%    | `rewrite`（正则把 `vN` 换成物理槽）                | `direct-jit.ts:821` 内部     | 发射           |
| 9.9%     | GC                                                 | ——                           | 发射的分配压力 |
| 9.0%     | `compact`（活跃区间扫描）                          | `direct-jit.ts:821`          | 发射           |
| 8.7%     | `names`（逐行正则提取 `vN`）                       | `direct-jit.ts:824`          | 发射           |
| 8.1%     | 槽分配遍历                                         | `direct-jit.ts:821` 内部     | 发射           |
| 8.1%     | `operation`                                        | `direct-jit.ts` 的 IR 访问器 | 发射           |
| 8.1%     | 行遍历 / 收集                                      | `direct-jit.ts:821` 内部     | 发射           |
| 6.8%     | `Instruction.compile`                              | `direct-jit.ts`              | 发射           |
| 3.6%     | `region`                                           | `direct-jit.ts` 的 IR 访问器 | 发射           |
| 3.0%     | `compileDirectJit`                                 | `direct-jit.ts:174`          | 发射           |
| 2.3%     | `countOperations`                                  | `direct-jit.ts`              | 发射           |
| **1.7%** | **V8 编译生成源码**（`(program)`、`compiledBody`） | ——                           | 解析           |

发射器合计约 **80%**，GC 9.9%（主要来自逐块生成字符串与 Map），V8 解析 1.7%。
`stm32g431rbt6-issues.md` 2.3 把原因归给「让 V8 重新解析全部已编译块」，与采样不符：
**重建的成本在生成源码这一侧，不在解析那一侧。**

`compact` 的内部实现值得单列：它对每个块把 `prefix + suffix` 全部行做两遍正则
（`line.match(/\bv\d+\b/g)` 与 `line.replace(/\bv(\d+)\b/g, ...)`），并用 `Map<number, ...>`
记录每个虚拟槽的定义/首次使用/末次使用。当前 411 个可编译块共发射 186,350 条语句，
每次重建都要把这些语句重新正则扫一遍。

### 4.2 当前发射规模

2026-11-14 复核的当前程序（`profileInstructions`）为：

| 指标                        | 当前值          |
| --------------------------- | --------------- |
| 可编译块                    | 411             |
| IR 操作 / 含嵌套 IR 操作    | 6,560 / 310,231 |
| 发射语句                    | 186,350         |
| 生成源码                    | 约 5.4 MB       |
| `stepShard` / `resumeShard` | 146 / 141       |

旧稿保留的逐点编译曲线已删除，因为它同时混用了旧源码规模和旧 V8 状态。重建仍随总块数线性增长；
当前单次整程序发射约 1.05 ms/块，411 块约 448 ms，这一量级与当前实现相符。

### 4.3 稳态归因（10 ms 步长，常驻 shard 前快照）

2026-11-14 常驻 shard 落地前复测：官方稳态窗口约 1.01 s。程序完整翻译后继续推进 220 ms：

| 宿主步长    | CPU      | 实时倍率 |
| ----------- | -------- | -------- |
| 10 ms       | 480.2 ms | 0.458×   |
| 220 ms 单步 | 302.5 ms | 0.727×   |

这是常驻 shard 落地前的剖面，程序级组装当时约占稳态的一半。最终方案只重建小型 dispatcher
和受影响的开放尾 shard，最终发布稳态降到约 605–630 ms。

### 4.4 首次运行与发布读数

当前首次运行仍约 **6.6–7.2 s**，官方发布读数是三轮最小值，约 **0.36 s**；两者差异来自 V8
对发射器、生成 shard 和 dispatch 函数的分层优化。该差额尚未拆分到具体编译阶段。

这也意味着用户第一次运行看到的仍是秒级冷启动，不能把 0.36 s 的发布读数当成首次用户体验。

### 4.5 `stride` 为什么没有解决问题

`jit.ts:262-268` 的 stride 在块数超过 16 后取 `max(64, 已编译块数)`，所以每次修订要等新增
64 个块以上（大程序更久）。这把修订次数从「每块一次」（43 次 / 1.67 s）压到 21 次；在 shard
常驻前，每次修订仍重拼全部函数，常驻后只影响开放尾 shard 与 dispatcher。

实测块数增长与重建次数（冷启动窗口 0 → 200 µs，5 µs 步进）：

| 推进到   | 累计 CPU | 重建数 | 块数 |
| -------- | -------- | ------ | ---- |
| 5 µs     | 180 ms   | 16     | 17   |
| 25 µs    | 271 ms   | 17     | 159  |
| 50 µs    | 1,326 ms | 21     | 192  |
| 85 µs    | 2,429 ms | 25     | 228  |
| 155 µs   | 2,785 ms | 26     | 273  |
| 115.3 ms | 8,139 ms | 37     | 411  |

（该组用 5 µs 步进，比发布口径更细，累计 CPU 偏高；块数与重建数的对应关系仍可比。）

## 5. 瓶颈二：每次 `program.run` 的固定成本

`jit.ts:388-391` 在每次 `run` 前做两件全量工作：把程序声明读过的 **约 82 个 state**逐个
`instance.states.get(name)` 写进 frame 数组，并把 `stateDirty` / `memoryDirty` 位图清零；
`jit.ts:402-410` 在 `finally` 里逐个检查 **约 83 个写回槽**的 dirty 位。

在 411 块全部翻译完成后推进同样 220 ms（无重建、无回退）：

| 宿主步长        | CPU                  | `program.run` 次数 |
| --------------- | -------------------- | ------------------ |
| 单次推进 220 ms | 877 ms（含一次重建） | 2                  |
| 100 ns          | 14,435 ms            | 4.40 M             |
| 10 ns           | 37,632 ms            | 11.76 M            |
| 1 ns            | 77,832 ms            | 11.76 M            |

折合约 **3–7 µs / 次 `run`**。发布基线用 10 ms 步长，因此读数没有被这项污染；但逐步调试、
逐帧推进、外部事件密集的板上，这项会放大一到两个数量级。

## 6. 瓶颈三：回退与生成代码热路径

- 稳态 `directFallbacks` 约 2,265 次（总计 4,702）。每次回退是「直接尝试 → 解释器派发 → 再入队」；
  但程序完整后回退归零，回退路径只占约 3% 的动态块执行，属于懒翻译滞后的症状，不是最大单项。
- 优化前稳定窗口的 CPU 采样：`stepShardN` 约 51.7%，`run` dispatcher 约 27.8%，
  runtime/boundary/electrical 约 11.2%，direct helper 约 7.3%。区间树 dispatcher 已把线性
  146 路路由改为平衡树，稳定窗口约再提升 5%。
- 220 ms 内约执行 109 万次服务块，其中 GPIOB 写服务约 95.3 万次。GPIO 服务已改为按实际变化
  引脚生成精确掩码并分组刷新，稳态约提升 11%，但仍是模型热路径。
- `SERVICE_WRITE` / IDR 的大块主要影响冷启动：同一窗口内 `SERVICE_WRITE` 约 32 次、IDR 约 3 次。

## 7. 与 `stm32g431rbt6-issues.md` 的三处偏差

| 节  | 旧稿结论                                | 当前结论                                                                |
| --- | --------------------------------------- | ----------------------------------------------------------------------- |
| 2.3 | 重建让「V8 重新解析全部已编译块」       | V8 解析约 1.7%；发射器约 80%                                            |
| 2.5 | 第 1 项之外只影响冷启动，稳态无可测收益 | 程序级重建仍占稳态约一半；GPIO 服务与 shard/dispatcher 也有独立稳态成本 |
| 2.2 | 稳态 0.08× 实时                         | 时间事件轮询与常驻 shard 后官方稳态约 0.35–0.36×，仍不是 1×             |

## 8. 修复接缝与预期收益

`Instruction`（`direct-jit.ts` 的 `class Instruction`）是 per-PC 的纯编译结果，只依赖
块 IR 与 binding；`stepShardN` 已经是独立顶层函数（`shardProgram`，`direct-jit.ts:459`）。

**已实现：按 PC 缓存 `Instruction`。** `compileDirectJit.createCache()` 持有已编译块和稳定的
常量索引；重建时只编译新增/失效块，再拼装 shard。代码内存失效会清空指令缓存，旧程序因持有
独立常量快照仍可安全完成。三条约束已由实现和测试覆盖：

1. **常量索引要跨重建稳定**。`literal()` 走 `capture()` 向共享的 `constants` 数组**追加**，
   `C[i]` 是数组下标；复用旧 `Instruction` 时若换用新数组，索引会错位。缓存必须连同常量表一起
   持有，或在拼装时给每块常量表加偏移。
2. **`delayLoops` 会改变 `guard`**。它参与程序缓存 key（`runDirect` 里的 `JSON.stringify`），
   所以延时环集合变化时，命中缓存的块也要重发 `guard`。
3. **binding 的索引在 revision 内必须稳定**。state/memory 名字来自 `instance.states.keys()`，
   只增不改，已有下标不会移动，因此同一 revision 内可以跨重建复用。

**已实现：稳定热路径。** frame 预构造 `DataView`，宽访存不再走 WeakMap；state/memory 布局在
JIT 生命周期内复用；`runDirect` 用缓存的 slot 数组回填；shard dispatcher 在 16 路以上改为
平衡区间树，保留直接函数调用与原有 fallback/continuation 边界。

**已实现：shard 常驻与增量 dispatcher。** direct cache 持有已生成的 `stepShardN` /
`resumeShardN` 函数对象；已封闭 shard 在后续程序修订中直接复用，只重发开放尾 shard。每个程序
修订只生成一个精确 PC switch dispatcher，跨 shard 的下一 PC 在同一个 `run` 循环内续接。
continuation ID 改为 cache 内稳定的 `resumeId`，常量表和旧程序保持自包含。

**实测收益。** 同一 HAL_06_LCD 运行中，旧路径累计生成约 13.5 MB 程序源码；常驻路径生成
约 5.06 MB shard 源码和 56.3 KB dispatcher 源码，生成量减少约 62%。200 万次跨 shard 交替
微基准约从 13.0–13.2 ms 降到 9.1–9.5 ms（提升约 28–30%）。最终 HAL 发布口径为
`coldMs=361–365`、`steadyMs=605–630`、`directCompiles=21`，相对旧基线稳态下降约 40–43%。

**边界**：首次运行的设备 Thumb 翻译、IR builder、校验、compiledBody 生成以及 V8 首次优化
仍在 `0 → 200 µs` 冷启动中占主导，当前约 0.36 s。常驻 shard 适合消除重复程序组装，无法替代
首次设备块翻译。

## 9. 复现方式与未验证项

本次分析用的临时脚本（`bench/_profile.test.ts`、`_attrib.test.ts`、`_curve.test.ts`）在取数后
已删除，未入库。复现需要四件事，全部只用公开接口或包内导出：

1. **基线**：`vitest run --config vitest.perf.config.ts bench/hal-throughput.test.ts`。
2. **重建成本曲线**：从 `board.jits[0].cache` 取块，直接调 `compileDirectJit`，按当前缓存块数的多个前缀
   （如 17/48/77/159/273/411）取样，`process.cpuUsage` 计时、三轮取最小。
3. **稳态归因**：先跑到 200 µs 与 220 ms 完成全部翻译，再按 10 ms 步长推进，逐段记录
   `directStats.directCompiles` 与 `process.cpuUsage`。
4. **CPU 采样**：`node:inspector/promises` 的 `Profiler.start/stop`，冷启动用 100 µs、稳态用 20 µs
   采样间隔，按 `hitCount` 汇总 `callFrame.functionName`。

未验证项：

- 4.4 中首次运行的 6 s 差额没有拆分到「发射器分层优化」与「器件代码首次编译」。
- 稳态归因已按 10 ms 与 220 ms 两种步长复核；两者差异主要来自每次 `program.run` 的固定成本。
- 第 8 节列出的增量 Instruction 缓存、frame DataView、稳定布局、区间树 dispatcher 和
  shard 常驻均已实现。
