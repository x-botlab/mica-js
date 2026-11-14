# CT107D 预览性能实测记录（2026-11-14）

本文记录实际测量结果；文中所有速度读数都只对应写明的环境与样本，未运行的最终值不在本文补写。

## 固件与测量口径

| 项            | 值                                                                 |
| ------------- | ------------------------------------------------------------------ |
| 固件          | `examples/ct107d/assets/digital-display-dynamic.bin`               |
| 大小          | 2421 B                                                             |
| SHA-256       | `b15a9f9f4232a70d88d080e2f6336359c701777951685a93177e3264b829bd25` |
| 时钟          | 11,059,200 Hz                                                      |
| 执行后端      | `throughput`                                                       |
| 预热 / 窗口   | 512 / 1024 仿真毫秒                                                |
| Host 推进批次 | 64 仿真毫秒                                                        |

64 ms 是画布和基准夹具的 host 推进批次（浏览器 `stepMs`、Node `tickMs`），**不是 MCU 指令粒度，
也不是数码管扫描周期**。8051 仍按 11.0592 MHz 执行；GPIO 与电气边沿在模型内部按实际事件
截止时间执行，引脚意图、电气求解和边沿传播停在真实事件截止时间，不跨截止时间合并中间状态。
`runUntil` 批次只决定 adapter `sync(batch)` 与话题交付的呈现边界：观察面看到的是批次终点
状态。64 ms 检查点（1152/2304/3392 ms）与 1 ms 对照的交付时刻（1126/2241/3355 ms）不同，见
“显示轨迹”。

## 浏览器测量

浏览器 API 在 `apps/playground/src/measure.ts`。只有带 `?measure=1` 打开页面时才启用测量并安装
`window.__micaMeasure`；默认页面不采样。CT107D 文档描述符固定
`stepMs: 64`、`execution: 'throughput'`（`apps/playground/src/runtime-demo.ts`）。

步骤：

1. 打开 `http://localhost:5199/?doc=ct107d-canvas&measure=1`，切到仿真模式，点“复位”并保持暂停
   （仿真时间为 0）。
2. 控制台执行 `__micaMeasure.start()`。默认预热 512、窗口 1024 仿真毫秒，也可传
   `{ warmupMs, windowMs }`。
3. 点“运行”，轮询 `__micaMeasure.report().phase`，直到它变为 `'stopped'`。
4. 点“暂停”，读取 `__micaMeasure.report()`。

`start()` 只接受 `idle` 或 `stopped`，且要求没有尚未结算的 advance；该拒绝 guard 保留。若
`start()` 恰好撞上一次 `dt = 0` 的刷新（暂停或复位后的呈现刷新），会因 advance in flight 被
拒绝；等该轮 `advanceSettled` 后再重试即可。若没有先复位并暂停，`start()` 也可能报告带
`controls.complete=false` 和 baseline 警告；此时的稳态数值不可用。

### cold、CPU 与 wall 的含义

| 字段 / 区段               | 含义                                                                                                                                                          |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `coldStart`               | 从复位后的 0 到 512 仿真 ms；wall 从 `start()` 开始，不含页面/文档加载与整板装配                                                                              |
| `steadyState`             | 512–1536 仿真 ms；wall 从最后一次预热轮完成时开始，包含首个稳态轮之前的调度空闲                                                                               |
| `controls.complete`       | baseline 为 0、advance 记录连续、steady advance 记录无淘汰、首个 steady tick 从预热边界开始、窗口到达终点时为 `true`；warmup 记录被固定容量缓冲淘汰不影响该值 |
| `cpu`                     | 浏览器固定为 `available: false`：JS 读不到 `process.cpuUsage()`                                                                                               |
| `realtimeRatio`           | 该区段的 `sim.elapsedMs / elapsedWallMs`，只代表墙钟；不是 CPU 时间                                                                                           |
| `raw.advances[].tickMs`   | 单轮仿真 tick 的墙钟往返                                                                                                                                      |
| `raw.advances[].widgetMs` | 单轮 widget step 的墙钟耗时                                                                                                                                   |
| `raw.advances[].idleMs`   | 上一轮完成到本轮开始的空闲                                                                                                                                    |

跨越预热边界或窗口终点的 tick 不同时计入两侧区段，分别记为 `controls.crossBoundary` /
`controls.crossEnd`。浏览器没有 CPU 口径；下文把 `realtimeRatio` 写成 `0.3712x`、`0.5096x`、
`0.4059x` 等仅为比值记号，**不是加速倍数**。

Node 侧的口径不同：`cpuMs` 是进程 CPU 时间（user + system），`elapsedWallMs` 是
`performance.now()` 墙钟；`realtimeRatio = 仿真 ms / 墙钟 ms`。历史字段 `wallMs` 仍等于
`cpuMs`；`rtf = cpuMs / simMs`。两者都是 CPU 时间口径的历史指标，不是 `sim / wall`。
`coldCpuMs` / `coldElapsedWallMs` / `coldRealtimeRatio` 覆盖装配、`runUntil(0)` 与预热，
稳态窗口单独计时；浏览器 cold 从 `start()` 起算，不含页面/文档加载与整板装配，两者的 cold
区间不同，不能直接比较。

## 已观测样本

### 历史单样本（最终版本之前）

下表是两个**独立的单样本**，不是重复测量，也不是配对实验：

| 样本 | 稳态 `realtimeRatio` | 备注                                                                                  |
| ---- | -------------------- | ------------------------------------------------------------------------------------- |
| 1    | 0.3712               | 单样本；未给出同粒度的 tick/widget 分解                                               |
| 2    | 0.5096               | 同一轮稳态的 `tickMs` 均值 124.06 ms、`widgetMs` 均值 1.45 ms、`idleMs` 均值 0.069 ms |

样本 2 中，$64 / (124.06 + 1.45 + 0.069) \approx 0.5096$，与报告比值自洽；tick 占绝大部分，
widget 和 idle 都很小。

### 最终版本同页 3 轮

最终版本在同一页面、每轮复位到 0 后重新 `start()`，共测 3 轮；每轮预热 512、窗口 1024 仿真
毫秒，均 16 个 advance：

| 轮次 | 稳态 wall (ms) | `realtimeRatio` | `tickMs` 均值 (ms) | `tickMs` p95 (ms) | `widgetMs` 均值 (ms) | `idleMs` 均值 (ms) |
| ---- | -------------- | --------------- | ------------------ | ----------------- | -------------------- | ------------------ |
| 1    | 2522.8         | 0.4059          | 156.91875          | 252.8             | 0.6875               | 0.06875            |
| 2    | 4810.6         | 0.2129          | 298.3875           | 599.1             | 2.14375              | 0.11875            |
| 3    | 2671.8         | 0.3833          | 166.1125           | 231.6             | 0.8                  | 0.0625             |

`realtimeRatio` 中位数为 0.3833。3 轮均 `controls.complete=true`、无 dropped raw records、
无 warning；artifacts 为 `ok`（69 files），页面保持可见（visible）。测完已暂停；测量期间没有
并行运行其他性能测试。

轮次间差异明显，**不能把轮与轮之间的差值当作优化收益**。两组读数都不构成加速比，也不能据此
宣称达到 0.95x；0.95x 仍只是目标阈值。

## 最终验证（2026-11-14）

最终版本已完成以下验证，均通过：

- editor 95、playground 18、runtime 41、conformance 419。
- generated PR 两域各 50。
- `electrical --verify-only`、propagation 18、preview 6。
- `typecheck` 与 build。

## CPU profile（定位用）

一次 Worker 的 CPU profile（采样，不是受控基准）：`runSolve` 约 34%，GC 约 4%，widget step
接近 idle。热点在电气求解 `packages/simulator/src/electrical.ts`，不在 widget 层。百分比只用于
定位，不作为验收读数。

## 电气求解实验

### Map 移除（当前工作区）

`packages/simulator/src/electrical.ts` 的批量更新原来先构造 `Map<number, PinUpdate>` 再遍历；
当前工作区改为按 `updatedSlots` / `updatedIntents` / `updatedEdges` 的下标直接读写。两次 5 对交替
A/B 的 **CPU 时间中位数比（after/before）** 为 **0.967 / 0.975**，属于微小收益；不作加速比结论。
该改动尚未提交。

### 新块 layout（已撤回）

同一电气求解器上试过新块 layout：5 对 paired 的 CPU 中位数比为 **0.982**，且各对方向混合
（有升有降），不能排除噪声。该实验已撤回，不进入当前实现，也没有“已提速”结论。

### 统计回滚（独立修复）

`topologyPrepares` 改为只在批量被接受后提交：候选重建先记局部计数，提交路径再累加到
`statistics`，避免被丢弃或回滚的批次提前增加统计。这个修复与上面的 layout 实验无关，单独保留。

临时 A/B 脚本与日志在 `test-results/`（gitignored）：`ct107d-paired.mjs` 与多份 `*.log`。
同一实验可能保留多轮日志，本文只引用上文明确写出的运行；它们不是包的一部分。

## 显示轨迹（4 s）

完整记录在 `test-results/ct107d-display-trace.md`（本机实测记录，gitignored）。该记录按
`board.time` 保存批次终值；下面统一按批次交付口径重述要点：

- 64 ms 主回归覆盖 0–4096 ms、57 个检查点：DS1 固定 `2018`；DS2 依次为 `--02`、`--03`、
  `--04`、`--05`。预热后只有 3 条 digit 消息，全部来自 DS2 `digit4`（64 ms 批次交付时刻
  1152/2304/3392 ms）。
- 1 ms 对照：首帧八位**交付**时刻为 1/1/2/3/3/4/5/11 ms；DS2 `digit4` 在 0 ms 消隐、5 ms 段码
  `0x06`（字符 `1`）、11 ms 段码 `0x5b`（字符 `2`）。1126/2241/3355 ms 同样是 1 ms 批次的
  交付时刻，不是器件内部真实提交时刻；真实提交落在相邻批次之间，本文不用这些读数反推。64 ms
  检查点只看到批次末值。
- 预热后的稳定窗口没有 blank 或未知段码；但启动阶段存在 1 ms 批次可见的非原子瞬态。DS1/DS2 是
  两个独立 `seg4`，不存在跨片全局原子帧；64 ms 批次也不能证明任意时刻八位来自同一帧。

因此本文**不承诺八位原子帧**，也不把 64 ms 检查点当作硬件扫描时序。

## 限制与开放项

- 浏览器样本来自 Windows/Electron，Node 夹具在 Linux。OS、浏览器事件循环、sandbox/Worker 传输、
  画布绘制和 JIT 都不同；不能把两者相减来“隔离浏览器开销”，也不做跨环境加速比。
- 浏览器只有墙钟，没有 CPU 时间；Node 同时有进程 CPU 时间和墙钟，且 `realtimeRatio` 用墙钟。
  两者的分母虽都是墙钟，但运行时和环境不同，仍不能直接比较。
- 浏览器已有同一页面重置 3 轮（0.4059x / 0.2129x / 0.3833x），但轮间波动大、不是配对实验；
  历史 0.3712 和 0.5096 也不是稳定基准值。不能跨轮相减宣称收益。
- **未达 0.95x 是开放项**：3 轮中位数 0.3833x，当前没有可宣称达到 0.95x 的优化。继续推进需要
  受控环境下的重复测量、Worker/主线程拆分和配对 A/B。
- 本文不记录未运行的 final 值；临时 `test-results/` 产物不作为仓库契约。

## 复现

### Node 夹具（`preview.test.ts`）

```bash
pnpm --filter @mica-js/example-ct107d exec vitest run bench/preview.test.ts --config vitest.perf.config.ts
# 全部 bench（还会跑 perf.test.ts）
pnpm --filter @mica-js/example-ct107d bench
```

- 6 个用例：4 个非法预热参数（`Infinity`、`NaN`、负数、超安全整数）在装配前抛 `RangeError`；
  2 个基准用例是 64 ms 批次主回归与 16 ms/64 ms 共同检查点一致性。
- 输出 `PREVIEW_BASELINE` / `PREVIEW_COMPARE`；`MICA_PREVIEW_DUMP=1` 追加完整 `PREVIEW_RESULT`。
- 夹具常量与选项在 `examples/ct107d/bench/preview.ts`，测量核心在
  `examples/ct107d/bench/measure.ts`；bench 直接装载 `src/`，不依赖 `mica build`。
- bench 的 `fingerprints.source` 为 `src`，器件相关原始哈希（`models`/`code`/`definitions`）
  对应源码 DDL、源码适配器与 `device.json`；浏览器测量核对 `dist` 产物。两侧原始哈希的输入
  不同，不能直接比较。

### `verify-firmware` CLI

```bash
pnpm --filter @mica-js/example-ct107d build
node examples/ct107d/verify-firmware.mjs \
  examples/ct107d/assets/digital-display-dynamic.bin \
  --execution=throughput --warmup-ms=512 --ms=1024 --step=64 --clock=11059200
```

CLI 从 `dist/devices/<id>/device.js` 装载器件模块，从 `src/devices/<id>/device.json` 读取元数据，
固件由命令行给出。`--warmup-ms=512` / `--ms=1024` 与 bench 的预热/窗口同义；`--step=64` 是 CLI
自己的采样粒度，不改变内部事件推进，也不是画布批次。每个固件末尾输出一行
`FIRMWARE_METRICS <json>`。`cpuMs` / `elapsedWallMs` 包含 LED、数码管与话题历史的观测开销，
不能与 bench 或浏览器读数直接等价。

### 浏览器

```bash
pnpm --filter @mica-js/playground dev --host 0.0.0.0 --port 5199 --strictPort
```

打开 `http://localhost:5199/?doc=ct107d-canvas&measure=1`，按“浏览器测量”的四步执行。
`dev` 会先构建 SDK 与 CT107D 组件，并复制到 `public/components`。

### 显示轨迹用例

```bash
pnpm --filter @mica-js/example-ct107d exec vitest run test/seg4-preview.test.ts --config vitest.config.ts
pnpm --filter @mica-js/example-ct107d exec vitest run test/seg4-stability.test.ts --config vitest.config.ts
```

### 配对 A/B（临时，gitignored）

```bash
node test-results/ct107d-paired.mjs
BASELINE_FILE=test-results/ct107d-before-layout.ts node test-results/ct107d-paired.mjs
```

## 相关路径

| 路径                                                 | 用途                                              |
| ---------------------------------------------------- | ------------------------------------------------- |
| `examples/ct107d/assets/digital-display-dynamic.bin` | 2421 B 预览固件                                   |
| `examples/ct107d/bench/preview.ts`                   | 512/1024/64 ms、11.0592 MHz 与基准选项            |
| `examples/ct107d/bench/preview.test.ts`              | Node 预览夹具用例（6 项）                         |
| `examples/ct107d/verify-firmware.mjs`                | 固件联调 CLI（dist 器件 + src 元数据）            |
| `examples/ct107d/bench/measure.ts`                   | Node 测量核心（CPU/墙钟、检查点、摘要）           |
| `apps/playground/src/measure.ts`                     | 浏览器测量 API、`__micaMeasure`、cold/steady 分区 |
| `apps/playground/src/runtime-demo.ts`                | CT107D 文档描述符（64 ms、throughput）            |
| `apps/playground/scripts/components.mjs`             | 构建并复制 CT107D 产物到 Playground               |
| `packages/editor/src/canvas/session.ts`              | `tickMs` / `widgetMs` / `idleMs` 采样             |
| `packages/editor/src/canvas-editor.ts`               | measurement hooks 接线                            |
| `packages/simulator/src/electrical.ts`               | `runSolve`、批量更新与 `topologyPrepares`         |
| `examples/ct107d/test/seg4-preview.test.ts`          | 64 ms / 1 ms 显示轨迹用例                         |
| `examples/ct107d/test/seg4-stability.test.ts`        | 稳定窗口用例                                      |
| `test-results/ct107d-display-trace.md`               | 4 s 显示轨迹细节（gitignored）                    |
| `test-results/ct107d-paired.mjs`                     | 临时配对 A/B 脚本（gitignored）                   |
