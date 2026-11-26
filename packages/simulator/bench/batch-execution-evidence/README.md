# 合批执行验收证据（2026-11-26）

## 最终候选 84ffbf4 / harness fe8cda0

- 候选产品稳定提交：`84ffbf4b72c9bff7349376444e06172ef573f2e1`
- 测量时仓库 HEAD：`fe8cda04181da6ad4ceba5c5a8cc9c2b5cfa7c8a`（其后仅证据文档）
- 候选发布包 SHA-256：`122aff8b47af63ca77d551c323b2676cc95e3c53247befa1fe766992933be9d3`
- 基线：`8a36ed4`，发布包 SHA-256 `bfb59482c4006ebae2d948f76ce737ec921c26ef338d3370121a32ba16dca0c3`
- 环境与初始运行相同：Node v24.20.0 / V8 13.6；Chrome 153.0.8010.12 / V8 15.3，`crossOriginIsolated=true`；i7-12700K，5 次预热 / 25 个交替配对样本。

命令：

```bash
node packages/simulator/bench/batch-execution.mjs \
  --baseline-sdk=/tmp/opencode/issue313-bench-baseline-8a36ed4/packages/simulator/dist/index.js \
  --baseline-sha=8a36ed4 --require-batch --require-targets

node packages/simulator/bench/batch-execution-browser.mjs \
  --baseline-sdk=/tmp/opencode/issue313-bench-baseline-8a36ed4/packages/simulator/dist/index.js \
  --baseline-sha=8a36ed4 --require-batch --require-targets

node packages/simulator/bench/batch-execution-browser.mjs --controls-only \
  --baseline-sdk=/tmp/opencode/issue313-bench-baseline-8a36ed4/packages/simulator/dist/index.js \
  --baseline-sha=8a36ed4 --require-batch --require-targets
```

### Node 混合（默认四路）

通过全部检查。中位数 / P95：disabled `6.7910` / `7.3497 ms`，active `0.0665` / `0.0847 ms`，enabled-no-registration `6.6550` / `7.4706 ms`，baseline-disabled `7.4557` / `7.9266 ms`。active/disabled 中位数比值 `0.00979`（99.02% 加速）；disabled/baseline `0.91085`、no-registration/baseline `0.89260`，均低于 3%。真实队列：disabled 与 no-registration 各 65,536/65,536，active 2/2；active 准入 attempts/admissions/declines = 2/1/1。原始记录：[node-mixed-fe8cda0.json](node-mixed-fe8cda0.json)。

### Chromium 混合（默认四路）

仍有两个控制门槛 miss，保留原始失败：

| 运行     | disabled/baseline | no-registration/baseline | active/disabled | 队列 disabled / active |
| -------- | ----------------: | -----------------------: | --------------: | ---------------------- |
| 主运行   |       **1.03147** |              **1.03287** |         0.01085 | 65,536 / 2             |
| 诊断重复 |       **1.04968** |              **1.04968** |         0.01082 | 65,536 / 2             |

主运行中位数 / P95：disabled `7.375` / `7.720 ms`，active `0.080` / `0.115 ms`，no-registration `7.385` / `7.785 ms`，baseline `7.150` / `7.520 ms`。活动加速（约 98.9%）和真实唤醒下降继续通过；两个 3% 无候选控制仍失败。重复一次 miss 更大，不能归为单次噪声；这仍是默认混合验收口径下的真实失败。原始记录：[chromium-mixed-fe8cda0.json](chromium-mixed-fe8cda0.json)、[重复](chromium-mixed-fe8cda0-repeat1.json)。

### Chromium controls-only（可选隔离复测）

通过两个控制门槛，且**不声称**活动加速或唤醒下降通过：

| variant                 |         中位数 / P95 | 相对 baseline 中位数比值 |
| ----------------------- | -------------------: | -----------------------: |
| disabled + registration | `7.160` / `7.415 ms` |                  1.00491 |
| enabled-no-registration | `7.150` / `7.475 ms` |                  1.00351 |
| baseline-disabled       | `7.125` / `7.500 ms` |                        — |

输出 `mode: "controls-only"`、`controlsOnly: true`、`speedOrWakeChecked: false`；`acceptance.gates` 只含 `disabledVsBaseline` 和 `enabledNoRegistrationVsBaseline`，`schedule` 为 `null`。活动组从正确性探针、预热和计时样本中全部省略，因此该结果不能替代混合模式的 gate；混合失败仍保留。原始记录：[chromium-controls-only-fe8cda0.json](chromium-controls-only-fe8cda0.json)。

本次未覆盖或修改初始 `1e9b900` 证据；其原始 JSON 与结论保留在下方。过程 agent 的短混合 Chromium 探针曾报告 +2.12% / +1.84%，但本次正式 5/25 混合运行仍 miss，故不以其替代正式结果。

## 初始候选（1e9b900）结论（保留）

- Node 发布 ESM：全部验收通过。活动组中位数从 7.7558 ms 降到 0.0760 ms（99.02%），真实 `EventQueue` 入队/出队从 65,536/65,536 降到 2/2（唤醒下降 99.997%）；关闭与开启但无候选相对 `8a36ed4` 基线中位数分别为 +0.71% 和 +0.58%，均低于 3%。
- Chromium 发布 bundle：合批收益和真实控制组通过，但**无候选开销未达标**。活动组中位数从 7.43 ms 降到 0.075 ms（98.99%），队列 65,536/65,536 → 2/2；关闭与开启但无候选相对基线中位数分别 +6.75% 和 +6.39%，超过 3%。重复一次为 +5.73% 和 +6.61%，失败可复现，不是单次噪声。`--require-targets` 因此在 Chromium 返回非零，未隐藏 miss。
- 诊断线索：Chromium 的关闭组和无注册组都约 7.2–7.4 ms，基线约 6.8–7.0 ms。无注册组同样变慢，说明注册设置不是主因；差异位于 Chrome V8 15.3 下候选编译/运行的无候选稳态路径。Node V8 13.6 下同一对照通过。计时已使用每 variant 独立闭包避免跨 `BoardRuntime` 多态调用点，并通过 COOP/COEP 启用高分辨率计时；修复前后 Chromium 控制组均失败。

## 候选与基线

| 项目               | 值                                                                               |
| ------------------ | -------------------------------------------------------------------------------- |
| 候选仓库 HEAD      | `a5d395a8372d3e12b45462aa523fe1a7f1c207b4`                                       |
| 产品稳定提交       | `1e9b900`（其后为测试、文档与本基准提交）                                        |
| 候选发布包         | `packages/simulator/dist/index.js`                                               |
| 候选发布包 SHA-256 | `dfd63603bea9485b732373079d44c533f4cc409b3ee91e72bfbdcccdbdca04a4`               |
| 基线提交           | `8a36ed4`                                                                        |
| 基线发布包         | `/tmp/opencode/issue313-bench-baseline-8a36ed4/packages/simulator/dist/index.js` |
| 基线发布包 SHA-256 | `bfb59482c4006ebae2d948f76ce737ec921c26ef338d3370121a32ba16dca0c3`               |
| 机器               | 12th Gen Intel Core i7-12700K，20 线程                                           |
| 系统               | Linux 6.8.0-149-generic x64                                                      |
| Node               | v24.20.0，V8 13.6.233.17-node.53                                                 |
| Chromium           | Chrome/153.0.8010.12，V8 15.3.76.4，crossOriginIsolated=true                     |

## 精确命令

```bash
PATH="$HOME/.nvm/versions/node/v24.20.0/bin:$PATH" \
node packages/simulator/bench/batch-execution.mjs \
  --baseline-sdk=/tmp/opencode/issue313-bench-baseline-8a36ed4/packages/simulator/dist/index.js \
  --baseline-sha=8a36ed4 --require-batch --require-targets

PATH="$HOME/.nvm/versions/node/v24.20.0/bin:$PATH" \
node packages/simulator/bench/batch-execution-browser.mjs \
  --baseline-sdk=/tmp/opencode/issue313-bench-baseline-8a36ed4/packages/simulator/dist/index.js \
  --baseline-sha=8a36ed4 --require-batch --require-targets
```

两边均为 65,536 次 `store8`、每轮 10 ps、目标 655370 ps、5 次预热、25 个交替配对样本。每次运行先核对 65,536 个字节全为 42、`cursor=65536`、`done` 时间 655360 ps 和最终板时间 655370 ps，再记录计时。

## Node 稳态（runUntil，中位数 / P95 ms）

| variant                                   | 真实队列 push/pop | 新板建板至完成 ms | 中位数 | P95    | 准入 attempts / admissions / declines |
| ----------------------------------------- | ----------------- | ----------------- | ------ | ------ | ------------------------------------- |
| disabled (`batchExecution:false`，同注册) | 65,536 / 65,536   | 15.9126           | 7.7558 | 8.5879 | 0 / 0 / 0                             |
| active (`true` + 注册)                    | 2 / 2             | 0.3785            | 0.0760 | 0.1587 | 2 / 1 / 1                             |
| enabled-no-registration                   | 65,536 / 65,536   | 13.5376           | 7.7458 | 9.9193 | 0 / 0 / 0                             |
| baseline-disabled (`8a36ed4`)             | 65,536 / 65,536   | 12.7681           | 7.7008 | 9.2839 | 不适用                                |

中位数比值：active/disabled `0.009799`；no-registration/disabled `0.998721`；disabled/baseline `1.007131`；no-registration/baseline `1.005844`。全部检查通过。

## Chromium 稳态（runUntil，中位数 / P95 ms）

主运行：

| variant                                   | 真实队列 push/pop | 新板建板至完成 ms | 中位数 | P95    | 准入 attempts / admissions / declines |
| ----------------------------------------- | ----------------- | ----------------- | ------ | ------ | ------------------------------------- |
| disabled (`batchExecution:false`，同注册) | 65,536 / 65,536   | 11.99             | 7.4300 | 7.9700 | 0 / 0 / 0                             |
| active (`true` + 注册)                    | 2 / 2             | 0.35              | 0.0750 | 0.1150 | 2 / 1 / 1                             |
| enabled-no-registration                   | 65,536 / 65,536   | 9.46              | 7.4050 | 7.9150 | 0 / 0 / 0                             |
| baseline-disabled (`8a36ed4`)             | 65,536 / 65,536   | 9.745             | 6.9600 | 7.2550 | 不适用                                |

中位数比值：active/disabled `0.010094`；no-registration/disabled `0.996635`；disabled/baseline `1.067529`（失败）；no-registration/baseline `1.063937`（失败）。

重复运行：

| variant                 | 中位数 | P95    |
| ----------------------- | ------ | ------ |
| disabled                | 7.2000 | 7.4100 |
| enabled-no-registration | 7.2600 | 7.4550 |
| baseline-disabled       | 6.8100 | 7.3100 |

中位数比值：disabled/baseline `1.057269`（失败）；no-registration/baseline `1.066079`（失败）。两次运行的唤醒下降、活动组加速和无候选相对关闭组检查均通过，失败只集中在相对 `8a36ed4` 的 3% 无候选控制阈值。

## 方法说明

- 计时只覆盖 `runUntil`；建板、正确性核对、证据快照和 dispose 均在计时外。`cold` 字段实际含义是“新板 / 预采样前建板至完成”，运行于同一已预热 JS engine，不代表进程或浏览器启动。
- 每个 variant 使用独立计时闭包，避免共享一个跨候选/基线 `BoardRuntime` 类的多态 `runUntil` 调用点污染 3% 控制阈值。
- 浏览器页面通过 COOP/COEP `crossOriginIsolated=true` 获得高分辨率 `performance.now()`。
- 正式计时运行不安装探针。真实队列计数与 `prepareBatch` 准入计数来自独立、未计时的正确性运行；准入返回准备好的轮次会在该次运行中提交，真实队列计数仍是主要断言。
- 官方阈值按稳态样本中位数比值执行；逐对中位数比值和 P95 比值保留在原始 JSON 中仅用于观察配对噪声。
- 原始记录：[Node](node-a5d395a.json)、[Chromium 主运行](chromium-a5d395a.json)、[Chromium 重复](chromium-a5d395a-repeat1.json)。
