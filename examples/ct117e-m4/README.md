# CT117E-M4 单器件融合板

`ct117e-m4` 将 STM32G431RBT6、ILI9325 和板载输入输出器件合成**一个实例、一个 MCU JIT**。
内部接线以 [`ct117e-m4.netlist.json`](ct117e-m4.netlist.json) 的引脚列表为准，不需要在
宿主中装配分立器件。

- 器件 ID：`example:ct117e-m4`
- 源码：`src/{model.ddl,model.ts,mcu.ts,lcd.ts}`
- 构建产物：包根 `dist/{package.json,model.js,release.json}`
- 参考固件：`HAL_06_LCD.hex`（测试夹具位于 `examples/devices/bench/stm32g431rbt6`；
  统一模型从 `ctx.props.firmware` 接收 `MemoryProgram`）

## 构建与检查

需要 Node.js 24（仓库当前使用 Node 24.20.0）。

```bash
cd examples/ct117e-m4
pnpm build        # 生成热函数 IR，然后 mica build
pnpm typecheck    # 生成热函数 IR、DDL 类型，然后 tsc --noEmit
pnpm test         # 构建并运行正确性测试
pnpm bench        # 构建并运行六轮基准
```

`pnpm test` 会先构建，再由融合宿主校验并装载 `dist/` 发布包；测试不会退回 `src/`，
也不会在测试里重新编译 CT117E-M4 的 DDL。

本工程本地保存 LCD 模型、适配器、融合变换和热函数展开器；MCU 内核来自工作区包
`@mica-js/stm32g431rbt6-core`（`examples/stm32g431rbt6-core`，`workspace:*` 开发依赖），
与器件库 `examples/devices` 中的 STM32G431RBT6 器件共用同一份 Thumb 译码、总线/内存布局与外设模型。该包对外
提供 `/bus`、`/cpu`、`/decode`、`/gpio`、`/ir`、`/layout`、`/machine`、`/memory`、
`/nvic`、`/pwr`、`/rcc`、`/register-facts`、`/systick`、`/thumb16`、`/thumb32`、`/tick`、
`/usart` 子路径；`mcu.ts` 通过 `/layout`、`/ir`、`/decode`、`/machine`、`/gpio`、
`/memory`、`/systick`、`/usart`、`/nvic`、`/register-facts` 引用内核，只保留本器件的
属性、复位值与 JIT 编排。

`scripts/prepare-model.mjs` 在构建期校核网表端点、分配内部线号，将
[`examples/devices`](../devices) 中 AT24C02 / MCP4017 的 I²C 状态机、MCP4017 的
滑臂电阻公式和 74HC573 的数据解码融合进本地 DDL。锁存时机、固定接线和模拟输入
由板级 DDL 实现。生成的 `board-model.ddl`、`board-wires.ts`、`hot-model.ts`
不提交；`mica build` 将模型和共享 MCU 内核打包进自包含的 `model.js`，运行时不加载器件库。

## 统一模型接口

| 方法                    | 参数 / 结果                                    |
| ----------------------- | ---------------------------------------------- |
| `setButton`             | `{ id, pressed }`，`1–4` 对应 B1–B4            |
| `setReset`              | `true` 按下板载 RESET，`false` 释放            |
| `setPotentiometer`      | `{ id, position }`，`1 = R37`、`2 = R38`       |
| `setTimerPotentiometer` | `{ id, position }`，`1 = R39/U7`、`2 = R40/U8` |
| `getLedState(null)`     | 点亮位掩码，bit 0 为 LD1，bit 7 为 LD8         |
| `readEeprom(null)`      | AT24C02 的 256 字节独立快照；固件通过 I²C 写入 |
| `getWiper(null)`        | MCP4017 的滑臂码 `0–127`                       |
| `getFramebuffer(null)`  | 最近合成的整屏快照                             |

控制方法将输入排入模型，随仿真推进生效。`position` 从低端到高端取 `[0, 1]`，默认 `0.5`。
调频位置在下一半周期生效。

`firmware` 属性由清单声明为 `program`（`loader: memory`），工厂拿到的是按 `flash`
地址空间解析后的只读 `MemoryProgram`；模型 IR 不声明同名 DDL 属性。`mcu.ts` 在初始化时把镜像段映射到
`code` 内存，并拒绝未知地址空间或越界段。

## 融合宿主

正确性测试和基准均通过 `@mica-js/sdk/fused` 的 `createHeadlessRuntime` 从发布包运行器件。
原始 HEX 由宿主的 `program` loader 解码，帧从 `onDidFramebuffer` 接收，整屏由
`getFramebuffer` 读取。夹具只观察底层仿真状态来校验计数及内存，不用旧宿主重新运行器件。

## 接线与运行设置

- 外部供电接 **VDD1 = 3.3 V、VSS1 = 0 V**。外部 `NRST` 与板载 RESET 共用低有效
  `LCD_RST`：按下时 CPU 停止，释放时 MCU 从向量表重启、LCD 清屏；锁存器、
  EEPROM、MCP4017 和 555 不随 MCU 断电或复位。
- MCU 与 LCD 的固定接法：`D0–D15 = PC0–PC15`，`WR = PB5`，`RS = PB8`，
  `CS = PB9`，`RD = PA8`。
- PD2 驱动 U1 的 LE，`LCD_D8–D15` 共用为 U1 数据输入，`OE# = GND`；
  LD1–LD8 由 Q 端灌电流，低电平点亮。B1–B4 依次接 PB0、PB1、PB2、PA0，按下为低。
- U2（`0x50`）与 U3（`0x2F`）共用 PB6/PB7 的软件 I²C（SCL/SDA）。
  PB6 不是 STM32G431 的硬件 I²C1 SCL。模型使用理想上拉、开漏下拉和即时 EEPROM
  写入，不模拟竞争、传播延迟或写周期等待。
- R37 经 J11 接 PB15/ADC2_IN15，R38 经 J12 接 PB12/ADC1_IN11。U3.W 经 J15 接
  PB14/ADC1_IN5，与 R17（10 kΩ 上拉）和 J16 接地的 U3.B 构成分压。
- U7/R39 经 J9 接 PB4/TIM3_CH1，U8/R40 经 J10 接 PA15/TIM2_CH1。两路使用
  OUT 经电阻回到 TRIG/THRES 的拓扑，DISCH 不参与；各自融合为理想方波振荡器，
  半周期为 `ln(2) × (100 Ω + position × 10 kΩ) × 100 nF`，不模拟模拟斜坡或上电瞬态。
- J9、J10、J11、J12、J15、J16、J17 按闭合建模。无跳线操作、电源瞬态、LED
  电流或亮度求解。
- `clockFrequency` 是模型的时间基准，必须与固件实际配置的主频一致；本固件为
  80 MHz。它不是自动从 RCC 寄存器反推的值。
- `refreshRate` 默认 60 Hz，控制脏矩形合帧发布的最大频率。
- 融合宿主为每次会话设定固定步长，在暂停状态下通过 `step()` 推进。
- `execution` 使用默认的 `throughput`（直接后端）；本示例没有单独维护 precise 路径。

## 输出事件

- `onDidFramebuffer`：载荷为 `Uint8Array`。开头是 8 字节小端矩形头：
  `x:u16, y:u16, width:u16, height:u16`；随后是 `width × height` 个
  **RGB565 小端**像素，行优先。总长度必须等于 `8 + width × height × 2`。
  每次发布的是一个合帧脏矩形，不保证是整屏；坐标以 320×240 面板为准。
  `getFramebuffer` 返回最近合成的整屏快照。
- `onDidFault`：`number`。MCU 模型报告的故障通知；载荷语义沿用 MCU 子集。
- `onDidSerial1Tx`、`onDidSerial2Tx`、`onDidSerial3Tx`：`number`。从 MCU 子集继承的
  USART 发送字节；没有发送活动时不会发布。
- `onDidLed`、`onDidWiper`：`number`，分别发布变化后的点亮位掩码和滑臂码。

`onDidFramebuffer` 的矩形可能重叠或只覆盖局部区域，消费方应按顺序合成；没有脏像素时不会
发布空帧。

## 测试覆盖

`test/device.test.ts` 是正式交付产物用例：

- 校验 `dist/` 发布包并创建**单个**实例、一个 JIT；
- 严格解析 `examples/devices/bench/stm32g431rbt6/HAL_06_LCD.hex`，按 80 MHz 从复位推进到 220 ms / 440 ms；
- 固定工作量：220 ms 为 80 次 WR 电平变化，未写 GRAM 或发帧；360–390 ms 为
  **104,338 次 WR 变化、52,169 次 GRAM 写入、2 帧**。到 440 ms 共 157,338 次 WR 变化、
  77,351 次 GRAM 写入、3 帧、76,800 个非零像素；
- 宿主停在预期步进终点，且无诊断或 fault；
- 最终 GRAM、寄存器文件、逐帧内容、精确 `frameInfo` 时间以及 MCU 状态/内存摘要
  与分立 `examples/devices/test/ili9325/joint-harness.ts` oracle 对账；宿主事件时间另按步进终点校验；
- MCU 对账按各自布局读取 FLASH_ACR 的等待周期；无延迟读待处理时，不对比已失效的地址暂存值；
- 额外用独立总线 oracle 核对 MCU intent 计数、像素写次数与最终图像。

oracle 只在正确性用例中运行，不进入任何性能计时。它依赖兄弟 example 的测试夹具，
这是**测试依赖**，不是器件运行时的依赖。

`test/firmware.test.ts` 覆盖 HEX 解析器的记录格式、校验和、地址范围、EOF、重叠冲突
和不支持的记录类型。
`test/fused-runtime.test.ts` 另检查一步推进到 440 ms 时的事件交付与整屏查询。
`test/board-io.test.ts` 用板载 I/O 固件在发布包上验证按键、共享 LCD 总线锁存、
软件 I²C、ADC、双路捕获/调频，以及共享复位时的状态保留。

测试默认读取 `examples/devices/bench/stm32g431rbt6/HAL_06_LCD.hex`（与器件库的 STM32
基准共用同一份夹具）；如果夹具放在别处，可设置：

```bash
MICA_CT117E_M4_HEX=/path/to/HAL_06_LCD.hex pnpm test
```

期望的解析后 Flash 映像 SHA-256 为
`673d0b78c9376e0bae99761b6285cc2d2e00b3d44c6eefb7cf040a2992945650`，
长度为 10,804 字节，覆盖 `[0x08000000, 0x08002A34)`。夹具缺失或映像不一致时测试
会直接失败，而不是换用另一版固件。

## 基准

`bench/ct117e-m4-perf.test.ts` 只测正式构建产物的单 instance：

- 0 → 10 ms 为冷启动（装载发布包、建板及首个步进），10 → 220 ms 为 active，
  220 → 440 ms 为 post；在 post 内单独计时 **360–390 ms 清屏窗口**；
- 六轮独立建板，固定 10 ms 步长。报告各轮 CPU 与墙钟，以末五轮报告
  清屏墙钟中位数、最小值、最大值和达到 **≤30 ms** 实时预算的轮数；
- 在计时之外校验窗口和 440 ms 工作量、最终非零像素与无故障；
- 不安装逐 intent oracle 或 CPU 采样；采样另跑，只用来定位。

运行：

```bash
pnpm bench
```

stdout 输出 `CT117E_M4_PERF` 逐轮数据、`CT117E_M4_CLEAR` 暖轮汇总和
`CT117E_M4_REPORT` 临时目录；`readings.json` 保存这些读数、宿主类型和固件身份。
性能改动以同机、同工作量、无探针的正反序 A/B 判断。

最新瓶颈结论、分片预算和最终 PC 回读的对照结果见
[LCD 清屏性能阶段报告](docs/lcd-clear-performance.md)。

### 融合宿主首轮基线（2026-11-19）

Node 24.20.0、CPU 亲和性 `8,10,12,14`，关闭采样。五个暖轮清屏墙钟中位
**30.458 ms**，范围 **29.048–69.832 ms**，**2/5** 轮达到 30 ms；六轮的清屏和
440 ms 工作量均通过校验。这组读数用于后续同宿主对照，不用于判定迁移前后的快慢。

### 历史清屏基线（2026-11-19，旧板级夹具）

以下实验是切换到融合宿主前的历史读数。虽然清屏窗口和工作量未变，宿主调用路径和
从复位到清屏的步进序列已改变，不应直接用这些数字判定新版宿主的性能回退或加速。

Intel Core i7-12700K、Node 24.20.0，CPU 亲和性 `8,10,12,14`。五个暖轮墙钟中位
**33.275 ms（0.902× 实时）**，范围 **28.741–73.615 ms**，仅 **2/5** 轮达到 30 ms。
该轮次不含采样；读数波动意味着不能用单轮最好成绩验收。

另跑五轮 CPU 采样：生成分片自身占 **46–54%**，生成的外层 `run` 派发自身占
**13–19%**。`runDirect` 的调用位置还归入了一部分时间，可能包括已内联的代码，
不据此计算可消除的运行时开销。明确归入发布、状态提交的栈不到 1%。热点分片的源码位置中，
重复的时间/截止点及后继检查、guest store 的独占监视器有效位读取反复出现；16 位
`dataBus()` 重组只占三个热点分片位置样本的约 **3–4%**，该比例不是独占墙钟。
独立计数显示该窗口新增翻译和编译均为 0，宿主调用 direct 72 次、回退 62 次。

### 跨分片直达实验（未保留）

候选在外层 `run` 中为每个源分片最多挑两个已翻译后继，只有返回 PC 精确命中才额外
直调一次；其余仍走原派发。不改分片本体，不特化固件地址。

同机、同固件、同一构建产物下按 A → B → B → A 顺序运行正式基准；每组六轮工作量一致。
下表只计各组末五轮的 360–390 ms 清屏窗口，单位为墙钟 ms：

| 顺序   | 暖轮中位 | 暖轮范围      | ≤30 ms |
| ------ | -------: | ------------- | -----: |
| A 基线 |   31.953 | 28.719–71.950 |    2/5 |
| B 直达 |   28.071 | 28.028–72.597 |    3/5 |
| B 直达 |   34.057 | 28.261–71.623 |    1/5 |
| A 基线 |   33.596 | 28.773–73.755 |    1/5 |

合并十个暖轮，墙钟中位仅从 33.193 降至 32.666 ms，达标率从 3/10 到 4/10；
首组收益未在反序复测复现，候选已撤回。

另在基线上给 Vitest worker 开启 V8 `--trace-opt --trace-deopt`，只作诊断。
两个约 78–80 ms 的慢暖轮里，窗口内各记录到 14 次开始优化以及 9–10 次去优化，
涉及热点分片的 `wrong map`、反馈不足和重编译；约 29 ms 的最快暖轮没有这些事件。
这说明模拟器的翻译与编译计数不变，并不等于 V8 已完成分层优化。事件重合不能直接
量化因果。

在相同基线上用 V8 字节码偏移和详细去优化位置对照生成源码：`stepShard126/127` 的
入口偏移 `0` 是 `F.states` 读取；`stepShard124 @13509` 和 `stepShard127 @17162`
落在 `F.due >= deadline`；`stepShard126 @18218` 的详细位置落在截止点分支的
`F.resume` 写入。另有首次进入 LCD 脏矩形分支时的状态槽反馈不足。

尝试在执行帧创建时初始化 `publishPending` 和 `stopAfterInstruction`，不改发布或
截止点逻辑。诊断跑不再出现三个热点分片的 `wrong map`，但截止点和 LCD 冷分支
仍会触发去优化。无探针 A → B → B → A 的暖轮墙钟中位分别为 **30.119、33.582、
34.184、34.072 ms**；各组六轮工作量一致。合并十个暖轮后，中位由 32.491 增至
34.081 ms，双方均只有 3/10 轮达标，因此撤回候选。

### 截止点慢路径外移实验（未保留）

候选仅改宿主 resident 分片：原有截止点和待发布判断仍在分片内，挂起时才调用共享
慢路径。捕获值依旧来自发布前，续跑槽依旧在发布未获准后保存。非 resident 路径不变。

无探针 A → B → B → A 的五暖轮墙钟中位分别为 **29.459、39.140、42.298、30.268 ms**。
每组六轮工作量一致；合并十个暖轮，中位由 29.864 增至 40.719 ms，范围由
28.422–72.307 变为 28.649–73.278 ms，达标从 5/10 降为 4/10。候选已撤回。

另跑 V8 trace：`stepShard127` 仍在截止点判断处去优化；`stepShard124 @9540` 落在
共享调用实参的捕获数组写入，`stepShard126` 的详细位置落在读取 `H.checkpointElapsed`，
对应的恢复偏移仍是截止点比较。外移没有消除热点分片的去优化。trace 仅作诊断，不纳入 A/B。
编译器回归覆盖发布获准与被拒、捕获值和续跑槽的保存时机，以及截止点相等不执行后缀；
撤回后基线编译器测试 **100/100**、电气 JIT 回归 **14/14** 通过。

### 分片复用本地截止时间实验（未保留）

候选仅改宿主 resident 分片：用刚算出的本地 `due` 比较截止点，不再让待发布标志
短路这次比较。宿主仍能读取 `F.due`，发布后的复核仍读取实时帧。

无探针 A → B → B → A 的五暖轮墙钟中位分别为 **30.372、33.210、31.887、29.823 ms**。
四组使用同一部署产物，各组六轮工作量一致。合并十个暖轮，中位由 30.310 增至
33.039 ms，范围由 28.711–73.791 变为 28.606–73.331 ms，达标从 4/10 降为 2/10。
候选已撤回。

诊断中，原来的截止点比较不再是这三个分片报告的去优化位置，但首次挂起时仍在
`F.resume` 写入和 `L[0]` 续跑槽写入处去优化；LCD 脏矩形状态槽的去优化也仍出现。
`L[0]` 对应的指令没有延时后缀，恢复时无需读取这些临时值。

### 省去空后缀的续跑槽实验（未保留）

候选只让宿主 resident 分片在没有延时后缀时省去临时值的保存与恢复，不改截止点或发布逻辑。
无探针 A → B → B → A 的五暖轮墙钟中位为 **31.582、31.390、30.293、33.874 ms**，
四组六轮工作量一致。合并十个暖轮后，中位由 32.538 降至 30.842 ms，最慢由 87.297
降至 69.982 ms，但两边都只有 4/10 达标。窗口仍有约 70 ms 的慢轮，暂不保留候选，
先区分模拟执行和 V8 分层产生的开销。

### V8 分层诊断

用 Node 24.20.0 在同一构建产物上分记模拟执行线程 CPU、进程 CPU 和墙钟。诊断不参与
正式性能验收；不设置 `MICA_CT117E_M4_THREAD_CPU` 时，基准不采执行线程 CPU。

```bash
env -u NODE_OPTIONS MICA_CT117E_M4_THREAD_CPU=1 taskset -c 8,10,12,14 \
  node node_modules/vitest/vitest.mjs run --config vitest.perf.config.ts \
  --no-cache --reporter=verbose --disableConsoleIntercept bench/ct117e-m4-perf.test.ts
```

在 `run` 后分别加 `--execArgv=--no-maglev`（保留 TurboFan）或 `--execArgv=--max-opt=1`
（最高只到 Sparkplug），再回到默认配置。`CT117E_CLEAR_CPU` 的 `otherThreadsMs`
是进程 CPU 减执行线程 CPU，包含其他线程的所有活动，不能全算成编译。
`wallMinusForegroundMs` 近似反映执行线程未占用 CPU 的时间，不能区分被抢占和阻塞。

同机、同固件和同一 `dist/model.js` 的四组六轮工作量一致。下表只统计末五个暖轮，
默认两组按清屏墙钟 45 ms 分开汇报；单位为 ms：

| 配置           | 暖轮 |           墙钟中位（范围） | 执行线程 CPU 中位 | 其他线程 CPU 中位 |
| -------------- | ---: | -------------------------: | ----------------: | ----------------: |
| 默认，<45 ms   |    6 |    30.335（29.472–42.321） |            30.436 |            13.380 |
| 默认，≥45 ms   |    4 |    81.129（78.243–87.317） |            79.864 |           100.824 |
| 关闭 Maglev    |    5 |   43.055（31.298–111.747） |            43.164 |            23.923 |
| 最高 Sparkplug |    5 | 380.436（376.699–386.126） |           379.816 |             2.933 |

默认慢轮多花的约 50 ms 主要消耗在**执行线程**，不是它等待后台线程。关闭 Maglev
没有消除长尾，只保留 Sparkplug 则远超预算。另开 `--trace-opt --trace-deopt
--trace-gc-nvp` 复核：最慢暖轮执行线程用 79.327 ms，窗口内启动 16 次优化、去优化
9 次，包括三个热点分片和外层 `run`；本次六个窗口均未记录 GC 暂停。约 30 ms 的
三个暖轮没有去优化。trace 只用于定位，不与无 trace 的墙钟混用。

首要瓶颈是热点生成代码在清屏窗口尚不能稳定保持优化层级。慢轮额外的执行线程时间
不能全算成去优化开销；它也包括在较低层级执行同一工作量的时间。即使没有记录到
去优化，快轮也要约 29–30 ms，几乎没有预算余量；后续仍需降低分片和派发的执行成本。

### 历史整程读数（2026-11-15，Node 24.20.0）

| 轮次 | 冷启动 CPU / ms | active CPU / ms | post CPU / ms | 总 CPU / ms | 总墙钟 / ms |
| ---- | --------------: | --------------: | ------------: | ----------: | ----------: |
| 1    |        5711.121 |        1696.914 |       200.539 |    7608.574 |    4803.857 |
| 2    |         209.898 |         644.505 |       206.970 |    1061.373 |     546.479 |
| 3    |         114.511 |         481.314 |       134.181 |     730.006 |     366.631 |

首轮包含首次翻译和 V8 预热。这组存档采用旧工作量和分窗，不能与当前清屏窗口直接比较。

## 适用限制

- **固定 3.3 V、RST 恒高、单主机、理想数字总线**。LCD 数据读回要求 MCU 释放数据
  总线；模拟竞争、电阻强弱、浮空/模拟电平和任意外部接线不在本示例的验证范围内。
- **不是完整 CT117E-M4 开发板**。不包含按键、LED、蜂鸣器、继电器、EEPROM、温度
  传感器等板载外设，也不模拟它们的接线。
- **共享内核的 MCU 子集**：Cortex-M4 Thumb/Thumb-2 指令、GPIO、RCC、PWR（时钟配置
  所需）、SysTick、NVIC、USART1–3 发送/接收、128 KiB Flash、22 KiB SRAM、10 KiB CCM
  SRAM；LCD 侧为 16 位 8080 并口、窗口寻址、GRAM 与 RGB565 帧发布。
- **fused profile 不启用新增外设模块**：ADC、TIM、I²C、SPI、EXTI、UART4/LPUART1、
  FDCAN、UCPD 等只在独立 `example:stm32g431rbt6` 的 `PERIPHERALS` 中注册；USB/FPU
  本轮不提供。
  ct117e 的 `FUSED_PERIPHERALS` 为空，避免把需要独立引脚或模拟量的 IR 展开进只接受
  `FUSED_WIRES` 数字电平的 fused 模型；这些外设在本示例中明确未接入，不是“寄存器
  可写即已支持”。逐项状态见 `examples/devices/docs/stm32g431rbt6-status.md`。
- 器件运行时只接收解析后的 `MemoryProgram`，不读取 HEX/BIN 文件；文件解析由宿主负责。
- 本示例不能用来证明任意 CT117E-M4 固件或任意外部接线都与真实硬件等价；它只覆盖
  上述固定接法和 MCU 子集。
