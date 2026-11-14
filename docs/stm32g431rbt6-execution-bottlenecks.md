# STM32G431RBT6 HAL 执行期瓶颈：等待循环、GPIO 服务与 shard 往返

- 日期：2026-11-14
- 快照：历史归因保留在第 1–14 节；2026-11-14 最新收口与性能读数见第 15 节
- 对象：`examples/ili9325/test/fixtures/HAL_06_LCD.bin`，裸 MCU、80 MHz、`execution: 'throughput'`
- 相关文档：
  - 重建成本：`docs/direct-jit-rebuild-cost.md`
  - 块结构：`docs/mcu-jit-block-inflation.md`
  - 缺陷与基准口径：`docs/stm32g431rbt6-issues.md`

第 1–14 节记录优化前的真实归因；第 15 节记录随后落地的优化与最终复测。四类读数必须分开理解：

1. **首次运行冷启动**：新进程第一次跑该固件；
2. **预热冷启动**：同一进程后续 board 的 0 → 200 µs；
3. **含重建稳态**：官方 200 µs → 220 ms 三轮最小值；
4. **无重建稳定窗口**：程序完整翻译后继续推进 220 ms。

把四者混用会得到互相矛盾的结论。

## 1. 结论摘要

1. **首次运行的秒级延迟不是生成代码执行慢**：首轮 direct 执行只占约 1.4%。主因是 411 个真实设备块的翻译、IR builder、校验、compiledBody 生成，以及 V8 首次优化和 GC。
2. **预热冷启动仍约 0.36 s**：411 个唯一 `Instruction.compile` 约 340 ms，25 次程序级源码组装约 107 ms。Instruction cache 只消除了重复块级发射，没有消除每 board/每 JIT 的首次发射和完整程序组装。
3. **无重建稳定窗口仍有约 2.2× 差距**。最大的单项不是重建，而是**逐轮执行 HAL_Delay/HAL_GetTick 忙等循环**。三个 guest 热块占 60.8% 的块入口、59.0% 的 state 读、56.4% 的 state 写。
4. **GPIO 服务是第二大头**。220 ms 内约 109 万次 GPIO 服务，集中在 GPIOB/GPIOC。变化位优化避免了无效引脚刷新，但端口快照、供电判定、pin intent 和电气 helper 仍占显著 CPU。
5. **shard/dispatcher 往返是第三大头**。约 529 万次 shard 调用只承载 697 万个块，平均 1.32 块/shard；dispatcher 占稳定窗口约 28–29%。
6. **稳定窗口粗略归因**：器件模型约 60–65%，通用 JIT/调度约 35–40%。两者都显著，不能只归因于其中一边。
7. **GC、fallback、boundary、电气求解、SysTick、USART、NVIC 不是稳定窗口主瓶颈**；`SERVICE_WRITE` 与 IDR 也基本可以排除。

## 2. 测量口径

| 维度         | 取值                                  |
| ------------ | ------------------------------------- |
| Node         | 24.20.0                               |
| 宿主         | 12th Gen Intel Core i7-12700K         |
| 固件         | `HAL_06_LCD.bin`                      |
| 频率         | 80 MHz                                |
| 板级         | 裸 MCU，只接 VDD/VSS                  |
| 执行模式     | `throughput`                          |
| 稳态宿主步长 | 10 ms                                 |
| profiler     | `node:inspector`，稳定窗口 25 µs 采样 |

稳定窗口 profile 前后：

```text
directCompiles  25 -> 25
directFallbacks 4702 -> 4702
cache=411, directPcs=411, directPrograms=1
```

因此稳定 profile 不包含新重建和新 fallback。

## 3. 性能窗口

### 3.1 当前基线

| 窗口                       |                    CPU |
| -------------------------- | ---------------------: |
| 首次运行 0 → 200 µs        |           约 6.6–7.2 s |
| 预热冷启动 0 → 200 µs      |          约 358–361 ms |
| 官方稳态 200 µs → 220 ms   |       约 1.007–1.013 s |
| 无重建稳定窗口，10 ms 切片 | 约 480–532 ms / 220 ms |
| 无重建稳定窗口，单次推进   | 约 303–346 ms / 220 ms |

无重建稳定窗口对应约 `0.46×` 实时（10 ms 切片）到 `0.73×` 实时（单次推进）。

### 3.2 切片差异

10 ms 切片会重复执行 `program.run` 的状态读入、dirty 位图清零、写回和 boundary，因此明显慢于单次推进。发布基准使用 10 ms 步长，应优先优化该口径。

## 4. 首次运行冷启动

首轮 CPU profile 的 active 样本为 4,619 个：

| 类别                        |  占 active |
| --------------------------- | ---------: |
| 设备块翻译、IR builder      | **59.04%** |
| direct JIT 编译             |     13.12% |
| compiledBody / body compile |     10.05% |
| GC                          |      9.59% |
| 其他                        |      5.65% |
| direct 执行                 |  **1.39%** |
| interpreter/runtime         |      0.91% |
| generated/V8 code           |      0.15% |
| board/runtime               |      0.11% |

首轮插桩成本：

| 阶段                              |          时间 |
| --------------------------------- | ------------: |
| 设备 `translate` / builder        | 约 5,168.6 ms |
| `validateBoundBlockIR`            |   约 549.7 ms |
| `body()` / compiledBody 生成      | 约 1,008.6 ms |
| direct JIT 编译                   | 约 1,295.2 ms |
| direct 执行，938 次 `program.run` |    约 45.4 ms |

V8 与 GC：

| 项目                     |        首轮 |
| ------------------------ | ----------: |
| `--trace-opt` 事件       |      489 次 |
| V8 reported optimization | 约 918.5 ms |
| GC 次数                  |      294 次 |
| GC pause                 | 约 451.8 ms |
| 最高观测 heap            |   约 618 MB |

首轮时间主要由以下链路组成：

```text
设备 Thumb 翻译
  → Builder IR / schema / validation
  → compiledBody
  → Direct JIT Instruction / shard / new Function
  → V8 分层编译与优化
  → GC
```

生成代码执行不是首轮瓶颈。

## 5. 预热冷启动

同一进程后续 board 会复用模块级设备块缓存和 compiledBody，但 Direct JIT 缓存是 per-JIT 的：

- `examples/stm32g431rbt6/src/devices/stm32g431rbt6/index.ts` 的模块级 `blockCache` 复用 `BlockIR`；
- `packages/simulator/src/runtime/execution.ts` 的 `compiledBodies` WeakMap 复用 compiled body；
- 每个新 JIT 仍创建新的 `directCache`。

预热冷启动约 0.36 s 的成本拆分：

| 项目                             |        时间 | 占 25 次程序构建 |
| -------------------------------- | ----------: | ---------------: |
| 411 个唯一 `Instruction.compile` | 约 339.5 ms |            76.0% |
| cache-hit 扫描                   |   约 1.6 ms |             0.4% |
| `shardProgram` 生成 shard 行     |  约 36.4 ms |             8.2% |
| source join                      |  约 51.2 ms |            11.5% |
| `new Function`                   |  约 13.2 ms |             3.0% |
| metadata / freeze                |   约 4.0 ms |             0.9% |
| factory 调用                     |  约 0.25 ms |            0.06% |

25 次程序构建累计拼接约 34.9 MB 源码，最终程序约 5.4 MB。

结论：per-JIT Instruction cache 避免了重复 `emit/compact/rewrite`，但没有避免：

- 每个新 board 重新编译 411 个 `Instruction`；
- 25 次完整程序源码和 shard 函数重建；
- V8 对新 shard 函数重新做 Maglev/TurboFan 优化。

## 6. 无重建稳定窗口

### 6.1 CPU profile

10 ms 切片：

| 函数/组                   |       占比 |
| ------------------------- | ---------: |
| `stepShardN` 合计         | **56.65%** |
| 生成 dispatcher `run`     | **29.37%** |
| `runDirect`               |      2.63% |
| `run` + `runDirect`       |     31.99% |
| GPIO/电气 helper 合计     |      8.66% |
| direct/data helper 合计   |      1.80% |
| GC                        |      0.53% |
| `resumeShardN`            |      0.02% |
| boundary/publish/电气求解 |   约 0.02% |

单次推进时 V8 会把 dispatcher 内联到 `runDirect`，因此函数名归因不同，但结构相同。

### 6.2 动态执行量

| 指标                   |          数量 |
| ---------------------- | ------------: |
| guest 指令             | 约 19,290,214 |
| block 入口             |  约 6,966,850 |
| guest block 入口       |  约 5,875,031 |
| service block 入口     |  约 1,091,819 |
| guest block 平均指令数 |          3.28 |
| `stepShardN` 调用      |  约 5,286,955 |
| 平均每 shard 执行块数  |          1.32 |
| `resumeShardN` 调用    |             0 |
| direct state 读        |   约 110.15 M |
| direct state 写        |    约 62.61 M |
| `load32`               |     约 4.89 M |
| `store32`              |     约 1.10 M |

## 7. 热点一：HAL_Delay/HAL_GetTick 忙等循环

### 7.1 热点 guest 块

| PC           |    块入口 | 占全部块入口 |   state 读 |   state 写 | 语义                  |
| ------------ | --------: | -----------: | ---------: | ---------: | --------------------- |
| `0x08000470` | 1,412,677 |       20.28% | 24,015,741 | 14,127,242 | `HAL_GetTick`         |
| `0x0800028C` | 1,412,668 |       20.28% |  9,888,908 |  5,651,144 | `HAL_Delay` 循环      |
| `0x08000290` | 1,412,668 |       20.28% | 31,079,158 | 15,539,812 | `HAL_Delay` 比较/跳转 |

三块合计：

- 60.8% 块入口；
- 59.0% state 读；
- 56.4% state 写；
- 相关 shard 在 CPU profile 中约占 23.3%。

反汇编路径：

```text
0x0800028c -> bl 0x08000470
0x08000290 -> subs/cmp/bcc 回到 0x0800028c
0x08000470 -> ldr/ldr/bx lr
```

### 7.2 根因

当前 `jit.delays` 为空。`delayLoops` 只识别 `subs #1 + bne` 自环，不能识别 HAL_Delay 的：

```text
读取 uwTick
  → 与目标时刻比较
  → 未到则跳回
```

同时，SysTick 由指令块驱动。如果直接跳过等待循环，`uwTick` 不会推进，HAL_Delay 会死锁。这形成闭环：

```text
执行 HAL_Delay 轮询
  → 推进 SysTick
  → 更新 uwTick
  → 再执行 HAL_Delay 轮询
```

这不是普通 JIT 代码生成问题，而是**空闲时间没有从执行模型中移除**。

## 8. 热点二：GPIO 服务与电气同步

### 8.1 服务次数

| 服务 PC   | 服务内容                |    次数 | 占 service 入口 |
| --------- | ----------------------- | ------: | --------------: |
| `0x20011` | GPIOB 写/同步           | 952,963 |           87.3% |
| `0x20012` | GPIOC 写/同步           | 136,623 |           12.5% |
| `0x20000` | SysTick/USART/中断 tick |   2,198 |           0.20% |
| `0x20010` | GPIOA 写/同步           |      16 |          0.001% |
| `0x20040` | 非 GPIO 延迟写          |      16 |          0.001% |
| `0x20030` | GPIO IDR 延迟读         |       3 |         0.0003% |

GPIO 服务合计约 109 万次，占全部块入口 15.6%，并伴随约 10.9 M state 读、4.36 M state 写。

### 8.2 成本结构

GPIO 服务仍需要：

- 读取并判定端口供电状态；
- 读取 MODER/OTYPER/PUPDR/AFR/ODR；
- 计算变化引脚；
- 构造 pin intent；
- 执行 resistor/sample/intent 等 host helper。

profile 中：

- GPIOB 服务 shard 约 11.2%；
- resistor/readSample/pin/intent 等 helper 合计约 8–9%。

变化位优化已经避免无效引脚刷新，但每次服务仍承担端口快照、供电判定和电气同步。

## 9. 热点三：shard/dispatcher 往返

- 约 5.29 M 次 shard 调用承载 6.97 M 个块；
- 平均 1.32 块/shard；
- dispatcher 占稳定窗口 28–29%；
- 大量 shard 执行一个块后返回 `"next"`，重新进入 dispatcher。

区间树 dispatcher 降低了线性比较成本，但没有改变 shard 只执行 1–2 个块就返回的结构。

## 10. 守卫密度

热点 guest 块的主要成本不是 ARM 语义本身，而是每条 guest 指令携带的通用守卫：

| 状态/守卫          |       动态量 |
| ------------------ | -----------: |
| `pc` 读            |   约 23.63 M |
| `pc` 写            |   约 27.05 M |
| `serviceMask` 读   |   约 17.25 M |
| `serviceMask` 写   |    约 2.18 M |
| `pendingPs` 读/写  | 各约 15.07 M |
| `halted` 读        |   约 16.16 M |
| `tickActive` 读    |    约 4.79 M |
| `tickPs` 读        |    约 4.79 M |
| `running` 条件检查 |   约 17.47 M |

约 90.6% 的 guest 指令执行前都要经过 `running` 守卫。

相关代码：

- `examples/stm32g431rbt6/src/devices/stm32g431rbt6/index.ts` 的 `collectBatch`；
- `index.ts` 的批处理发射和服务判定；
- `index.ts` 的 `tick` 快路径。

## 11. 明确排除的非瓶颈

稳定窗口：

- fallback 与程序重建均不增长；
- GC 仅约 0.1–0.5%；
- `resumeShardN` 动态调用为 0；
- boundary/publish/电气求解低于 0.1%；
- SysTick 服务约 2,198 次；
- USART 没有独立高频服务块；
- NVIC 只有千级到万级操作；
- PWR/RCC 不在稳定窗口高频路径；
- `SERVICE_WRITE` 16 次；
- `SERVICE_READ` 3 次；
- `SERVICE_SYNC` 0 次。

## 12. 优化优先级

### P0：让 HAL_Delay 的空闲时间可跳过

需要把 SysTick 改成时间驱动事件，或提供等价的运行时时间事件，再让 HAL_Delay 的 `uwTick` 等待循环使用 `polling` / `waitUntil` / 扩展的 `delayLoops` 语义。

必须同时保持：

- SysTick 中断取走时刻；
- `uwTick` 更新；
- 终点规则；
- 中断屏蔽与等待唤醒；
- 不把未执行的等待周期误报为有效计算吞吐。

这是当前稳定窗口最关键的结构性优化。

### P0：shard 常驻与程序级增量组装

需要让已生成的 `stepShardN` 长期存活，新增块只生成新 shard，不重新拼接完整程序。否则：

- 每 board 仍重新发射 411 个 Instruction；
- 25 次重建仍重新生成完整源码；
- V8 仍需重新优化新 shard 函数。

### P1：GPIO 服务进一步合并

可选方向：

- 缓存端口寄存器快照，按版本失效；
- 合并同一时间窗内的多次 GPIO 写；
- 将 pin intent 构造延迟到电气边界；
- 避免每次服务重复执行完整供电判定和六组配置读取。

### P1：减少 1.32 块/shard 的往返

需要改变 shard 边界或跨 shard 直接续接，而不是继续只优化 dispatcher 比较树。

## 13. 总体归因

稳定窗口剩余的约 2.2× 差距：

| 来源                                        | 粗略占比 |
| ------------------------------------------- | -------: |
| 器件生成代码、等待链、GPIO/电气路径         |   60–65% |
| 通用 JIT dispatcher、shard 往返、frame 同步 |   35–40% |

最重要的单一结论：

> **当前模拟器在逐条执行 1,900 万条 guest 指令来等待时间流逝，而不是把空闲时间推进掉。**

不改变等待循环与 SysTick 的驱动方式，只继续优化 JS codegen，无法让当前 HAL 接近 80 MHz 实时。

## 14. 复现与注意项

- profile 使用 `Profiler.setSamplingInterval({ interval: 25 })`，单位是微秒；
- profiler 自身会增加耗时，CPU 份额按 self samples 计算，不把 profile 墙钟当真实 CPU；
- 首轮 `process.cpuUsage` 会累计 V8 并发编译线程，首轮 CPU 时间可能高于墙钟；
- 稳定窗口必须确认 `directCompiles` 和 `directFallbacks` 不再增长；
- 插桩会显著改变绝对耗时，动态计数只用于解释路径，不用于性能份额；
- 当前精确读数随 V8、宿主和代码版本变化，以基准 stdout 为准。

## 15. 已落地优化与复测

2026-11-14 落地了等待循环和通用 JIT 调度两项结构性优化：

1. **SysTick 时间事件轮询**：`JitOptions.polling` 增加 `consume` 与
   `wait: { delay, advance }`。设备模型识别
   `bl HAL_GetTick; subs; cmp; bcc` 的 HAL_Delay 形态，在轮询入口等待到 SysTick 边界；
   `advance` 更新 SysTick、设置 pending 并按 PRIMASK 决定是否转入 `SERVICE_TICK`。
   一轮中断返回后 `consume` 放行一次轮询，使终点判断立即完成。精确模式仍逐指令执行；
   USART 活跃或 SysTick 未使能时回到逐指令服务路径。
2. **shard 常驻与增量 dispatcher**：已封闭 `stepShardN` / `resumeShardN` 作为函数对象跨程序
   修订复用，新块主要只影响开放尾 shard。每次程序修订只生成小型 PC switch dispatcher；
   continuation ID 在 cache 内稳定，跨 shard 的下一 PC 在同一个 `run` 循环内续接。
3. **批级守卫削减**：一个指令批的 `pendingPs` 先保存在局部槽，只在批尾或真正进入服务块时
   写回；停机路径通过把 `pc` 留在故障指令来停止后续批次，不再逐条读取 `halted`。

复测口径与第 2 节相同（Node 24.20.0、HAL_06_LCD、80 MHz、throughput、10 ms 切片、三进程）：

| 指标                 |  优化前 |         优化后 |
| -------------------- | ------: | -------------: |
| 0 → 200 µs 冷启动    |  398 ms | **361–365 ms** |
| 200 µs → 220 ms 稳态 | 1056 ms | **605–630 ms** |
| 稳态实时倍率         |   0.21× | **0.35–0.36×** |
| 整段 220 ms          | 1454 ms | **967–995 ms** |
| `directCompiles`     |      25 |         **21** |
| `directFallbacks`    |    4702 |       **5041** |

这轮复测确认时间等待不再是主要执行路径：HAL_Delay 只在每个 SysTick 边界进入服务块，
而不是逐轮执行上百万次 guest 块。剩余稳定窗口的主要成本转移到 GPIO 服务与器件生成代码。

GPIO 侧验证了若干结构候选，包括供电状态事件缓存、输出/配置服务拆分、惰性配置读和组掩码
路由。供电缓存能把 `sample('VDD1')` 从 220 ms 内约 54.5 万次降到 0。完整事件实现带来额外的
初始化服务、反应链和状态开销，HAL 稳态中位数由约 608 ms 变为 645 ms；去掉额外状态的精简版
交替 A/B 为 603/614 ms，对照基线为 614/612 ms，仍没有稳定收益。两版都没有保留生产改动，
相关语义边界保留为 `test/gpio-sync.test.ts` 回归。下一步收益更大的方向仍是合并连续 GPIO
写、按输出/配置拆分服务入口，或在电气边界延迟 pin intent 构造。

### 15.1 并行优化集成快照（GPIO service 路径仍频繁执行）

三路并行分支最初把连续 GPIO 写合并进更大的基本块，得到过：

| 指标                       |   中间快照 |
| -------------------------- | ---------: |
| 0 → 200 µs 冷启动          | 300–316 ms |
| 200 µs → 220 ms 官方稳态   | 461–498 ms |
| 220 ms → 440 ms 无重建窗口 | 230–255 ms |
| resident shard             |         76 |
| 全部块入口                 |  1,918,086 |
| GPIOB service              |    544,814 |

这组读数是有效正确性口径：多数 GPIO 写仍经过 service 块，因此电气边界能看到 GPIO 变化。

之后进一步尝试把连续写全部内联并合块，曾得到 280 blocks / 70 shards、419,367 次入口和约
304–318 / 116–140 ms 的稳态/无重建读数，但真实 ILI9325 联合测试失败：多个 WR 低→高脉冲
落在同一个基本块，宿主只能在块尾求解，`R02h` 等初始化寄存器保持 0。该结果不可采用。

### 15.2 边沿正确性收口

最终方案把“能否内联”和“是否要收块”拆成两个独立事实：

1. `canInlineStaticGpioWrite` 只判断静态 BSRR/BRR 写能否在 Guest 块内完成 ODR 与 intent；
2. `inlineStaticGpioWriteChangesPin` 判断该写是否可能改变引脚。若会，解码结果里的
   `boundaryAfter` 为 true，`decode` 在指令后收块；
3. 收块仍走内联 intent，不重新进入 GPIO service。每个有效写之后，宿主电气 boundary 能看到
   完整电平，ILI9325 的 WR 上升沿可以锁存数据；
4. `register-facts` 明确区分“控制流结束”和“仅为 GPIO 边沿收块”，后者仍继续传播
   `r0/r1/r2` 等线性常量，避免后续静态写退化成 service 路径。

该收口还必须修正测试夹具：旧探针只保留每个同步批的最后一条消息，会把同一批内的边沿吞掉。
现在测试历史记录同批全部变化，并新增 `BSRR set → BRR clear` 的 `PA5: [2,0,1,0]` 回归断言。

### 15.3 最终三进程复测

Node 24.20.0、HAL_06_LCD、80 MHz、throughput、10 ms 切片；每个进程内部三轮取 CPU 最小值：

| 指标                       | 最终读数（三次）      | 最好值 |
| -------------------------- | --------------------- | -----: |
| 0 → 200 µs 冷启动          | 243 / 239 / 236 ms    |    236 |
| 200 µs → 220 ms 官方稳态   | 415 / 431 / 433 ms    |    415 |
| 220 ms → 440 ms 无重建窗口 | 161 / 179 / 176 ms    |    161 |
| 0 → 220 ms 合计            | 658 / 670 / 669 ms    |    658 |
| 官方稳态实时倍率           | 0.53× / 0.51× / 0.51× |  0.53× |
| 无重建实时倍率             | 1.36× / 1.23× / 1.25× |  1.36× |

最终 Direct JIT：`programs=1`、`blocks=311`、`shards=71`、`compiles=21`、
`calls=5382`、`fallbacks=2873`；220 → 440 ms 新增编译/fallback 均为 0。

220 ms → 440 ms 动态入口：

| 指标             |          数值 |
| ---------------- | ------------: |
| 全部块入口       | **1,372,502** |
| GPIOB service    |        **54** |
| GPIOC service    |       **892** |
| tick service     |         2,204 |
| 8 个 GPIO 边沿块 |  各约 135,999 |

相对 `96e0305` 有效旧基线，最好值从 378 / 1109 / 346 ms 降到 236 / 415 / 161 ms；官方稳态
实时倍率从 0.20× 提升到 0.53×，无重建倍率从 0.64× 提升到 1.36×。完整 CPU 归因、生成代码
大小和动态热点见 `docs/stm32g431rbt6-steady-state-bottlenecks.md`。
