# STM32G431RBT6 + ILI9325 联合路径瓶颈调查

- 调查日期：2026-11-14
- 调查代码基线：`297b03f`；第 1–7 节记录修复前调查，第 8 节记录引擎修复，第 9 节记录器件优化
- 环境：Linux x64、Node.js 24.20.0、Vitest 5.0.5
- 固件与板级连接：沿用 `test/joint-harness.ts`，80 MHz、200 µs 量子、0 → 440 ms
- 诊断入口：`examples/ili9325/bench/joint-diagnosis.test.ts`
- 调查分工：STM32 执行路径、ILI9325 接收路径分别交给 DeepSeek V4.1 Flash 1017
  （opencodego）子代理，主线程完成动态对账与 CPU 采样，另一次子代理调用独立复核探针。

当前状态：电气发布边界、常驻状态银行、脏位写回、编译扫描及 MCU/LCD 热路径优化已实现，
并通过真实固件的发出/接收对账和独立图像 oracle。当前正式读数与剩余瓶颈见第 9 节。

## 1. 结论

**原联合基准漏掉了绝大多数 WR 边沿，其实时倍率不能代表边沿完整的联合仿真吞吐。**

0 → 440 ms 内，MCU 发出了 **272,007 次 GRAM 写周期**，LCD 实际只执行了 **136 次像素
存储**。原报告的 132 个发布像素、135 个非零像素是漏锁存的症状，“固件只绘制稀疏窄条”
不能解释这些读数。

根因在 MCU 与 LCD 之间的发布边界：**结束一个翻译块，并不保证 Direct JIT 返回宿主执行
电气求解**。WR、CS、RS 与数据的多次 intent 更新会在同一次 direct 调用中被覆盖，LCD
只看到调用返回时的最终采样。

恢复每个改变 intent 的翻译块结束后的宿主返回后，同一工作负载的写次数完整对齐；其主要成本
变成 Direct 状态银行同步/调度和边界处理。预热板的启动窗口则仍主要受 Direct 编译限制。

## 2. 决定性实验：发出量与接收量独立对账

诊断基准复用真实联合板，不替换两个器件。分两种模式：

- `baseline`：保持原执行路径，仅在 MCU `host.intent` 外围计数。
- `yield-on-intent`：实际改变 intent 时置当前 direct frame 的 `stopAfterInstruction`，
  令当前翻译块完成后返回，再执行原有状态写回、`boundary()` 与重排队。

MCU 侧按 PB5 的 intent 记录 WR 低→高，按 PB9/CS 与 PB8/RS 判断有效命令/数据周期，读取
PC0–PC15 的 intent 解码命令 `0x22`。LCD 侧独立读取 WR sample slot 的 version 与 GRAM
memory slot 的 version。本次 RST 接 VDD，启动没有 GRAM 清零，GRAM version 可用于统计
实际像素 store 次数。该计数不向模型添加观察者，不改变 Direct 的 state/memory guards。

两种模式在三个检查点的 MCU intent、WR 上升沿与 `0x22` 写计数完全一致：

| 440 ms 时的累计指标        |  baseline | yield-on-intent |
| -------------------------- | --------: | --------------: |
| MCU intent 调用            | 1,091,826 |       1,091,826 |
| MCU WR 电平变化            |   545,004 |         545,004 |
| MCU CS 有效的 WR 上升沿    |   272,502 |         272,502 |
| MCU `0x22` 数据写周期      |   272,007 |         272,007 |
| LCD WR sample 变化         |       482 |         545,004 |
| LCD GRAM store             |       136 |         272,007 |
| 最终 GRAM 非零像素         |       135 |          76,800 |
| 累计发布脏矩形面积（像素） |       132 |         436,480 |
| 发布帧数                   |        10 |              10 |
| 宿主 boundary 调用         |    15,937 |       1,101,894 |
| Direct 调用                |     6,783 |       1,095,045 |

原路径只完成发出 GRAM 写周期的 **约 0.05%**。后段 220 → 440 ms 尤为明显：发出 135,999 次
GRAM 写，只新增 **42 次 store**、**104 次 WR sample 变化**；该窗口没有新增 Direct 编译或
fallback，因此不能用“还没预热好”解释漏写。

0 → 200 µs 时两种模式均为 72 次 WR 变化、72 次 LCD sample 变化。初始化路径的频繁
fallback 保留了边界；热循环被 direct 覆盖后，缺口才明显扩大。

`yield-on-intent` 的测试断言要求 WR sample 变化等于 MCU WR 变化、GRAM store 等于
`0x22` 数据写次数、最终非零像素等于 76,800。原路径同时复现原报告的帧数、面积、非零
像素、22 次编译、72 shards、6,783 次调用与 2,720 次 fallback。

## 3. 根因调用链与代码位置

1. MCU 内联写（`examples/stm32g431rbt6/src/devices/stm32g431rbt6/core/gpio.ts:886`）
   更新 ODR 影子、periph 映像与 pin intent。
2. 器件 `core/gpio.ts:603`、`core/memory.ts:169`、`core/decode.ts:193` 与 `index.ts:716`
   用 `boundaryAfter` / `endsBatch` 在可能改变引脚的写后收块。
3. `packages/compiler/src/direct-jit.ts:1033`、`:1115` 的 resident shard/dispatcher
   继续到下一 PC，收块本身不会调用电气 boundary。
4. `packages/simulator/src/runtime/instance.ts:197` 只替换 `target.intent` 并标记 dirty
   slot，不保存电平历史。
5. `packages/simulator/src/runtime/jit.ts:431`、`:452` 在 `program.run` 返回后才调用一次
   `board.boundary()`。
6. `packages/simulator/src/runtime.ts:540`、`:701` 求解最终 intent、发布 sample、捕获变化，
   再执行 reaction。
7. `examples/ili9325/src/devices/ili9325/model.ddl:414` 的 LCD reaction 在 WR sample
   低→高且 CS 有效时，读取当前 RS 与 16 位数据总线。

因此，单纯设置 `boundaryAfter` 只解决“同一翻译块内合并脉冲”，没有解决“同一 direct 调用
内跨块合并脉冲”。state/memory 的 Direct observer guards 也不覆盖 pin intent 的中间
电气可见性。

LCD 本体的 `writePixel`（`model.ddl:220`）对每次窗口内写无条件 store、markDirty、推进
地址；相同颜色也会标脏。对照中 272,007 次写与 store 完全对齐，排除了它是本次巨大缺口的
主要来源。原路径的 LCD 地址最后停在 `(136, 0)`，对照为 `(128, 313)`，漏写同时破坏了
地址推进，135 个像素也不能视作参考图像的正确子集。

## 4. CPU 热点：必须按窗口和边沿完整性区分

用 `node:inspector` 以 100 µs 采样，按样本调用栈归组；百分比是采样线程的样本份额，不能
直接乘进程 CPU 时间得到各项耗时。计数和 profile 分开跑。

### 4.1 修复前原路径

- 预热板 0 → 200 µs：Direct 编译 70.2%、GC 5.7%。主体为 Instruction 发射、
  `compact`/`rewrite`、resident shard 构建与函数编译。
- 200 µs → 220 ms：Direct 编译 23.4%、shard 及 helper 33.9%、Direct bridge/dispatcher
  31.9%。此段混合翻译覆盖增长与执行，不能叫纯稳态。
- 220 → 440 ms：shard 及 helper 62.1%、Direct bridge/dispatcher 30.8%、boundary 2.4%。
  此段无新编译，但绝大多数 LCD 写未到达。

profile 的预热板已复用前一板跑完整固件后的模块级 Thumb/IR 缓存，计时不含建板。它不代表
新进程首次翻译成本；本次首板 0 → 200 µs 的计数运行耗费约 4.29 s 进程 CPU。

设备的模块级 `blockCache`、运行时 `compiledBodies` 可跨板复用；Direct 编译缓存位于每个
JIT（`runtime/jit.ts:366`），新板仍要发射自己的 Instruction/shard。因此预热建板仍有数百
毫秒启动成本，不能把它归给 LCD 每像素运算。

### 4.2 边沿数量完整的诊断对照

后段 220 → 440 ms 的 14,157 个样本：

| 类别                                                    | 样本份额 |
| ------------------------------------------------------- | -------: |
| Direct bridge、状态银行同步与 dispatcher                |   49.52% |
| LCD reaction body 及其调用的 state/memory/sample helper |   16.95% |
| boundary 的观察、反应排队与其他处理                     |    9.72% |
| boundary 下的电气求解                                   |    6.62% |
| Direct shard 及其 helper                                |    5.84% |
| GC                                                      |    1.25% |
| 其他                                                    |   10.09% |

Direct 组里 `runDirect` 自身 self samples 约 **42%**。源码每次进入要从 Map 读入当前
程序的 **87 个 state**，返回时扫描 **86 个 state 写槽、4 个 memory 写槽**，再按 dirty
位逐项写回（`runtime/jit.ts:419–446`）。对照有约 **109.5 万次 Direct 调用**，这种
“小块执行一次、同步全程序银行一次”的成本远大于 LCD 的一次 `store16le`。

boundary 合计约 **33.29%**，其中包含电气网络、观察、LCD 总线采样、寄存器/GRAM 写入与
脏矩形维护。这些工作在原路径中被少处理了，原路径很低的 boundary 占比不能证明完整联合
仿真中它们不重要。

诊断计数运行的后段 CPU 约为原路径 326 ms、对照 2,314 ms；带 profiler 的读数约为
245 ms、2,508 ms。它们只说明代价的数量级：固定顺序、插桩、profiler 和调度策略都影响
绝对时间，**不能用它们给正式修复报精确倍率**。

## 5. 原正确性断言的缺口

1. `frame == GRAM` 只检查已经写入的数据如何复制。漏写同时缺失于两边，该等式仍成立。
2. 基准实际只比较最后一帧（`joint-perf.test.ts:225`）；原文“每帧逐像素一致”超出断言范围。
3. GRAM 快照在 `runUntil` 末尾 adapter `sync` 的 topic 回调里抓取；帧体在稍早的模型过程
   中复制。恢复完整边沿后，同一量子内后续绘图可能让两者不同，快照不保证对应帧体发送时刻。
4. 两种模式都发布 10 帧。每轮只漏进少量像素也能触发发布，帧数与“存在非零像素”不能
   检测总线完整性。
5. 发布像素数是脏矩形面积累计，可以重复覆盖，不能与写次数或唯一非零像素数直接比较。

## 6. 调查得出的优化优先级

1. **P0：明确并实现 Direct 的电气发布边界。** 在需要外部可见的 intent 写之后保证块尾
   发布，保持 capture-before-body、同刻事件顺序和 continuation。用 WR 发出/收到对账
   以及期望图像锁住正确性，再报告联合吞吐。
2. **P1：降低每个可见边界的 Direct 银行同步。** 优先评估仅同步当前执行块涉及的资源、
   稀疏 dirty 写回，或让 frame 在可见边界间常驻并安全处理反应回写。87/86 槽全量操作是
   当前完整边沿对照中的最大单项；跨边界常驻需要独立验证模型反应读写的一致性。
3. **P1：压缩 GPIO intent / LCD reaction 的宿主调用。** MCU 侧供电采样、配置选择与 ODR
   双写仍频繁；LCD 每次锁存要采 16 根数据脚，再通过通用 state/memory host 操作推进。
   优先复用资源句柄、减少重复查表与失效，保留每个有效 WR 的可见性。
4. **P2：独立优化启动编译。** 研究跨板复用与布局绑定的 Instruction/shard，以及
   `compact` 的正则扫描和重写；不把冷编译收益混入稳态像素吞吐。

HAL_Delay 已有时间事件轮询，本次后段没有新增编译/fallback；二者都不能解释边沿漏失。
帧装配每 440 ms 只有 10 次，原夹具整块 GRAM 快照也只有约 1.54 MB 数据。它们不是本次
百万级边界与状态同步的优先方向。

## 7. 复现、验证与限制

调查阶段运行了两种模式的计数与 CPU 采样，完整读数与六份 cpuprofile 写到
`/tmp/mica-joint-diagnosis-*/`。

本次完整记录：`/tmp/mica-joint-diagnosis-PPiDVn/readings.jsonl`。该目录属于本机临时产物，
复现会创建新的随机目录。连续三次运行均为 4 个诊断用例通过，关键计数一致。

`yield-on-intent` 是反事实诊断，使用内部字段，不作为生产修复：它改变了调度与编译频率，
同一翻译块内的多次 intent 仍会合并。对本固件，两侧各项 MCU 计数相同且 WR/store 对账
完整；这不等于对所有反馈型电路、所有固件或每个像素值/地址完成等价性证明。

后续修复已加入独立值/地址及帧 oracle，并单独测量无逐 intent 探针的正式路径，见下节。

## 8. 修复与优化收口

实现任务仍仅分派给 DeepSeek V4.1 Flash 1017（opencodego），主线程接手未完成的运行时
修改并完成集成验证。

### 8.1 生产路径

- `runtime/jit.ts` 在实际 intent 身份改变时设置 `frame.publishPending`。编译器在正时长 `elapse` 开始前保存局部值及续体并返回，运行时写回后执行原有 `boundary()`；引脚变化时间与解释器一致。零时长或 suffix 写入在指令结束时返回；相同 intent 不额外返回。
- `Instance.directStateBank()` 按实例保存固定布局与数值银行。所有 Direct frame 复用它，通用 host 与绑定资源句柄的 state 写入均同步银行，使 reaction、普通 process、解释器回退、IRQ 与代码重编译之后的状态可见。每次调用不再读入全部 87 个 state。
- 返回时逐脏字枚举置位槽，保留状态失效与代码内存失效，取消全部 86 个 state 写槽和 4 个 memory 写槽的逐项检查。回归覆盖 bit 31 与下一个字。
- `compact` 用密集数组记录定义/使用与物理槽，手工扫描变量名，避免正则匹配数组和多组 Map 分配；统计遍历也减少中间数组。字符串字面量单独跳过，避免把消息中的 `v0` 等文本当作寄存器重写。缓存以 IR 的 WeakMap 为界，不跨实例保存绑定后的生成程序。

### 8.2 正确性与正式计时

440 ms 的默认路径收到全部 **545,004** 次 WR 变化，执行全部 **272,007** 次 GRAM
store；独立 MCU intent oracle 的最终 76,800 像素与 LCD 一致，并识别到三次完整蓝屏
清屏。10 帧累计发布 436,480 像素，每帧与发送时刻的独立 oracle 矩形逐像素一致。

三轮无逐 intent 探针的正式计时，最好活跃 CPU **2100.745 ms**、后段 CPU
**1656.301 ms**、总 CPU **3974.787 ms**，完整窗口约 **0.111× 实时**。各轮完整读数见
[基准记录第 11 节](stm32g431rbt6-ili9325-joint-benchmark.md#11-修复后的完整工作量基准2026-11-14)。
旧错误路径和块尾诊断探针均不能提供同工作量、同发布时刻的精确加速比。

验证通过：编译器 79 项、运行时 43 项、相关电气/MCU 86 项、真实适配器符合性 419 项、
生成 oracle 的 PR profile（表达式和电气各 50 次）、ILI9325 示例 19 项及正式性能基准。
运行时定向回归同时检查精确模式边沿时间、同指令多引脚原子性、续体只执行一次、相同
intent 不额外发布，以及 reaction/process 写回可见性；相关包类型检查和构建通过。

当前诊断入口仅运行正式路径的逐窗口对账，在 `examples/ili9325` 下用 Node 24 执行
`MICA_JOINT=1 ./node_modules/.bin/vitest run --config vitest.perf.config.ts bench/joint-diagnosis.test.ts`。
正式计时使用 `bench/joint-perf.test.ts`，其独立 oracle 对账位于计时轮次之外。历史双模式
profile 留作本机调查产物，当前入口不再默认重跑六份采样。

完整路径仍受百万级发布/恢复调度、电气求解与 LCD 锁存成本限制。第 6 节的通用宿主调用
压缩和更广泛的编译复用仍是后续可测方向；本次未承诺实时吞吐。

## 9. 器件热路径优化与剩余瓶颈

第 8 节优先修复漏沿及全银行同步，没有完成器件侧优化。继续采样正确路径后发现：LCD
每次像素写经过 `writeData → writePixel → markDirty / advanceAddress`，反复读取同一
地址、窗口和入口模式；MCU 每次 ODR 更新又写一遍没有读取者的后备字节。器件侧仍有
可删除的实际工作。

### 9.1 实际修改与宿主操作计数

- LCD 把像素写、脏矩形维护和地址推进放在同一次 `writeData` 调用内，复用局部快照。
  未回卷时只写快轴，回卷时写慢轴和快轴的最终值。保留独立的读地址推进实现，并用
  全部 8 种 AM/I-D 组合、多次窗口回卷及读写交替验证一致性。
- 数据总线仍在每个有效 WR 上升沿重新采样；相同颜色也逐次 store。屏外和窗口外的写
  跳过像素但继续推进地址；复位、供电、CS/RS、脏区调度与帧复制语义保持一致。
- MCU 的静态/动态 ODR 读取原本都走 `gpioOdrN` 状态。适配器没有导出 `periph`，也没有
  DMA 或快照恢复路径消费其 ODR 字节；因此移除全部 5 处重复的 ODR 后备写，保留 ODR
  状态和所有电气发布边界。外部直接检查旧 `periph` 字节会看到零，寄存器调试应读状态。

220 → 440 ms 的独立宿主计数：

| LCD 操作            |    优化前 |    优化后 |  减少 |
| ------------------- | --------: | --------: | ----: |
| 模型函数 call       |   680,605 |   272,608 | 59.9% |
| read                | 4,627,549 | 2,313,018 | 50.0% |
| sample              | 2,588,701 | 2,588,701 |     0 |
| store（含寄存器写） |   136,139 |   136,139 |     0 |
| write               |   138,058 |   137,631 |  0.3% |

优化前 `addrY` 单独被读取 1,087,998 次、`addrX` 681,274 次、`entryMode` 407,997 次；
写快路径改为每像素各一次。MCU 后段 `sample(VDD1)` 仍为 **545,157** 次，intent 为
**545,911** 次，host state write 为 **3,302,093** 次；ODR 后备写直接内联在生成代码中，
不会体现为 host store 调用下降。优化后 `periph` memory slot 的 version 在此窗口只
增加 **133**；这是脏内存提交计数，不能等同于全部 IR store 次数。

正式三轮基准的后段 CPU **1656.301 → 1447.774 ms（减少 12.6%）**，总 CPU
**3974.787 → 3282.373 ms（减少 17.4%）**。仅 LCD 优化时后段最好为 **1472.484 ms**；
MCU 的增量较小，不能把不同进程间的小幅差值当作精确独立收益。逐轮读数与全部正确性
计数见[基准记录第 12 节](stm32g431rbt6-ili9325-joint-benchmark.md#12-器件热路径优化后的完整工作量基准)。

### 9.2 当前后段 CPU 归因

同一正确路径、100 µs profiler 间隔，优化前 9,984 个样本，优化后 8,918 个样本。按整条
调用栈互斥归组，先分离 GC、夹具帧装配和电气，再区分 boundary 下的模型 body、其余
边界处理以及 Direct 生成代码与宿主桥接。联合板只有 LCD reaction，因此 boundary 下
`compiledBody` 及其 helper 归为 LCD；Direct 生成执行组同时包含 dispatcher、MCU shard
与其 helper，不能全部归为 MCU 指令计算。

| 栈归组                                       | 优化前份额 | 优化后份额 |
| -------------------------------------------- | ---------: | ---------: |
| Direct 桥接、状态提交及重排队                |     21.94% |     23.65% |
| LCD reaction 及 state/sample/memory helper   |     23.47% |     18.06% |
| 外层调度及其他运行处理                       |     16.86% |     17.06% |
| 边界调度、观察与发布（排除模型 body 和电气） |     11.69% |     13.40% |
| Direct 生成 dispatcher/shard 及 helper       |     11.77% |     12.33% |
| 电气求解                                     |      8.58% |      9.53% |
| 测试夹具帧装配及 helper                      |      3.77% |      4.35% |
| GC                                           |      1.36% |      1.09% |
| 其他                                         |      0.57% |      0.53% |

份额是采样线程时间，不直接换算进程 CPU；一项变快后，其他项的相对份额可能上升。
夹具的 `assembleFrames` 重建发送载荷用于正确性检查，不属于 LCD 生产适配器成本。

当前最大的单项 self 是 `runDirect` **14.77%**，其次 `runJit` **8.53%**、`boundary`
**8.33%**、`runUntil` **6.19%**。完整 440 ms 仍有 **2,184,168** 次 Direct 返回/恢复，
每次可见边沿要提交状态、求解、捕获观察、执行反应和重排队。器件优化没有减少这些必须
保留的边沿；仅 LCD 局部算术与调用简化无法消除当前约 **6.6 倍**的后段 CPU 差距。

后续可测方向：压缩发布/恢复的调度往返与脏状态提交的名字查找；给通用 reaction 的
state/sample 操作绑定资源句柄；为 MCU 的供电判定和 GPIO 意图选择减少重复宿主调用。
这些方向都需要保持逐沿采样、同指令多引脚原子性与反应回写可见性，不能靠合并 WR 脉冲
得到较好的吞吐数字。

### 9.3 复现与验证

新增 `bench/joint-profile.test.ts` 仅在 `MICA_JOINT_PROFILE=cpu` 或 `counts` 时运行。
在 `examples/ili9325` 下，将该变量设置为所需模式后执行
`./node_modules/.bin/vitest run --config vitest.perf.config.ts bench/joint-profile.test.ts`。
它先推进到 220 ms，再对后段单独采样或计数；计时之后校验 WR、GRAM store 和非零像素。
完整图像及逐帧独立 oracle 由正式基准在计时之外检查。

每次诊断创建 `/tmp/mica-joint-hotpath-*/`：CPU 模式保存 `post.cpuprofile`、归组与 self
热点 `summary.json`，计数模式保存 `calls.json`，两种模式保存窗口读数 `window.json`。
本轮原始采样分别位于 `JR9qte`（优化前）和 `AJVBX4`（优化后）目录，计数位于
`Z1Ke3w` 与 `TlLFB3`。原始轮次早于增加 JSON 汇总的入口，归组按同一规则离线计算。
插桩/采样耗时均不作为正式吞吐。

指定模型子代理完成了两个器件的只读调查、ODR 契约复核及新增 ODR 回归；一次实际编辑
请求连接失败，由主线程完成两个生产实现。STM32 7 个文件 **20 项**、ILI9325 3 个文件
**28 项**、两包类型检查和构建、三轮正式基准及独立对账通过。
