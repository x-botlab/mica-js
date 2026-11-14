# STM32G431RBT6 MCU 模型：缺陷登记与吞吐性能

- 日期：2026-11-14
- 范围：`examples/stm32g431rbt6`（Cortex-M4 Thumb 子集 + GPIO/RCC/PWR/USART/SysTick/NVIC）、
  `examples/ili9325`（PWR 与 LCD 联合仿真的复现载体）
- 复现对象：`examples/ili9325/test/fixtures/HAL_06_LCD.bin`（CT117E-M4 的 Keil HAL 示例固件，
  10,804 字节，初始 SP = `0x20000418`，复位向量 = `0x080001ED`，主频 80 MHz）

图例：✅ 已修复 · 🔄 部分修复 · ⏳ 未开始

优化后的执行期深挖、动态热点与四类性能窗口归因见
`docs/stm32g431rbt6-execution-bottlenecks.md`。

## 0. 测量口径

**主路径是 `execution: 'throughput'`**（运行时默认值，启用直接后端）。本文所有性能读数都按这条
路径测量，固件是真实工程产物，不用合成夹具：

| 维度        | 取值                                                                           |
| ----------- | ------------------------------------------------------------------------------ |
| 固件        | `HAL_06_LCD.bin`：Keil 工程产物，复位后跑完时钟树、GPIO、USART、ILI9325 初始化 |
| 外设覆盖    | RCC、PWR、Flash 取指、GPIOA–E 写、USART1、SysTick 中断、NVIC、多次 `HAL_Delay` |
| 板级        | 裸 MCU（只接 VDD/VSS）：去掉 LCD 与探针，只测 MCU 自身                         |
| 主频        | 80 MHz —— 固件自己配的主频，`HAL_Delay` 的换算依赖它                           |
| `execution` | `throughput`（对照表另给 `precise`）                                           |
| 计时        | 进程 CPU 时间，三轮取最小值；轮间波动约 ±10–20%                                |

窗口分两段：**冷启动** 0 → 200 µs（复位、PLL 切换、外设初始化、进入第一个 `HAL_Delay`）；
**稳态** 200 µs → 220 ms（SysTick 周期中断、多次延时、LCD 初始化写序列）。

入口：`examples/stm32g431rbt6/bench/hal-throughput.test.ts`（主路径）与
`bench/hal-precise.test.ts`（对照）。两者分开成文件，因为器件的翻译缓存是模块级的，同进程里
先跑完一种模式会把缓存焐热，冷启动读数就不可信了。

## 1. 正确性缺陷

真实 HAL 固件把 MCU 模型从「能跑小程序」推到「跑完整 BSP 初始化」，以下缺陷按暴露顺序列出。

| #   | 缺陷                                           | 症状                                                                                                       | 位置              | 状态 |
| --- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ----------------- | ---- |
| 1   | 32 位指令前缀只判 `0xE800`/`0xF000`            | `ldr.w sp`（`0xF8DF`）被当 16 位解码，PC 前进 2 字节后在向量表里执行数据                                   | `core/decode.ts`  | ✅   |
| 2   | JIT 缓存键用 `pc & 0x1ffff`                    | `0x000001D8` 命中 `0x080001D8` 的块，报 `Translated first pc does not match`                               | `index.ts`        | ✅   |
| 3   | `ADD rd, SP, #imm`（`0xA800–0xAFFF`）误写 SP   | `add r0, sp, #56` 顶高栈指针，`pop {pc}` 弹出 0                                                            | `core/thumb16.ts` | ✅   |
| 4   | `ldm/stm` 忽略 W 位（bit5）                    | `__scatterload` 的基址被无条件写回，表指针错位后跳进向量表                                                 | `core/thumb32.ts` | ✅   |
| 5   | 缺 `lsl/lsr/asr/ror` 寄存器移位（`0xFA00`）    | 移位类型位（h1 bit6..5）与操作数方向（Rn 为被移位值）都写错，`lsrs.w` 被当 `lsl.w`，`HAL_GPIO_Init` 不退出 | `core/thumb32.ts` | ✅   |
| 6   | 缺 `ldrd/strd` 立即数（`0xE940`）              | `SystemClock_Config`、`MX_GPIO_Init` 处 halt                                                               | `core/thumb32.ts` | ✅   |
| 7   | `PWR->SR2` 无合成读回                          | `HAL_PWREx_ControlVoltageScaling` 轮询 `VOSF` 永不结束                                                     | `core/pwr.ts`     | ✅   |
| 8   | 服务块被重复派发会重复产生效果                 | `SERVICE_WRITE` 连续执行两次，同一字节被 `startByte` 两次 → UART 发布 `4f 4f 4b 4b`                        | `index.ts`        | ✅   |
| 9   | 延迟读的字访问未忽略字节偏移                   | `readIdrDeferred` 对 size=4 仍按 `offset & 3` 移位，与内联路径的 `extract` 语义不一致                      | `core/gpio.ts`    | ✅   |
| 10  | `exceptionReturn` 走完整访存分派（文档旧结论） | 实际上 `nvic.ts` 的 `stackLoad`/`stackStore` 只判 SRAM/CCM，从未调用通用分派；原文档结论已更正             | `core/nvic.ts`    | ✅   |

第 8 条是本轮新增延迟服务时引入并修复的，其余为一轮之前或本轮修复的历史缺陷。第 8 条留下
一条设计约束：**任何延迟服务块都必须以登记位做幂等保护**，先清标志再产生效果。

## 2. 吞吐性能

### 2.1 根因（按影响排序）

| #   | 根因                                                                     | 位置                 | 状态 |
| --- | ------------------------------------------------------------------------ | -------------------- | ---- |
| 1   | 常量地址的访存也发射完整区间分派树（`ldr [pc,#imm]`、`push`/`pop`）      | `core/memory.ts`     | ✅   |
| 2   | GPIO IDR 在每条指令块内逐脚组包（16 脚 × `readSample`+`field`+`select`） | `core/gpio.ts`       | ✅   |
| 3   | 非 GPIO 外设写的「读改写」链在块内展开，动态地址每条 `str` 重复一遍      | `core/bus.ts`        | ✅   |
| 4   | 每条指令一次 JIT 派发（generator 创建 + 2 次 `next` + 2 次边界）         | `index.ts`           | ✅   |
| 5   | IT 包装给每条指令套三段 `if` + 7 层 `select`                             | `core/decode.ts`     | ✅   |
| 6   | 引脚意图的 `select` 链（每脚约 145 op）                                  | `core/gpio.ts`       | ⏳   |
| 7   | 服务判定为每条指令读 9 个 state（4 个延迟请求 + `irqDirty` + `primask`） | `index.ts` 的 `tick` | ✅   |

根因 4、5、7 是同一类：**每条指令的固定开销**。三者的处理相互耦合，实现见 2.4。

### 2.2 实测（真实固件，裸 MCU，80 MHz）

| 指标                        | `throughput`（主路径） |
| --------------------------- | ---------------------- |
| 0 → 200 µs 冷启动           | 约 361–365 ms CPU      |
| 200 µs → 220 ms 稳态        | 约 605–630 ms CPU      |
| 稳态实时倍率                | 约 0.35–0.36×          |
| 整段 220 ms（含冷启动）     | 约 967–995 ms          |
| 缓存指令块                  | 411                    |
| 直接程序数 / 整程序重编译数 | 1 / 21                 |
| 直接回退次数（整段）        | 5,041                  |

`precise` 仅保留为同一固件的对照路径，其耗时随宿主和 V8 状态漂移；精确值以
`bench/hal-precise.test.ts` 的输出为准，不在文档中重复维护。

同一份固件的 `gpio-blink` 对照（`bench/perf.test.ts`，1 MHz、500 ms 仿真、交付产物）：
稳态墙钟 **3 ms**、`direct: true`、`programs: 1`、12 个块。

`ili9325` 的 MCU + LCD 联合仿真已改为默认 `throughput`，用例通过（约 6.7 s；200 µs 的窗口里
冷启动占大头，见 2.3）。

### 2.3 冷启动是当前最大短板

`throughput` 的直接后端首个 200 µs 仍会翻译 411 个块并触发 21 次程序修订，但已按 PC
缓存 `Instruction`，并让已生成的 shard 函数跨程序修订常驻；修订只生成小型 dispatcher 和受影响的
开放尾 shard。成本主要留在首次设备 Thumb 翻译、IR builder、校验、compiledBody 生成以及 V8
首次优化与 GC。发布口径冷启动约 0.36 s，后续要把差距继续压向 1×，需要优化设备块首次翻译链路。

### 2.4 已实施的优化

- **指令批处理**：`collectBatch` 把最多 8 条连续指令发射进**同一个块体**，块尾只 `elapse` 一次。
  三条收块规则：写 pc 的指令之后收块（`decode.ts` 的 `endsBatch`）；自旋 `b .` 与忙等循环头
  独占或收尾一个块（否则直接后端的轮次折算失效）；不在 IT 块中间收块。
- **pc 守卫表达「已离开顺序路径」**：每条指令前把 `pc` 复位成它的顺序后继。分支/异常返回写成
  目标、服务块接手写成服务 PC，两者都让下一条之前的守卫（`pc == 后继`）停掉批内剩余指令；
  停机路径把 `pc` 留在故障指令，批次不再逐条读取 `halted`。`tick` 继续把 `pc` 当作服务返回位置。
- **IT 守卫静态化**：`decode` 给出 `itCount`，批处理静态跟踪 IT 掩码，只有真正受 IT 控制的指令
  才读 `itState` 并发射条件选择链；普通指令不再为 IT 付三次 `if` 与 7 段 `select`。
- **服务判定归并**：新增 `serviceMask`（GPIO 写 / IDR 读 / 外设写 / 引脚刷新 / 中断待扫描），
  中断位是 `irqDirty && primask == 0` 的镜像；`tick` 快路径从 9 次 state 读降到 3 次。
- **单槽延迟状态逐条取走，时间条件推到批尾**：`gpioWrite*`、`deferRead*`、`deferWrite` 必须在
  同一块之后立即被服务块取走，否则「写寄存器 → 读 IDR」的顺序会变；`pendingPs >= tickPs` 则
  只判批次末条，推迟量最多「批内指令数 − 1」个周期（80 MHz、8 条一批时 < 90 ns）。
- **延时环折算计入服务累加器**：`delayLoops` 折算是直接后端把整圈 `subs/bne` 折成一次时间推进，
  但它只推进 `frame.time`、不写 `pendingPs`。本器件的外设按累加器计时，因此声明的延时环现在
  带 `pending`：折算停在下一次服务边界，并把折叠掉的时间记进 `pendingPs`，SysTick/USART 不会
  因为跳过轮次而饿死（`packages/compiler/src/direct-jit.ts` 的 `delayLoops` 发射、
  `packages/simulator/src/runtime/jit.ts` 的映射）。
- **直接程序复用**：直接程序暴露它编译过的 PC 集合（`DirectProgram.pcs`）。翻译只增不改，所以
  旧程序对所有已覆盖的 PC 仍然有效，只有缺失 PC 或攒够步长才重建。

### 2.5 剩余瓶颈与下一步

| #   | 事项                                         | 影响                                                                | 位置                         |
| --- | -------------------------------------------- | ------------------------------------------------------------------- | ---------------------------- |
| 1   | GPIO 写服务与引脚意图同步                    | 仍是 220 ms 内约 109 万次的热路径；端口快照与电气 helper 占主要成本 | `core/gpio.ts`、`index.ts`   |
| 2   | 首次设备块翻译、IR builder 与校验            | 冷启动 0 → 200 µs 的主要成本                                        | `index.ts`、`core/**`        |
| 3   | 每 guest 指令的 `tick` / `serviceMask`       | 高频固定热路径成本                                                  | `index.ts`                   |
| 4   | `SERVICE_WRITE` / IDR 与动态基址多寄存器访存 | 主要放大首次翻译和生成源码体积                                      | `index.ts`、`core/memory.ts` |

当前 411 个可编译块共约 310,231 个含嵌套 IR 操作、186,350 条发射语句、约 5.4 MB 生成源码。
块级 Instruction 缓存、frame DataView、稳定 bank 布局和 146 路区间树 dispatcher 已实现。

## 3. 已知限制

这些不是缺陷，但会直接影响使用方式，必须知情：

- **直接后端要求板上只有一个 JIT 设备**：`runDirect` 在 `board.jits.length !== 1` 时直接关闭
  （`packages/simulator/src/runtime/jit.ts`）。多 MCU 的板会静默退回解释器路径。
- **批内时间条件推迟到批尾**：`pendingPs >= tickPs` 只在批次末条判断，最多晚「批内指令数 − 1」
  个周期（80 MHz、8 条一批 < 90 ns）。SysTick 与中断的**取走位置**最多晚一个批次；`systick`
  夹具的 8 次翻转时序不变。
- **批内 pc 改写会跳过剩余指令**：服务块、分支、异常返回把 pc 改写成非顺序后继时，批内剩余
  指令不执行，由下一次派发在正确的 pc 上继续。正确性由此保证，代价是冷启动多翻译几个块。
- **批大小上限 8 条**。批体是单个 `InstructionIR`，直接后端无法在 body 内再分片，而 V8 从约
  35 KB 生成源码起停止优化；8 条一批在现有块体积下安全。
- **IDR 在指令之后的下一个同步点采样**，不是块内采样。对「拉低 RD → 边界 → LCD 驱动 → 读 IDR」
  更贴近硬件；对「每条指令都读 IDR」的极端轮询循环，`precise` 下比内联慢约 30%。
- **HAL_Delay 快进依赖可识别的轮询形态**：当前模型只识别本固件中指向 SRAM tick-word 的
  `bl HAL_GetTick; subs; cmp; bcc` 形态。其他等待循环继续逐指令执行；`delayLoops` 折算仍须
  带 `pending`，让折算时间同时记进服务累加器（见 2.4）。

## 4. 工具链与环境问题

| #   | 问题                                                                                                          | 影响                                                    | 状态 |
| --- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ---- |
| 1   | Node 20 无法构建：`chevrotain` 依赖 `Object.groupBy`（Node 21+），而 `engines` 声明 `^20.19.0 \|\| >=22.12.0` | 默认 Node 20.20 下 `mica build` 直接失败                | ⏳   |
| 2   | corepack 校验 `pnpm@12.14.0` 签名失败（`Cannot find matching keyid`），缓存内该版本也不完整                   | `.husky/pre-commit` 的 `pnpm exec lint-staged` 跑不起来 | ⏳   |
| 3   | `pnpm-lock.yaml` 的 `importers` 双方都在插入 `examples/*`                                                     | 变基到 `origin/main` 时必然冲突，需按字母序手工合并     | ⏳   |

规避方式（当前工作区可用）：用 `~/.nvm/versions/node/v24.20.0` 运行构建与测试；提交前手动执行
`./node_modules/.bin/lint-staged`，再以 `HUSKY=0 git commit` 提交。

## 5. 验证清单

```bash
# MCU 示例
cd examples/stm32g431rbt6
./node_modules/.bin/mica build
./node_modules/.bin/tsc --noEmit          # 需先 mica prepare
./node_modules/.bin/vitest run --config vitest.config.ts        # 15 个用例
./node_modules/.bin/vitest run --config vitest.perf.config.ts   # 三个基准

# LCD 示例与联合仿真（联合仿真走默认 throughput）
cd ../ili9325
./node_modules/.bin/vitest run --config vitest.config.ts        # 17 通过 / 1 跳过
MICA_JOINT=1 ./node_modules/.bin/vitest run --config vitest.config.ts test/joint.test.ts

# 引擎侧（改动 direct 后端或 JIT 运行时后必跑）
cd ../../packages/compiler && node --test tests/*.test.mjs
cd ../simulator && ./node_modules/.bin/vitest run
```

当前读数：`stm32g431rbt6` 15 通过；`ili9325` 17 通过 + 1 跳过；联合用例 1 通过（约 6.7 s，
`throughput`）；`gpio-blink` 500 ms 仿真墙钟约 3 ms（`direct: true`、`programs: 1`、12 个块）；
HAL 裸板 80 MHz 的性能范围见 2.2，精确值以基准 stdout 为准。
