# CT107D 测试与性能汇总（2026-11-14）

本轮相关正确性测试、类型检查、构建和静态检查通过。浏览器最终三轮实时比中位数为
**0.3833×，尚未达到 0.95× 目标**；主要耗时在仿真 tick，轮间调度空闲已很小。
数码管预热后的轨迹稳定，启动阶段仍能观察到跨位更新瞬态。

本报告汇总本次会话中已经执行的测试与测量。整理时仓库 HEAD 为 `e908d78`；历史电气问题归因
基线为 `ad5605e`。测试发生在当时的工作区，提交号用于追踪，不表示在整理时重新执行了测试。
详细测量接入与复现流程见[预览测量记录](preview-measurement.md)。

## 1. 环境、负载与指标

| 项目                | 配置                                                               |
| ------------------- | ------------------------------------------------------------------ |
| 固件                | `assets/digital-display-dynamic.bin`，2421 B                       |
| 固件 SHA-256        | `b15a9f9f4232a70d88d080e2f6336359c701777951685a93177e3264b829bd25` |
| MCU 时钟 / 执行模式 | 11,059,200 Hz / `throughput`                                       |
| 整板                | 51 个器件，99 个网络                                               |
| Host 推进批次       | 64 仿真 ms；内部按事件推进，批次不是 MCU 执行或采样粒度            |
| 预热 / 稳态窗口     | 512 / 1024 仿真 ms，稳态绝对区间为 512–1536 ms                     |
| Node 检查点         | 512、576、…、1536 ms，共 17 个；16/64 ms 批次在这些时刻对照        |
| Node 环境           | Linux，Node 24.20.0，pnpm 12.14.0                                  |
| 浏览器环境          | Windows，Code 1.146.0，Electron 43.8.6，Chrome 150.0.7871.250      |

`cpuMs` 为进程 user + system CPU 时间；`elapsedWallMs` 为单调墙钟时间。
`realtimeRatio = 仿真毫秒 / 墙钟毫秒`，越大越快。Node 历史字段 `wallMs` 是 CPU 时间别名，
`rtf = cpuMs / simMs`，方向与实时比相反。浏览器无法读取进程 CPU 时间。

浏览器 cold 从复位后调用 `start()` 起算，到 512 仿真 ms，不含页面加载与整板装配；Node cold
包含装配、`runUntil(0)` 和预热，CLI 顶部器件模块导入另计。浏览器稳态 wall 从最后一次预热轮
完成开始，包含首个稳态轮之前的调度空闲。Windows 浏览器和 Linux Node 属于不同宿主环境。

## 2. 测试与代码质量结果

下表为相关范围的通过记录；同一用例可能在多轮验证中重复执行，数量不合计为全仓测试总数。

| 验证范围                     | 通过数量 / 结果                   | 核对内容                                                               |
| ---------------------------- | --------------------------------- | ---------------------------------------------------------------------- |
| Editor session / view        | 95 项                             | 调度超时后继续、串行推进、暂停恢复、观察钩子及绘制采样                 |
| Playground                   | 18 项                             | 13 项测量记录器测试、5 项准备流程测试                                  |
| Simulator runtime 适配       | 41 项                             | 装载、资源、话题及 guest / RPC 生命周期                                |
| 严格符合性                   | 419 项，0 失败、0 跳过            | 连接真实 adapter 的静态、语义、host、JIT、器件与一致性合同             |
| Generated oracle，PR profile | expressions / electrical 各 50 次 | seed `1296646977`，fast-check 4.10.2，两域均通过                       |
| 电气 `--verify-only`         | 全部断言通过                      | 数值对照、拓扑缓存、失败回滚与重试；入口未输出统一用例数               |
| Propagation plan             | 18 项                             | 重复 dirty slot、一次性 iterable、发布顺序及原子失败                   |
| CT107D preview               | 6 项                              | 4 项非法预热参数、64 ms 基准、16/64 ms 共同检查点对照                  |
| CT107D seg4 连续稳定         | 4 项                              | 换码重置稳定窗口、稳定零码消隐、取消选中保持与重新选中                 |
| CT107D 真实固件显示轨迹      | 2 项                              | 64 ms 与 1 ms 批次推进至 4096 仿真 ms                                  |
| 独立 seg4 包                 | 25 项，前段验证通过               | 独立包既有回归；与 CT107D 镜像共同核对                                 |
| 类型检查                     | 通过                              | Editor、Playground、Simulator、CT107D、seg4 及真实 implementation 合同 |
| Simulator 构建               | 通过                              | 运行时代码、sandbox 与声明产物                                         |
| 相关代码质量检查             | 通过                              | ESLint、Prettier、`git diff --check`                                   |

本轮执行了相关包与 PR profile 验证；完整性能矩阵和 generated daily profile 未运行。

电气扩展验证曾发现 `topologyPrepares` 为 6、预期为 5：基线与工作版同样失败，根因是失败求解
提前增加了公开计数。随后将计数延迟到成功提交段，原断言保持不变，缓存与失败重试验证通过。

## 3. 浏览器端到端性能

最终代码在同一页面连续测量三轮，每轮复位、预热 512 仿真 ms、测量 1024 仿真 ms。

| 轮次 | 稳态 wall（ms） | 实时比  | tick 均值（ms） | tick p95（ms） | Widget 均值（ms） | 轮间 idle 均值（ms） |
| ---- | --------------- | ------- | --------------- | -------------- | ----------------- | -------------------- |
| 1    | 2522.8          | 0.4059× | 156.91875       | 252.8          | 0.6875            | 0.06875              |
| 2    | 4810.6          | 0.2129× | 298.3875        | 599.1          | 2.14375           | 0.11875              |
| 3    | 2671.8          | 0.3833× | 166.1125        | 231.6          | 0.8               | 0.0625               |

| 轮次 | Cold wall（ms） | Cold 实时比 | 稳态 `skippedSlots` 合计 |
| ---- | --------------- | ----------- | ------------------------ |
| 1    | 4056.3          | 0.1262×     | 17                       |
| 2    | 2930.2          | 0.1747×     | 51                       |
| 3    | 4319.9          | 0.1185×     | 19                       |

三轮均有 16 个稳态 advance、`controls.complete=true`、各缓冲区 dropped 为 0、warnings 为空。
69 份服务端产物哈希成功，页面保持 visible；测量期间没有并行运行其他性能测试，测完已暂停。
产物哈希成功表示读取到的字节可追踪，源码与构建产物的一致性需另行核对。

稳态实时比中位数为 **0.3833×**。tick 明显主导耗时，Widget 与调度空闲占比较小；tick 包含
仿真往返，现有计时不能进一步把每毫秒分别归因于内部求解、Worker 调度和 RPC。
`skippedSlots` 描述启动落后目标周期的情况，仿真时间仍只取完成 tick 的结果。

每轮仅 16 个 tick，按最近秩法计算的 p95 对应本轮最大值，用于观察本次波动。三轮波动明显，
不能把不同轮次的差值当作优化收益，也不足以形成稳定尾延迟结论。

历史另有两个独立单样本：`1024 / 2758.5 = 0.3712×`、`1024 / 2009.4 = 0.5096×`。
后者 tick / Widget / idle 均值为 124.0625 / 1.45 / 0.06875 ms。这两个样本与最终三轮分开保留。

## 4. Node / CLI 性能记录

以下为不同夹具的独立单轮记录，不按最终浏览器三轮的统计口径合并。

| 测量入口                                 | 稳态 CPU（ms） | 稳态 wall（ms） | 实时比 | Cold CPU（ms） | Cold wall（ms） | Cold 实时比 |
| ---------------------------------------- | -------------- | --------------- | ------ | -------------- | --------------- | ----------- |
| Node preview，预热改为按批次推进后的一轮 | 1576.1         | 1209.4          | 0.847× | 2183.0         | 1225.1          | 0.418×      |
| `verify-firmware` CLI                    | 1391.917       | 1116.668        | 0.917× | 1842.068       | 1004.079        | 0.510×      |

两者负载均为上述固件、时钟与 512/1024 ms 区间。CLI faults 为 0，窗口末 DS1 为 `2018`、
DS2 为 `--03`；CLI 分段 CPU 为注入 0.023 ms、advance 1391.565 ms、逐步观测 0.185 ms。
分段为整窗的子集，advance 包含话题捕获，整窗另有计时与循环开销。

Node 基准加载源码 DDL、适配器与 metadata；CLI 加载 dist 器件 JS 与 src metadata，包含 LED、
显示与话题历史观测。浏览器加载服务端构建产物。源码与 dist 原始哈希输入不同；这些读数用于
各自夹具的复现，不能横向相除作为运行时加速比，或相减隔离浏览器开销。

## 5. 热点与优化实验

独立 Worker profile 的仿真线程共 4983 个样本，主要自耗时采样如下；该 profile 与最终三轮
端到端计时分开执行。

| 函数 / 类别       | 样本数 | 占比（约） |
| ----------------- | ------ | ---------- |
| `runSolve`        | 1687   | 33.9%      |
| GC                | 209    | 4.2%       |
| `factorize`       | 195    | 3.9%       |
| `substitute`      | 173    | 3.5%       |
| `restoreTopology` | 151    | 3.0%       |

Widget Worker 的 5100 个样本中 5092 个为 idle。采样支持继续关注通用电气求解路径，
渲染解耦在本轮证据中优先级较低。

| 实验                                                    | 记录                                                                   | 最终处理                             |
| ------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------ |
| 删除临时 `Map<number, PinUpdate>`，复用已去重的并行数组 | 两次各 5 对交替对照，CPU 两组中位数之比 after / before 为 0.967、0.975 | 保留小幅简化；收益量级较小，存在波动 |
| PreparedBlock 预绑定节点布局                            | 5 对 CPU 逐对比值中位数为 0.982，方向混合                              | 撤回额外布局缓存                     |
| `topologyPrepares` 成功提交计数                         | 基线与工作版既有失败同为 6 vs 5；修复后原断言通过                      | 作为独立正确性修复保留               |

布局实验两组 CPU 中位数分别为 1570.3 / 1506.3 ms，比值为 0.959；它与逐对比值中位数
0.982 是不同统计量。Map 第二轮数值来自会话汇总；布局实验保留了逐对日志。
这些结果不构成浏览器端到端的受控加速比。

配对运行的固件、17 个检查点和设备话题状态一致，faults 为空；设备话题摘要为
`sha256:ccc2eca42a86570a`，检查点摘要为 `sha256:0d2c77c1e6ff53bb`。
话题唯一键使用实例 ID + 端口，位号仅作辅助展示。

## 6. 显示正确性与闪烁观察

64 ms 批次主回归覆盖 0–4096 仿真 ms，在 512–4096 ms 共检查 57 个时间点：

| 仿真区间（ms） | DS1    | DS2    |
| -------------- | ------ | ------ |
| 512–1088       | `2018` | `--02` |
| 1152–2240      | `2018` | `--03` |
| 2304–3328      | `2018` | `--04` |
| 3392–4096      | `2018` | `--05` |

全程共 19 条 digit 消息，包含启动初值；预热后仅 3 条，均为 DS2 `digit4`，交付于
1152 / 2304 / 3392 ms。预热后的轨迹无消隐、无未知段码。

1 ms 对照中，首帧八位最终字形分别交付于 1 / 1 / 2 / 3 / 3 / 4 / 5 / 11 ms。
DS2 `digit4` 在 0 ms 为零码，5 ms 为 `0x06`（`1`），11 ms 为 `0x5b`（`2`）；后续
`3` / `4` / `5` 分别交付于 1126 / 2241 / 3355 ms。以上均为批次交付时刻，内部真实提交
时刻需更细粒度观测。64 ms 终值会遮住启动瞬态，两片 seg4 的更新也不组成全局原子帧。

模型按候选段码连续稳定 50 μs 后提交，取消选中时保持最近显示；亮度与余辉时间积分不在该
显示模型内。因此正确性结论限定于上述段码轨迹与稳定窗口，启动瞬态仍作为已知现象保留。

## 7. 复现与证据

仓库根目录下的主要验证入口：

```bash
pnpm --filter @mica-js/editor exec vitest run src/canvas/session.test.ts src/canvas/view.test.ts
pnpm --filter @mica-js/playground test
pnpm --filter @mica-js/simulator test:runtime
node packages/simulator/bench/electrical.mjs --verify-only
node --test packages/simulator/bench/propagation-plan.test.mjs
pnpm --filter @mica-js/example-ct107d exec vitest run --config vitest.perf.config.ts bench/preview.test.ts
pnpm --filter @mica-js/example-ct107d exec vitest run --config vitest.config.ts test/seg4-stability.test.ts test/seg4-preview.test.ts
MICA_CONFORMANCE_ADAPTER="$PWD/tests/conformance/adapter.mjs" pnpm test:conformance:strict
MICA_CONFORMANCE_ADAPTER="$PWD/tests/conformance/adapter.mjs" pnpm test:generated --require-adapter
```

符合性与生成 oracle 使用构建好的真实 adapter 依赖。CLI 构建、运行命令及浏览器启动步骤见
[复现流程](preview-measurement.md#复现)；浏览器复位并暂停后 `start()`，运行至 recorder stopped，
再暂停读取报告。`start()` 若遇到在途刷新需等该轮结算后重试；recorder 自动停止不等于仿真暂停。

持续可复查的测试入口包括 [preview](../bench/preview.test.ts)、
[稳定窗口](../test/seg4-stability.test.ts)和[真实固件显示轨迹](../test/seg4-preview.test.ts)。
本机会话原始记录位于 `test-results/ct107d-layout-paired-review.log`、
`test-results/generated/report.json`、`test-results/ct107d-display-trace.md`、
`test-results/ct107d-electrical-validation.md` 与 `/tmp/ct107d-fw-metrics.log`。
这些临时证据不随新 checkout 提供；早期归因记录反映修复前状态，最终处理见本报告第 2 节。

实时目标仍是开放项：当前三轮中位数为 0.3833×。后续性能验收需要在固定宿主、相同产物与负载下
重复测量，并对仿真 Worker 热点优化做配对验证。
