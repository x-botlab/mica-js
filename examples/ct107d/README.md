# CT107D 整板示例（融合器件 + legacy 板面）

CT107D 竞赛板的 Mica 示例工程。**正式运行模型是 `device/` 下的统一融合器件**：
一个 `DeviceIR`、一个实例、一个 8051 JIT，外部只保留 `VCC`/`GND`，历史 54 个器件加
J5 独立/矩阵选择器（共 55 个实例）和 111 条网络都折叠为器件内部槽。`src/widgets`、`ct107d.sch`、`ct107d.cnv` 继续保留为
legacy 板面展示与编辑资料，不参与融合运行时；本次工作不新增/迁移 widget。

工程位于仓库的 `examples/ct107d`，纳入 pnpm workspace（包名 `@mica-js/example-ct107d`）：

```bash
pnpm --filter @mica-js/example-devices build      # 构建器件库（legacy 校验与 MCU 源）
pnpm --filter @mica-js/example-ct107d build       # 默认产正式融合器件：device/dist
pnpm --filter @mica-js/example-ct107d build:devices
pnpm --filter @mica-js/example-ct107d build:fused # build 的显式别名：MCU + 生成 + device/dist
pnpm --filter @mica-js/example-ct107d build:widgets # legacy 板面 widget → dist/widgets
pnpm --filter @mica-js/example-ct107d check:fused # 校验 MCU 源/产物内容身份与生成物一致
pnpm --filter @mica-js/example-ct107d typecheck
pnpm --filter @mica-js/example-ct107d typecheck:fused
pnpm --filter @mica-js/example-ct107d test        # 融合轨迹/oracle + widget 用例
pnpm --filter @mica-js/example-ct107d bench       # 融合器件性能基准（不进 test）
pnpm --filter @mica-js/example-ct107d schematic   # legacy 原理图校验
pnpm --filter @mica-js/example-ct107d canvas      # legacy 画布校验
pnpm --filter @mica-js/example-ct107d firmware    # 重新汇编演示固件
pnpm --filter @mica-js/example-ct107d firmware:sim -- <hex> [选项]
                                                  # 外部固件分立板联调（测试工具）
pnpm --filter @mica-js/example-ct107d firmware:suite -- --list
                                                  # 全部课程程序清单/覆盖（opt-in）
pnpm --filter @mica-js/example-ct107d firmware:suite -- --jobs 4
                                                  # 26 HEX 隔离进程全固件套件
pnpm --filter @mica-js/example-ct107d firmware:suite:tool
                                                  # 套件自身严格 HEX/清单测试
```

`firmware:suite` 是独立的 opt-in 测试工具，不进入日常 `vitest`：输入是未跟踪的
`dist/蓝桥杯单片机程序`，被测对象仍是正式 `device/dist/model.js`（单实例/单 JIT）。
严格 HEX 解析、每个项目的时钟证据、场景、断言、limitations 和 `/tmp/opencode` 报告格式见
[`scripts/README.md`](scripts/README.md)。

构建需要 Node.js 24。根 `build` 与 `build:fused` 都会先运行 `build:mcu`：它把
`examples/devices/iap15f2k61s2` 构建到 `examples/devices/dist/iap15f2k61s2/`，并写入
记录源码（含 `examples/devices/shared/serial.ts` 本地依赖）与构建产物内容哈希的
`examples/devices/dist/iap15f2k61s2.source.json`。随后
`device/scripts/generate.mjs` 校验这份内容哈希（不是 mtime），从 `examples/devices`
的 DDL 与 `ct107d.sch`/`ct107d.netlist.json` 生成
`device/src/{model.ddl,nets.ts,channels.ts}`，最后执行 `mica build --root device`；
产物为自包含的 `device/dist/{package.json,model.js}`。`check:fused` 会重新构建 MCU
并执行同一套内容校验与生成物比对，`--check` 先编译生成的 DDL 再比较文件。
`device/dist/`、`device/dist.release.json` 与 `device/.mica/` 已忽略。

融合器件复用的数字器件源码来自 [`examples/devices`](../devices/README.md) 器件库；本包
不复制器件实现。默认 `build` 只把生成物写入 `device/dist`；legacy 板面 widget 已移到
`build:widgets`，供旧画布/原理图脚本使用。融合前的历史板由 **54 个历史器件 + J5
选择器（55 个实例）、111 条网络、26 种器件包** 组成；融合后图内只有
**1 个实例、2 个外部网络（VCC/GND）和 1 个 JIT**。

历史原理图/画布链路继续读取统一器件包：`bench/board.ts`、`verify-firmware.mjs`、
`verify-schematic.mjs` 与 `seg4-preview.test.ts` 通过 `legacy/device-package.mjs` 把统一
工厂、完整属性和事件接到旧 simulator；`build-schematic.mjs`、`verify-schematic.mjs` 与
`verify-canvas.mjs` 再用 `legacy/schematic-metadata.mjs` 把清单引脚与端口投影成 v1 文档
需要的符号和端口。`build-canvas.mjs` 只按位号查询 `.sch`，不需要器件包。这仍是旧
`.sch v1` / `.cnv v1` 文档，不代表已经实现融合编辑器或 RFC 0024 文档迁移。
`bench/board.ts` 现在只作为 correctness oracle，不进入性能计时。默认 `test` 会同时构建
融合器件与 legacy widget：前者由新用例验证，后者保留旧画布/原理图回归。

## 旧格式边界

`ct107d.sch` 与 `ct107d.cnv` 仍是 **v1** 文档，不是 RFC 0024/0025 的融合文档。旧
`device.json` / `device.js` 路径已经删除，原理图/画布生成与校验统一改为读取
`examples/devices/dist/<id>/{package.json, model.js}`：

- `build-schematic.mjs` 用清单的引脚集合合成 v1 符号，重新生成 `.sch` 与网表；
- `verify-schematic.mjs` 通过 `legacy/device-package.mjs` 把统一工厂接到旧 simulator，
  用同一套合成符号折网表并建板；
- `verify-canvas.mjs` 用 `legacy/schematic-metadata.mjs` 推导的端口表校验绑定，并在按键
  网络用例里装载统一的 `push-button` 包。

因此 clean checkout 只需先运行
`pnpm --filter @mica-js/example-devices build`（画布校验还需要 `mica build` 产出
`dist/widgets`），不再依赖迁移前的 `dist/devices/` 残留。`legacy/schematic-metadata.mjs`
只做校验侧的布局投影：不生成编辑器元数据，也不把旧文档伪装成新格式。

`legacy/device-package.mjs` 只做引擎桥接：从 `<id>/package.json` 与 `model.js` 加载统一工厂，
用 SDK `adaptModelFactory` 交付完整属性（含 `FirmwareImage`）、把统一事件映射回旧话题、
把旧输入话题映射到统一方法。它不生成 `DeviceMetadata`、不生成符号，也不把旧文档伪装成
新格式。

## 融合器件 `device/`

`device/` 是正式的 SDK unified-device 工程，不是旧 widget/content 包：

- 清单：`device/package.json`（`publisher: example`、`name: ct107d-board`），
  属性为 `firmware`（`code` 地址空间，起点 0，`maxBytes: 61440`，`nullable: true`）、
  `clockFrequency`、`ultrasonicDistanceCm` 与 `uartBaud`（UART 探针波特率，默认 9600）；引脚只有 `VCC`/`GND`，与 `model.ddl` 完全一致。
- 构建：`device/scripts/generate.mjs` 生成 `src/model.ddl`、`src/nets.ts`、
  `src/channels.ts`；`mica build --root device` 输出自包含
  `device/dist/{package.json,model.js}`，`model.js` 导出 `model` 与同步 `create`。
- 执行：`src/index.ts` 复用 `examples/devices/iap15f2k61s2` 构建产物的 8051
  translator；`src/fuse.ts` 在原始 translate 之后把 `readSample`/`writeIntent`/
  `resistor` 降为内部 `fusedPins`/`fusedMcuDrives` 槽，融合块单独缓存，不污染
  独立 MCU 器件的原始块缓存。图内只有一个 JIT。
- 数字器件：74HC02/14/138/573、ULN2003、AT24C02、PCF8591、DS1302、DS18B20、
  NE555、CX20106A、VS1838、LM386、霍尔、超声波、UART probe 与红外发射按实例
  命名空间 source-merge，符号和引脚访问改写为内部网；I²C、DS1302、1-Wire、
  UART 等协议状态机保留。
- 模拟/显示/交互：LED 亮度、seg4 扫描稳定窗口、继电器/蜂鸣器、LM324 的
  position/gain/outputVoltage、按键矩阵、J13/J5/J2/J3 跳线由板级逻辑按原理图固定属性
  实现；PCF8591 AIN2 保持独立输入，不自动接 LM324 输出。
- 统一接口：`onDidSignal`（`{designator, port, value}`）、`onDidBytes`
  （`{designator, port, data}`）、`onDidAmplifier`（`{position, gain, outputVoltage}`）与
  MCU 的 `onDidUart1Tx`/`onDidUart1Rx`；方法包括 `setSwitch`、`setJumper`、
  `setHallField`、`setWiper`、`setAmplifierInputs`、`setIrCarrier`、`setTemperature`、
  `setAnalogInput`、`sendUart`、`getSnapshot`、`getAmplifier`、`getEeprom`、`getRtc`、
  `readSerial`、`getSerialStatus`。`setIrCarrier` 必须显式给 `designator`：
  `LD1`（发射端）、`U11`（CX20106A）或 `U20`（VS1838），不会同时驱动三个源；
  J2 的 `vs1838` 选择仍由 `setJumper` 与板级网表决定。J13/J5 是真实三针选择器，
  `setJumper` 的 `closed` 是默认 2-3 位置的投影：J13 `true` = WR 接地（IO），
  `false` = WR 跟随 P42（memory）；J5 `true` = S4–S7 独立接地，`false` = 接 P44
  组成 4×4 矩阵。切换立即重算当前按住的键，不需要重新按下。
  方法和事件均为同步接口，业务参数错误使用 `MethodError`；`bytes` 查询与事件各返回
  独立快照。`getSnapshot` 同时包含 latches/displays、`leds`（亮度兼容数组）与
  `ledStates`（每颗 LED 的 brightness/current/voltage）、relay/buzzer/hall/amplifier、
  `temperature`（converted/value）、`lm386.active`、17 键 switches、J13/J5/J3/J2 jumpers、
  LD1/U11/U20 infrared、NE555、ULN2003、74HC138 decoder 与 PCF8591（AIN0–AIN3、
  channel、DAC 输出）的当前值。`setAnalogInput` 在送入模型前按 0..1 钳位，查询缓存同一值。
- 身份：事件 payload 中的 `designator`/`port` 是板面位号与端口，不是 55 个实例 ID；
  bench 直接按 `DS1/digit1`、`U6/latch` 这类“位号/端口”键汇总轨迹。

### 接线与理想化

融合模型把历史板内网络折叠为理想数字网，并保留 strong high/low、weak high/low 与
release 驱动码。当前支持的电阻合同是 **1 Ω/25 Ω → strong，10 kΩ/1 MΩ → weak**；其它
值在生成阶段或 MCU 降级阶段直接报错，不会静默归入 strong。网络结果区分确定 low、确定
high 与 unknown（没有任何有效驱动时），
`Logic.unknown` 不会静默压成高。电压采样把 unknown 记为 0，这是融合器件的显式理想化。
跳线/按键只按网表连通关系生效，`VCC`/`GND` 是唯一外接引脚。它不再运行板级电阻网络求解，因此
`network.stats.solves` 在测量窗口内为 0。可观察的模拟量按原器件公式计算：

- LED：`forwardResistance` 取原理图 1500 Ω，亮度 `5 / (1500 + 25) / 0.02`；
- seg4：DS1/DS2 为共阳，段低点亮、位选高选中，稳定窗口 50 µs；
- LM324：`gain = 1 + 2 × 100 kΩ / RB4`，输出钳到 0–5 V 后通过 `onDidAmplifier`/
  `getAmplifier` 暴露。初始滑臂 0 对应 gain 21；position/gain/outputVoltage 任一变化都会
  发事件（即使输入为 0、输出仍为 0），工厂初始查询同样是 21。PCF8591 AIN2 仍由
  `setAnalogInput(2, …)` 独立注入；
- 继电器/蜂鸣器：ULN2003 对应通道拉低即吸合/发声。

这是本融合器件的明确边界：它保留固件可观察行为、交互和官方示例固件支持，但不是
任意外部模拟接线或电气竞争的等价模型。固定属性直接取 `ct107d.sch`（不是清单默认值）：
DS1/DS2 `commonAnode=true`、LED/数码管 `forwardResistance=1500`、J2 `vs1838=true`、
J3/J13 为 2-3/闭合位置，J5 默认 2-3 独立键。J13/J5 是真实三针选择器，`.sch v1` 的
两脚 jumper 只投影默认 2-3 位置；1-2 的 P42/P44 选择由融合板级 fragment 补全。

### 正确性验证

- `test/fused-preview.test.ts`：真实预览固件在 0→4096 ms 的 64 ms 检查点与 1 ms
  首帧轨迹上，与离散 55 器件 oracle 对比完整 DS1/DS2 8 位段码、U6–U9 锁存和
  board ready/faults；
- `test/seg4-preview.test.ts`：保留原离散 oracle 的数码管轨迹回归；
- `test/fused-firmware.test.ts`：只使用仓库内 `test/fixtures/8051/*.asm` 和严格
  8051 assembler 生成固件，覆盖 AT24C02+PCF8591、UART echo、DS18B20、DS1302、
  超声波、继电器/蜂鸣器、独立红外源/J2 选择和 16 键矩阵（另验证 S1），每项都与离散 oracle 比较；不依赖 `/tmp` 或跳过；
- `test/fused-inputs.test.ts`：验证按键/跳线/霍尔/独立红外源/LM324 输入、原型键
  拒绝、事件内重入查询、晚订阅快照与 bytes/快照副本隔离，以及 AIN 输入钳位。
- `test/fused-startup.test.ts`：在 `runUntil(0)` 对照融合/离散的启动 LED 轨迹，确认
  融合 glue 不会先发布一个尚未初始化的假 off 状态。
- `test/fused-resistance.test.ts`：验证 10 kΩ 准双向弱上拉被强低覆盖、25 Ω 推挽强高
  压过 1 MΩ 弱下拉、开漏释放的 unknown 以及弱下拉下的低电平。
- `bench/`：从正式 `device/dist` 装载并断言 1 instance/1 JIT；报告 `fallbackRate`、
  `solves=0` 的设计说明与真实 JIT/话题工作量。运行时不公开 fallback PC 集合时
  `directFallbackPcs` 明确为 null，并在 `unavailable` 说明，不伪造 0。

## 与旧实现的对应

| 旧路径                               | 新路径                                   |
| ------------------------------------ | ---------------------------------------- |
| `dist/public/<id>/devices/<id>.json` | `examples/devices/<id>/package.json`     |
| `dist/public/<id>/devices/<id>.js`   | `examples/devices/<id>/model.js`         |
| `dist/public/<id>/devices/<id>.md`   | `examples/devices/docs/<id>.md`          |
| `dist/public/<id>/widgets/<id>.json` | `src/widgets/<id>/widget.json`（legacy） |
| `dist/public/<id>/widgets/<id>.js`   | `src/widgets/<id>/index.ts`（legacy）    |
| `dist/public/<id>/canvases/*.cnv`    | `ct107d.cnv`（legacy，单块板面画布）     |

分立器件统一放在器件库的 `<id>/src/`，器件库逐项目构建输出独立 `package.json` / `model.js`。
整板融合器件是 `device/src` + `device/dist/{package.json,model.js}`，不属于器件库。
旧 `.js` 的 `@mica-js/device` IR API 在当前运行时已不工作；DDL 行为已迁移，旧编辑器的
widget 与文档适配留待后续独立工作。

## 目录

```
examples/ct107d/
  mica.config.ts                  legacy 板面工程标志（读取 src/，输出 dist/）
  package.json                    工作区脚本：build/build:fused/test/bench/typecheck:fused
  tsconfig.json
  vitest.config.ts
  vitest.perf.config.ts           基准专用配置：只装 bench/，串行、超时放宽
  device/                        正式融合器件工程（unified device manifest + DDL + 工厂）
    package.json                  publisher/name、firmware/clockFrequency/ultrasonicDistanceCm/uartBaud
    mica.config.ts                mica build --root device
    scripts/generate.mjs          从器件 DDL/原理图/网表生成 model.ddl、nets.ts、channels.ts
    scripts/mcu-source.mjs        MCU 源码（含 shared/serial.ts）与产物内容哈希
    shared/drive-code.mjs         生成器与 fuse.ts 共用的电阻/驱动码合同
    scripts/build-mcu.mjs         构建 MCU 并写入 source.json 内容身份
    scripts/board-fragment.ddl    板级模拟/显示/交互逻辑与事件通道
    src/model.ddl                 生成的单 DeviceIR（MCU + 21 个 source-merge 数字器件 + 板级逻辑）
    src/index.ts                  同步 create：复用 MCU translator、降级引脚、typed methods/events
    src/fuse.ts                   MCU BlockIR → fusedPins/fusedMcuDrives 的内部网络降级
    src/mcu.ts                    从 examples/devices/dist 复用 IAP15F2K61S2 构建产物
    src/mcu-package.d.ts          外部 MCU 工厂的精确类型声明
    src/{nets,channels}.ts        生成的网络索引与输出通道 → 位号/端口映射
  bench/
    fused.ts                      正式 dist 夹具：一个 instance、一个 JIT、VCC/GND 外部网
    board.ts                      仅测试 oracle：按 ct107d.sch 装配 55 颗分立器件
    measure.ts                    融合基准核心：进程 CPU、JIT、话题/事件、检查点与 workload
    perf.test.ts                  融合性能用例：断言 1 instance/1 JIT、演示固件与 behavior digest
    preview.test.ts               真实预览固件：64/16 ms 轨迹与共同检查点
  src/widgets/                   板面 legacy widget（器件源码在 ../devices/<id>/src/）
  src/widgets/<id>/
    widget.json                   元数据：属性、端口
    index.ts                      widget 实现（render / input / dispose）
  src/widgets/drawing.ts          颜色、裁剪、文字等共用绘制工具
  legacy/device-package.mjs       旧 simulator 引擎兼容桥（仅 legacy/测试）
  legacy/schematic-metadata.mjs   v1 文档校验用的符号/端口投影（非运行时）
  test/
    widgets.test.ts               全部板面 widget 的元数据与绘制/交互
    fused-preview.test.ts         融合器件 vs 离散 oracle：预览固件轨迹
    fused-startup.test.ts         启动 LED 事件轨迹对照
    fused-resistance.test.ts      strong/weak/release/unknown 驱动回归
    fused-firmware.test.ts        仓库内 8051 fixtures：I²C/UART/1-Wire/RTC/超声/执行器/键盘
    fused-inputs.test.ts          输入方法、快照一致性与副本隔离
    fixtures/8051/                自制汇编、严格 assembler 与固件回归
    seg4-preview.test.ts          离散 oracle 的真实预览固件数码管轨迹回归
  ../devices/<id>/src/
    model.ddl                     器件行为：引脚、状态、通道、进程与反应
    index.ts                      统一适配器：同步 methods 与 ctx.events
  ../devices/test/<id>.test.ts    各器件行为用例（含 manifest 与 DDL/元数据一致性）
  ../devices/docs/<id>.md         器件说明：引脚、行为、端口、理想化
  assets/ct107d-board.webp        板面照片（画布背景图，1068×768）
  assets/ct107d-demo.bin          演示固件（70 字节，assemble-firmware.mjs 生成）
  firmware/demo.asm               8051 汇编源
  ct107d.sch                      整板原理图（生成物）
  ct107d.netlist.json             同一网表的可读形式（生成物）
  ct107d.cnv                      板面画布：背景图 + 按键热区 + 数码管（生成物）
  assemble-firmware.mjs           极简 8051 汇编器：firmware/demo.asm → assets/*.bin
  build-schematic.mjs             原理图生成器：统一器件包清单 + 合成符号，输出 .sch 与网表
  build-canvas.mjs                画布生成器：照片像素坐标 → 实例摆放与绑定
  verify-schematic.mjs            原理图校验：网表、建板、锁存链路、数码管扫描
  verify-canvas.mjs               画布校验：解析、绑定、对位、widget 渲染、按键网络
  verify-firmware.mjs             固件联调：把外部 HEX/bin（如 dist/代码）装进整板看输出
  scripts/test-firmware-suite.mjs opt-in 全固件套件：严格 HEX + 26 项目隔离运行/报告
  scripts/firmware-suite.manifest.json 项目身份、时钟证据、场景、断言与 limitations
  scripts/firmware-hex.mjs        8051 60 KiB 严格 Intel HEX 解析器
  scripts/README.md               套件用法、输出、状态语义与维护约定
```

## 器件

| id             | 型号                                  | 类别           | 端口（方向）                                     |
| -------------- | ------------------------------------- | -------------- | ------------------------------------------------ |
| `74hc02`       | 四路 2 输入或非门                     | 组合逻辑       | —                                                |
| `74hc14`       | 六施密特触发反相器                    | 组合逻辑       | —                                                |
| `74hc138`      | 3-8 译码器（低有效）                  | 组合逻辑       | `select`、`enabled`、`code`（输出）              |
| `74hc573`      | 八路透明 D 锁存器                     | 时序逻辑       | `latch`（输出）                                  |
| `uln2003`      | 七路达林顿驱动                        | 驱动           | `mask`、`channels`（输出）                       |
| `lm386`        | 音频功放（数字跟随）                  | 模拟（数字化） | `active`（输出）                                 |
| `at24c02`      | 2 Kb I²C EEPROM                       | 串行存储       | `dump`（输出）                                   |
| `pcf8591`      | 8 位 ADC + DAC（I²C）                 | 混合信号       | `ain0`–`ain3`（输入）、`aout`、`channel`（输出） |
| `ds1302`       | 三线实时时钟                          | 串行时钟       | `datetime`、`running`（输出）                    |
| `ds18b20`      | 1-Wire 温度传感器                     | 串行传感器     | `temperature`（输入）、`temperatureOut`（输出）  |
| `ne555`        | 无稳态定时器                          | 定时           | `frequency`、`dutyCycle`（输出）                 |
| `cx20106a`     | 红外前置放大/整形                     | 红外接收       | `carrier`（输入）、`receiving`（输出）           |
| `vs1838`       | 一体化 38 kHz 红外接收头              | 红外接收       | `carrier`（输入）、`receiving`（输出）           |
| `push-button`  | 轻触按键（S1、S4–S19）                | 机电           | `press`（输入）                                  |
| `buzzer`       | 有源蜂鸣器（SP1）                     | 执行器         | `active`（输出）                                 |
| `relay`        | 电磁继电器（K1，双极常开）            | 执行器         | `energized`（输出）                              |
| `jumper`       | 两脚跳线（J13；另以 2 脚形式简化 J3） | 装配配置       | `control`（输入）、`closedState`（输出）         |
| `jumper-2x3`   | 2×3 跳线排针（J2）                    | 装配配置       | `control2`（输入）、`closedState2`（输出）       |
| `hall`         | 三脚开关型霍尔（U21）                 | 传感器         | `setField`（方法）、`active`（输出）             |
| `lm324`        | 可调差分放大器（U26 + RB4）           | 模拟前端       | `setWiper`（方法）、`setting`（输出）            |
| `ir-emitter`   | 红外发射调制端（LD1）                 | 红外发射       | `setCarrier`（方法）、`carrier`（输出）          |
| `ultrasonic`   | 超声波收发器件（U22）                 | 传感器         | —（`trig` 上升沿触发，`echo` 输出脉宽）          |
| `uart-probe`   | UART 8N1 探针                         | 串行           | `send`（输入）、`tx`、`rx`（输出）               |
| `iap15f2k61s2` | IAP15F2K61S2 8051 MCU（JIT）          | MCU            | `uart1Tx`、`uart1Rx`（输出）                     |
| `blue-led`     | 蓝色 LED（D1–D8）                     | 指示           | `brightness`、`current`、`voltage`（输出）       |
| `seg4`         | 四位共阴/共阳数码管（DS1、DS2）       | 显示           | `digit1`–`digit4`（输出）                        |

每个器件的引脚表、行为、端口编码与理想化见 [`examples/devices/docs/<id>.md`](../devices/docs/)。

## 端口负载编码

DDL 通道没有 `string` 负载，旧版的字符串端口改为固定编码的 `bytes`：

| 器件      | 端口       | 编码                                                     |
| --------- | ---------- | -------------------------------------------------------- |
| `74hc138` | `code`     | 2 字节 ASCII：`"Y0"`–`"Y7"`；禁用时 `"--"`               |
| `uln2003` | `channels` | 7 字节 ASCII，IN1→IN7 对应 `'0'`/`'1'`（如 `"1010000"`） |
| `ds1302`  | `datetime` | 19 字节 ASCII：`YYYY-MM-DD HH:MM:SS`                     |
| `at24c02` | `dump`     | 256 字节原始内容                                         |

其余端口都是 `number` 或 `bool`。`pcf8591` 的模拟输入输出只有端口，没有电气语义，因此物理
引脚用 `vin0`–`vin3` / `dac` 命名（`label` 保留 `AIN0`–`AIN3` / `AOUT`）。

## 引脚命名

DDL 标识符不能以数字开头，也不能含 `#`，因此旧引脚名做了机械改名，`package.json` 的 `pins.*.label`
保留数据手册名称：`D0`–`D7` → `d0`–`d7`、`OE#` → `oe`、`E1#`/`E2#` → `e1`/`e2`、
`Y0#`–`Y7#` → `y0`–`y7`、`RST#` → `rst`、`IN1`–`IN7` → `in1`–`in7` 等。

## 建模约定

- **电气**：每颗芯片声明 `vcc` / `gnd` 引脚（ULN2003 只有 `gnd` 与被动 `com`），推挽输出用
  `resistor(to: vcc|gnd, resistance: outputResistance)`，释放用 `[]`；开漏输出只拉低或释放。
  输入引脚不带内部上拉，I²C/1-Wire 总线需要装配侧提供外部上拉。
- **电平**：`pin.sample.level == Logic.high` 为高，其余（低与未知）按低处理。输入阈值由
  `lowThreshold` / `highThreshold` 属性给出（默认 0.8 V / 2.0 V）。
- **组合逻辑**用 `derived` + `process ... on <derived>`；**边沿**用 `reaction` 配合
  `capture`；**定时/超时**用 `now()` + `await ticks(remaining)`，进程源变化即取消旧定时。
- **通道负载**只能是 `number`、`bool`、`bytes`、扁平 `record`。旧版的 `string` 端口改为
  `bytes`（ASCII）或 `number`，见各器件文档与 `package.json` 的 `properties.*.description`。
- **器件状态**（协议位计数、移位寄存器、暂存器）放在 `state` 里；批量数据（EEPROM、RTC RAM）
  放在 `memory` 里。

## 理想化

统一约定：零传播延迟（NE555 的振荡周期除外）、不模拟驱动强度、电源电流、结温与电磁兼容。
每个器件文档另列该型号的具体简化（例如 AT24C02 无写周期、DS1302 晶振不建模、DS18B20
无寄生供电、ULN2003 导通压降按 0 V、LM386 只有逻辑电平输出）。

## 原理图 `ct107d.sch`

按 CT107D 原理图（仓库根的 `SCH_硬件原理图V30.pdf`）逐网络还原竞赛板，包含器件库中的
23 种芯片/传感器/按键/执行器/跳线器件，以及 `iap15f2k61s2` MCU、`blue-led` LED 与 `seg4` 四位数码管
（DS1/DS2 两片）与 J5 选择器，合计 26 种器件包、55 个实例；器件源码统一维护在
[`examples/devices`](../devices/README.md)。

基准位号差异与后续上板计划见[与基准原理图的差距](#与基准原理图的差距)。

| 文件                   | 说明                                                                |
| ---------------------- | ------------------------------------------------------------------- |
| `ct107d.sch`           | 原理图；器件引用为 `xbotlab:<器件ID>`，跨器件网络用 `builtin:label` |
| `ct107d.netlist.json`  | 同一网表的可读形式：网络名 → `位号.引脚` 列表                       |
| `build-schematic.mjs`  | 生成器：统一器件包清单 + 合成符号，输出 `.sch` 与网表               |
| `verify-schematic.mjs` | 校验：解析网表并对照、建板、跑通锁存链路与数码管扫描                |

器件引用由宿主解析到器件库的 `examples/devices/dist/<ID>/`（共 26 种器件包、55 个实例，
由器件库一次构建）。

已实现的连接：

- **数据/片选**：P00–P07 → U6–U9 的 D0–D7；P25/P26/P27 → U24（A/B/C）；Y4–Y7 与 WR 经
  U25 得到 Y4C–Y7C，分别接 U6/U9/U8/U7 的 LE。
- **负载**：U6 Q0–Q7 → `L1`–`L8` → D1–D8 阴极（阳极接 VCC）；U7 Q0–Q7 → `a`–`dp`；
  U8 Q0–Q7 → `com1`–`com8`；U9 Q0–Q6 → U10 IN1–IN7（网名 `U9Q0`–`U9Q6`）→ `STEPA`–`STEPD`/`N_RELAY`/`N_MOTOR`/
  `N_BUZZ`，Q7 → `N_SPK` → U14 IN1+ → `SPK`。
- **数码管**：DS1 的 `a`–`dp` 并到段总线、`com1`–`com4` 接 `com1`–`com4`；DS2 同样并段总线、
  `com1`–`com4` 接 `com5`–`com8`。两片都是**共阳**管（`seg4.commonAnode = true`）：U8 的位选
  高电平选中该位，U7 的段码低电平点亮该段，`digit1`–`digit4` 仍按「点亮的段」编码。
- **按键**：S4–S19 为 4×4 矩阵，行 `P30/TXD`–`P33`，列 `KCOL0`（S4–S7 公共端）、
  `P42`（S8–S11）、`P35`（S12–S15）、`P34`（S16–S19）。J5 三针选择：2-3 把 KCOL0
  接地（默认独立键），1-2 把 KCOL0 接到 `P44/RD`（矩阵第 1 列）。S1 接在 `VCC` 与
  `RST` 之间。详见 [`docs/push-button.md`](../devices/docs/push-button.md)。
- **串行**：`P20/SCL`/`P21/SDA` → U4（地址脚与 WP 接地）与 U16（A0–A2/EXT 接地）；
  `P13`/`P23`/`P17/SCK` → U19；`P14` → U5；U16 模拟端为 `AIN0`–`AIN3` 与 `OUT` 网标。
  `P10`/`P11` → U22（`trig`/`echo`），UART_PROBE 交叉接到 `P31/RXD`（`rxd`）与
  `P30/TXD`（`txd`），把 MCU 的 UART1 接收与发送分别复原；融合板用 `uartBaud` 属性
  配置探针位时间（默认 9600，课程常用 1200/4800/9600）。UART 观察通道容量为
  4096 条单字节消息；这是每批观察队列边界，不是无限 stream。单次 batch 超限显式
  `CHANNEL_OVERFLOW`，跨批历史仍按 `SerialLog` 的 cursor/`droppedTotal` 语义裁剪。
- **定时/跳线 J3**：U15 OUT → `NET_SIG` → J3 的 `a`，J3 的 `b` → `P34`。实物 J3 是 20 脚
  扩展排针（pin 15 = `NET_SIG`、pin 16 = `P34`），本示例只用 2 脚 `jumper` 模拟 15–16 的
  跳线帽，其余 18 脚未建模。
- **执行器**：U10 OUT5 → `N_RELAY` → K1 线圈（另一端接 VCC），K1 的 `com`（引脚 3）接
  `m2` 端子、`no`（引脚 6）与第二组触点公共端 `com2`（引脚 1）接 GND；U10 OUT7 →
  `N_BUZZ` → SP1 负端（正端接 VCC）。详见 [`docs/relay.md`](../devices/docs/relay.md)、
  [`docs/buzzer.md`](../devices/docs/buzzer.md)。
- **红外**：CX20106A 输出 `N_B1`、VS1838 输出 `N_B2` 接到 J2 的 2/6 脚，J2 的 1-3 固定
  短接（`P10` → U18 整形/驱动链 `N_A1`），接收端公共脚 4（`P11`）由实例属性 `vs1838`
  选择短接 4-6 或 2-4；J2 的 5 脚是红外发射管支路 `N_A2`，接 LD1（`ir-emitter`）的
  `mod`。U15 的 RST 与 VCC 接高。详见 [`docs/jumper-2x3.md`](../devices/docs/jumper-2x3.md)。
- **传感器/模拟前端**：U21（`hall`）的 `out` 接 `N_HALL`，`vcc`/`gnd` 接 5 V/GND；
  U26（`lm324`）的 `out` 与 PCF8591 的 `vin2` 同网 `AIN2`，差分输入 `inPlus`/`inMinus`
  接 `IN+`/`IN-` 网标。两者的板外端口在基准图纸上落在尚未建模的 J3.1 与 J7，因此按
  仓库既有约定保留为接口桩网标（详见下一节）。
- **跳线**：J13 是 CON3：1=`P42`、2=`WR`（U25 的四个 B 输入）、3=GND。默认
  `closed=true` 对应 2-3（WR 接地，P42 仍自由作为矩阵列）；`closed=false` 对应 1-2
  （WR 跟随 P42，用于 memory 写选通）。J5 同型：1=`P44/RD`、2=S4–S7 公共端、3=GND；
  默认 `closed=true` 是 2-3 独立键，`false` 是 1-2 矩阵。

忽略器件后的替代约定：

- 74HC573 的 OE#、74HC138 的 E1#/E2#、ULN2003 的 E、AT24C02 的 A0–A2/WP、PCF8591 的
  A0–A2/EXT、LM386 的 IN1- 直接接 GND；74HC138 的 E3、各芯片 VCC 接 VCC。
- LED 阳极经 1 kΩ 限流电阻接 VCC；电阻不建模，改为每颗 LED 的 `forwardResistance = 1500 Ω`
  （500 Ω 器件等效 + 1 kΩ 外部），5 V 时亮度约 0.164。数码管的段阳极同样按
  `seg4.forwardResistance = 1500 Ω` 并入 1 kΩ 排阻。
- 真实 J13 的三针拓扑已按 2019-03-04 CT107D_CX 原理图校正：`P42` 是独立的 MCU/键盘
  列网络，`WR` 是 U25 B 输入网络。旧两脚 jumper 投影只表达默认 2-3（`WR` 接地），
  不会再把 `P42` 一起接地；1-2 的 `WR` 跟随 `P42` 由融合 fragment 实现。P4.2/P4.4
  已在 MCU 模型中作为 GPIO/键盘列参与读引脚与 RMW，`WR/RD` 的 MOVX 外部总线脉冲仍未
  建模，因此 memory 模式只验证显式 P42 低电平选通。
- `RST` 只连 S1 与网标：MCU 模型没有复位引脚，复位电路里的 CR1/R3 不建模。
- 执行器输出 `STEPA`–`STEPD`/`N_MOTOR`、`SPK`、`AIN0`–`AIN3`、`OUT`、`m2`、
  `NET_SIG`、`N_HALL`、`IN+`/`IN-` 等只保留驱动/接收侧网标，作为未建模排针的接口桩；
  74HC138 的 Y0–Y3、NE555 的 RC 脚、CX20106A 的 C1/C2/C3/f0、DS1302 的 X1/X2/VCC1、
  LM386 的 GAIN/BYPASS、PCF8591 的 OSC 按 NC 处理。

## 与基准原理图的差距

以下是有意保留的当前范围。

- **J3 简化**：基准 J3 是 20 脚扩展排针（pin 1 = `N_HALL`、pin 15 = `NET_SIG`、
  pin 16 = `P34`），本示例只用 2 脚 `jumper` 模拟 15–16 的跳线帽，其余 18 脚未建模；
  U21（`hall`）的 `out` 因此只接到 `N_HALL` 网标。
- **J7 未建模**：基准 J7 是 4 脚模拟输入排针，接 U26（`lm324`）的 `IN+`/`IN-`；本示例把
  这两个引脚保留为 `IN+`/`IN-` 网标。
- **U22 位号冲突**：基准的 `U22`/`U23` 是 8 脚数码管扩展排针，本示例的 `U22` 是
  `ultrasonic` 实例；这两个排针尚未建模。
- **LED 位号**：基准 LED 位号是 `L1`–`L8`，`D1`–`D8` 是 1N4148；本示例沿用旧生成器把 LED
  记为 `D1`–`D8`、把网络记为 `L1`–`L8`。电气连接与画布绑定不受影响，但位号不能与基准
  逐一对读。

后续若建模 20 脚 J3 与 4 脚 J7，把 `N_HALL`/`IN+`/`IN-` 改接排针引脚即可，器件侧无需改动。

```powershell
cd dist\ct107d
pnpm run schematic        # node verify-schematic.mjs
pnpm run build:devices    # 重新生成 .sch 前先构建统一器件包
node build-schematic.mjs  # 修改网表/布局后重新生成
```

`verify-schematic.mjs` 依次做五件事：解析 `ct107d.sch` 折出网表并与 `ct107d.netlist.json`
逐网络对照（同时检查悬空导线端点与器件本体重叠）；用全部 55 个器件建板跑 1 ms 确认没有
装配故障；装一段固件走 `P2 → 74HC138 → 74HC02 → 74HC573 → LED`，确认 D1 亮度 0.1639、其余
熄灭；同一段固件再按 `Y7 → U7（段码）`、`Y6 → U8（位选）` 逐位扫描，确认 DS1/DS2 八位分别
锁存到写入的段码；接着装入 `assets/ct107d-demo.bin`，确认 8 位全亮且走马灯逐位轮转；最后
用临时探针与电压源核对 U21（`N_HALL` 悬空→拉低）、U26（`AIN2` 默认增益约 2.1 V、最大增益
饱和到电源轨）与 LD1（`N_A2` 高电平时载波开启）。器件来自统一包，符号由
`legacy/schematic-metadata.mjs` 按清单引脚合成。

## 板面画布 `ct107d.cnv`

> `build-schematic.mjs` 按 designator 固定器件 symbol id：前 54 个保持原有 id，J5 使用
> 新增固定 id。因此新增 P4 pin/J5 不会让 legacy `ct107d.cnv` 的 symbol 引用漂移；
> 本次 `schematic` 与 `canvas` 校验均通过。

把 `assets/ct107d-board.webp`（1068×768 的板面照片）当背景，在上面覆盖 17 个按键热区、
8 个 LED 指示器、2 片四位数码管、蜂鸣器、继电器与 2 个交互式跳线，共 32 个实例；每个实例
都按照片像素定位，再通过 `bindings` 接到 `ct107d.sch` 的器件端口。

| widget                  | 数量 | 位置                                                                                                  | 绑定                                           |
| ----------------------- | ---- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `xbotlab:image`         | 1    | (0, 0) 1068×768                                                                                       | —                                              |
| `xbotlab:button`        | 17   | 独立按键一列 x≈143、矩阵三列 x≈202/261/320、行 y≈491/539/588/637，热区 40×40；复位键 S1 在 (379, 540) | `press` → 对应 `S*.press`                      |
| `xbotlab:segment`       | 2    | DS1 (502, 206) 126×60、DS2 (636, 206) 127×60                                                          | `digit1`–`digit4` → `DS1/DS2.digit1`–`digit4`  |
| `xbotlab:led-indicator` | 8    | 照片丝印 L1–L8 一排，中心 x≈338.5–476.5、y≈319，18×26                                                 | `brightness` → `D1`–`D8` 的 `brightness`       |
| `xbotlab:buzzer`        | 1    | SP1 (718, 390) 60×60                                                                                  | `active` → `SP1.active`                        |
| `xbotlab:relay`         | 1    | K1 (806, 389) 88×62                                                                                   | `energized` → `K1.energized`                   |
| `xbotlab:jumper`        | 1    | J13 (310, 406) 42×72                                                                                  | `state1`/`closed1` → `closedState`/`control`   |
| `xbotlab:jumper`        | 1    | J2 (596, 168) 76×64                                                                                   | `state2`/`closed2` → `closedState2`/`control2` |

- **按键**：半透明圆角热区，`pointerdown` 落在热区内即输出 `press=true`，`pointerup` /
  `pointercancel` 回到 `false`；指针被捕获后拖出热区再松手同样会松开。
- **数码管**：四个输入端口各接 8 位段码（`bit0=a` … `bit6=g`、`bit7=dp`），与 `seg4` 的
  输出一一对应；不做亮度积分，端口给什么就画什么。
- **指示灯/执行器**：LED 按 `brightness` 点亮，蜂鸣器按 `active` 画光晕，继电器按
  `energized` 切换高亮。
- **交互式跳线**：J13 点击切换 `closed1`（对应 `control`）；J2 的通道 1（1-3）固定短接，
  只有通道 2（2-4/4-6）的 `closed2` 可切换。J5 的独立/矩阵选择只通过融合器件
  `setJumper({designator:'J5', closed})` 暴露，本任务不修改 legacy canvas/widget。
- **背景图**：`image` 属性用 `{ src, mode: "file" }` 资源引用，`src` 相对 `.cnv` 所在目录；
  读数来自宿主预取的字节，widget 自身没有网络访问。
- 数码管默认红色、按键默认青色高亮，都可在 `.cnv` 的实例 `properties` 里覆盖。

```powershell
cd dist\ct107d
pnpm run canvas           # node verify-canvas.mjs（需要先 mica build / pnpm run build:devices）
node build-canvas.mjs     # 修改坐标或位号后重新生成 ct107d.cnv
```

`verify-canvas.mjs` 做四件事：用 `parseCanvas` 解析画布并按 `ct107d.sch` 的 symbol/端口
校验全部绑定；按照片尺寸检查对位（背景图铺满整块板、17 个热区互不重叠且不出界、两片数码管
盖住两个黑色窗口）；用假 2D 上下文跑全部已绑定 widget 的实现（位图绘制、按下/松开发布、
段码点亮段数）；最后用 `ct107d.sch` 的按键网表建一块只含按键与辅助器件的板，逐个按下
17 个键，确认矩阵行/列与 `RST` 的电平按 PDF 的接法变化。

## 基准

`bench/` 是**融合器件**性能基准。`bench/fused.ts` 只装载正式产物
`device/dist/{package.json,model.js}`，创建一个实例，并断言图内恰好 1 个 JIT；外部只接
`VCC`/`GND`。`bench/board.ts` 的 55 器件整板只作为测试 oracle，不进入计时。

```powershell
pnpm --filter @mica-js/example-ct107d bench     # 先 build:devices + build:fused，再 vitest
```

口径：装配 → `runUntil(0)` → 预热 20 ms → 测量窗口 500 ms，重复 3 轮；`cpuMs` / `realtimeRatio`
取 CPU 时间最小的一轮。演示夹具 `assets/ct107d-demo.bin` 按原理图使用 **12 MHz** MCU
（8 位数码管全亮 + 8 路 LED 走马灯）；`measureCt107d` 的默认 demo clock 是 12 MHz，
显式 props 优先。预览基准使用 `digital-display-dynamic.bin`、11.0592 MHz、512 ms 预热、1024 ms 窗口、
64 ms 批次，并在每个 64 ms 共同检查点上保留 DS1/DS2 文本与 U6–U9 锁存轨迹。

融合后没有板内电气网络，因此 `solves`、`electricalPublishes`、`dirtySlots` 为 0，
`components` 只剩外部 VCC/GND 两个分量。`unavailable.solves` 会明确说明这是设计结果；
工作量改由 `boundaryCalls`、`topicMessages`、`directCalls`、检查点轨迹和固定显示/锁存断言
共同约束，而不是用“非空输出”模糊通过。

| 字段                                          | 含义                                                                                                 |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `rtf`                                         | 历史 CPU 口径：`cpuMs / simMs`；实时比请读 `realtimeRatio`                                           |
| `cpuMs` / `simMs`                             | 测量窗口的进程 CPU 时间与仿真时间（毫秒）                                                            |
| `realtimeRatio`                               | `simMs / elapsedWallMs`，1 表示实时                                                                  |
| `coldCpuMs`                                   | 装配 + `runUntil(0)` + 预热的 CPU 时间（不含测量窗口）                                               |
| `instances` / `jits`                          | 图内实例数 / JIT 数；融合产物必须为 1 / 1                                                            |
| `devices` / `nets`                            | 器件实例数 / 网络数；融合产物为 1 / 2                                                                |
| `solves` / `usPerSolve`                       | 窗口内电气求解增量与单次耗时；融合产物按设计为 0                                                     |
| `components` / `factorizations` / `leafPlans` | 求解统计；融合产物只保留外部 VCC/GND 的两个分量                                                      |
| `boundaryCalls`                               | 窗口内运行时 `boundary()` 的调用次数                                                                 |
| `publishCalls` / `electricalPublishes`        | `publish()` 调用次数 / 真正推进电气求解的次数                                                        |
| `topicMessages`                               | 窗口内 `onDidSignal`/`onDidBytes` 事件条数，也就是参与 `topicDigest` 的消息数                        |
| `direct` / `directCalls`                      | 直接 JIT 是否接管 MCU / 直接程序调用次数                                                             |
| `directPrograms` / `compileDirectJit`         | 直接程序缓存条数 / 成功编译次数（整轮累计，含预热）                                                  |
| `fallbackRate`                                | 窗口内 `directFallbacks / directCalls` 的比例                                                        |
| `directFallbackPcs`                           | 运行时不公开 fallback PC 集合时为 null，并写入 `unavailable` 说明；不伪造 0                          |
| `directFallbacksExhausted`                    | 窗口内所有直接调用都回退时为 true                                                                    |
| `topicDigest`                                 | 窗口内每条事件按 `(simTime, 位号/端口, payload)` 规范化后取 SHA-256 前 16 位，作为「行为不变」对照值 |
| `topicDigestStable`                           | 同一次测量的多轮摘要是否完全一致                                                                     |
| `checkpoints` / `checkpointsStable`           | 共同仿真时间检查点上的完整 `位号/端口` 状态及跨轮稳定性                                              |
| `unavailable`                                 | 拿不到或按设计退化的指标及原因                                                                       |

事件身份直接使用 payload 中的 `designator`/`port`（如 `DS1/digit1`、`U6/latch`）；不再用
`topicOrigin` 把单实例拆成 55 个伪实例。`bench/results.jsonl` 只记录本轮读数，已忽略。

**性能读数。** bench 只对正式 `device/dist` 计时，离散 oracle 只做 correctness 对照，不进入
性能窗口。旧的 fused/分立对照表是在 **demo 11.0592 MHz vs 分立 12 MHz** 不同频条件下生成的，
不具可比性，已删除；本文不再据此声称提速。当前 `ct107d-demo` 按原理图 12 MHz 运行，
preview 保持 11.0592 MHz；每次运行的绝对读数以 `PERF`/`PREVIEW_*` stdout 为准。
`MICA_PERF_STREAM=<path>` 可导出原始 `(simTime, designator/port, payload)` 流做差分。

每次运行把整份结果追加到 `bench/results.jsonl`（gitignore 已忽略），`vitest` 只在用例失败时
回显 `console`，所以基线用 `process.stdout.write` 打印 `PERF {...}`。

`topicDigest` 是跨改动比对的锚点：改融合生成器或引擎之后摘要不变，说明事件层面的行为没变；
它只覆盖事件、不覆盖内部引脚电平，内部等价性仍由 `test/fused-*` 与离散 oracle 负责。用例
另有一轮 `SJMP $` 空转固件，确认摘要对行为敏感（两次摘要必须不同）。

## 验证

```powershell
pnpm --filter @mica-js/example-ct107d build:devices
pnpm --filter @mica-js/example-ct107d build:fused
pnpm --filter @mica-js/example-ct107d check:fused
pnpm --filter @mica-js/example-ct107d typecheck
pnpm --filter @mica-js/example-ct107d typecheck:fused
pnpm --filter @mica-js/example-ct107d test
pnpm --filter @mica-js/example-ct107d bench
```

器件行为用例和板级夹具随器件源码迁到 `examples/devices/test/`；本包保留
`widgets.test.ts`、`test/fused-preview.test.ts`、`test/fused-firmware.test.ts`、
`test/fused-inputs.test.ts`、`test/fused-startup.test.ts`、`test/fused-resistance.test.ts`
与 `test/seg4-preview.test.ts`。`fused-preview` 在 64 ms 检查点与
1 ms 首帧轨迹上对比融合与离散 oracle；`fused-firmware` 只使用仓库内
`test/fixtures/8051/*.asm` 和严格 assembler 覆盖 EEPROM/PCF、UART、1-Wire、DS1302、
超声波和 17 键，缺失 fixture 会直接失败而不是跳过；`seg4-preview` 保留原离散整板的预览
轨迹；`widgets.test.ts` 用最小 widget API 与假 2D 上下文覆盖全部板面 widget 的元数据
与行为（legacy）。

正式融合产物只从 `device/dist` 装载；`test/` 与 `bench/` 中的 `adaptModelFactory`
只用于把 `FirmwareImage` 和输入事件接到旧 `createBoard` 消费边界，不进入
`device/src` 运行时。
