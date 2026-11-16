# CT107D 整板示例

CT107D 竞赛板的 Mica 示例工程：7 种板面 widget（背景图 / 按键 / 四位数码管 / 指示灯 /
蜂鸣器 / 继电器 / 交互式跳线）、整板原理图 `ct107d.sch`、板面画布 `ct107d.cnv` 与一段 8051
演示固件。整板使用的器件全部来自 [`examples/devices`](../devices/README.md) 器件库。

工程位于仓库的 `examples/ct107d`，纳入 pnpm workspace（包名 `@mica-js/example-ct107d`）：

```bash
pnpm --filter @mica-js/example-devices build      # 先构建器件库（原理图/画布/固件联调依赖它）
pnpm --filter @mica-js/example-ct107d build       # 输出 dist/widgets
pnpm --filter @mica-js/example-ct107d test        # widget 与板级集成用例
pnpm --filter @mica-js/example-ct107d bench       # 整板性能基准（不进 test）
pnpm --filter @mica-js/example-ct107d typecheck
pnpm --filter @mica-js/example-ct107d schematic   # 原理图校验
pnpm --filter @mica-js/example-ct107d canvas      # 画布校验
pnpm --filter @mica-js/example-ct107d firmware    # 重新汇编固件
pnpm --filter @mica-js/example-ct107d firmware:sim -- <hex> [选项]
                                                  # 外部固件整板联调
```

整板用到的器件全部来自 [`examples/devices`](../devices/README.md) 器件库，本包不再复制
器件源码。`mica build` 只输出板面 legacy widget；统一器件包由器件库逐项目构建到
`examples/devices/dist/<id>/{package.json, model.js}`。整板共 **51 个器件实例、99 条网络、
23 种器件包**（器件库现有 30 个包）。

原理图/画布链路也读取统一器件包：`bench/board.ts`、`verify-firmware.mjs`、
`verify-schematic.mjs` 与 `seg4-preview.test.ts` 通过 `legacy/device-package.mjs` 把统一
工厂、完整属性和事件接到旧 simulator；`build-schematic.mjs`、`verify-schematic.mjs` 与
`verify-canvas.mjs` 再用 `legacy/schematic-metadata.mjs` 把清单引脚与端口投影成 v1 文档
需要的符号和端口。`build-canvas.mjs` 只按位号查询 `.sch`，不需要器件包。这仍是旧
`.sch v1` / `.cnv v1` 文档，不代表已经实现融合编辑器或 RFC 0024 文档迁移。

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

## 与旧实现的对应

| 旧路径                               | 新路径                                   |
| ------------------------------------ | ---------------------------------------- |
| `dist/public/<id>/devices/<id>.json` | `examples/devices/<id>/package.json`     |
| `dist/public/<id>/devices/<id>.js`   | `examples/devices/<id>/model.js`         |
| `dist/public/<id>/devices/<id>.md`   | `examples/devices/docs/<id>.md`          |
| `dist/public/<id>/widgets/<id>.json` | `src/widgets/<id>/widget.json`（legacy） |
| `dist/public/<id>/widgets/<id>.js`   | `src/widgets/<id>/index.ts`（legacy）    |
| `dist/public/<id>/canvases/*.cnv`    | `ct107d.cnv`（legacy，单块板面画布）     |

器件统一放在器件库的 `<id>/src/`，器件库逐项目构建输出独立 `package.json` / `model.js`。
旧 `.js` 的 `@mica-js/device` IR API 在当前运行时已不工作；DDL 行为已迁移，旧编辑器的
widget 与文档适配留待后续独立工作。

## 目录

```
examples/ct107d/
  mica.config.ts                  Mica 工程标志（读取 src/，输出 dist/）
  package.json                    build = mica build，typecheck = mica prepare && tsc --noEmit
  tsconfig.json
  vitest.config.ts
  vitest.perf.config.ts           基准专用配置：只装 bench/，串行、超时放宽
  bench/
    board.ts                      整板夹具：按 ct107d.sch 折出网表装配 51 颗器件（装载统一 dist 包）
    measure.ts                    测量核心：进程 CPU 时间读数、电气/运行时/JIT 指标、topicDigest
    perf.test.ts                  基准用例：只断言下限，并追加一行到 bench/results.jsonl
  src/widgets/                   板面 legacy widget（器件源码在 ../devices/<id>/src/）
  src/widgets/<id>/
    widget.json                   元数据：属性、端口
    index.ts                      widget 实现（render / input / dispose）
  src/widgets/drawing.ts          颜色、裁剪、文字等共用绘制工具
  legacy/device-package.mjs       旧 simulator 引擎兼容桥（非编辑器元数据投影）
  legacy/schematic-metadata.mjs   v1 文档校验用的符号/端口投影（非运行时）
  test/
    widgets.test.ts               全部板面 widget 的元数据与绘制/交互
    seg4-preview.test.ts          真实预览固件的数码管轨迹回归
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
20 种芯片/按键/执行器/跳线器件，以及 `iap15f2k61s2` MCU、`blue-led` LED 与 `seg4` 四位数码管
（DS1/DS2 两片），合计 23 种器件包、51 个实例；器件源码统一维护在
[`examples/devices`](../devices/README.md)。

未接入整板的器件、基准位号差异与后续上板计划见[与基准原理图的差距](#与基准原理图的差距)。

| 文件                   | 说明                                                                |
| ---------------------- | ------------------------------------------------------------------- |
| `ct107d.sch`           | 原理图；器件引用为 `xbotlab:<器件ID>`，跨器件网络用 `builtin:label` |
| `ct107d.netlist.json`  | 同一网表的可读形式：网络名 → `位号.引脚` 列表                       |
| `build-schematic.mjs`  | 生成器：统一器件包清单 + 合成符号，输出 `.sch` 与网表               |
| `verify-schematic.mjs` | 校验：解析网表并对照、建板、跑通锁存链路与数码管扫描                |

器件引用由宿主解析到器件库的 `examples/devices/dist/<ID>/`（共 23 种器件包、51 个实例，
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
- **按键**：S4–S7 一端接地（J5 的 2-3 短接）、另一端接 `P30/TXD`–`P33`；S8–S19 构成 3×4
  矩阵，行同上四根、列接 `P42/WR`/`P35`/`P34`；S1 接在 `VCC` 与 `RST` 之间。详见
  [`docs/push-button.md`](../devices/docs/push-button.md)。
- **串行**：`P20/SCL`/`P21/SDA` → U4（地址脚与 WP 接地）与 U16（A0–A2/EXT 接地）；
  `P13`/`P23`/`P17/SCK` → U19；`P14` → U5；U16 模拟端为 `AIN0`–`AIN3` 与 `OUT` 网标。
  `P10`/`P11` → U22（`trig`/`echo`），UART_PROBE 交叉接到 `P31/RXD`（`rxd`）与
  `P30/TXD`（`txd`），把 MCU 的 UART1 接收与发送分别复原。
- **定时/跳线 J3**：U15 OUT → `NET_SIG` → J3 的 `a`，J3 的 `b` → `P34`。实物 J3 是 20 脚
  扩展排针（pin 15 = `NET_SIG`、pin 16 = `P34`），本示例只用 2 脚 `jumper` 模拟 15–16 的
  跳线帽，其余 18 脚未建模。
- **执行器**：U10 OUT5 → `N_RELAY` → K1 线圈（另一端接 VCC），K1 的 `com`（引脚 3）接
  `m2` 端子、`no`（引脚 6）与第二组触点公共端 `com2`（引脚 1）接 GND；U10 OUT7 →
  `N_BUZZ` → SP1 负端（正端接 VCC）。详见 [`docs/relay.md`](../devices/docs/relay.md)、
  [`docs/buzzer.md`](../devices/docs/buzzer.md)。
- **红外**：CX20106A 输出 `N_B1`、VS1838 输出 `N_B2` 接到 J2 的 2/6 脚，J2 的 1-3 固定
  短接（`P10` → U18 整形/驱动链 `N_A1`），接收端公共脚 4（`P11`）由实例属性 `vs1838`
  选择短接 4-6 或 2-4；J2 的 5 脚是红外发射管支路 `N_A2`。U15 的 RST 与 VCC 接高。详见
  [`docs/jumper-2x3.md`](../devices/docs/jumper-2x3.md)。
- **跳线**：J13 的 `a` 接 `P42/WR`、`b` 接 GND，`closed` 属性模拟「WR 接 0 V」的装配位置。

忽略器件后的替代约定：

- 74HC573 的 OE#、74HC138 的 E1#/E2#、ULN2003 的 E、AT24C02 的 A0–A2/WP、PCF8591 的
  A0–A2/EXT、LM386 的 IN1- 直接接 GND；74HC138 的 E3、各芯片 VCC 接 VCC。
- LED 阳极经 1 kΩ 限流电阻接 VCC；电阻不建模，改为每颗 LED 的 `forwardResistance = 1500 Ω`
  （500 Ω 器件等效 + 1 kΩ 外部），5 V 时亮度约 0.164。数码管的段阳极同样按
  `seg4.forwardResistance = 1500 Ω` 并入 1 kΩ 排阻。
- `P42/WR` 除了 74HC02 的四个 B 输入，还接矩阵键盘的第二列；MCU 模型没有 P4 端口，
  J13 的 WR 源侧不建模，原理图里 J13 只把 `P42/WR` 短接到 GND（`closed = true`）。
- `RST` 只连 S1 与网标：MCU 模型没有复位引脚，复位电路里的 CR1/R3 不建模。
- 执行器输出 `STEPA`–`STEPD`/`N_MOTOR`、`SPK`、`AIN0`–`AIN3`、`OUT`、`m2`、
  `NET_SIG` 等只保留驱动侧网标，作为未实现器件的接口桩；74HC138 的 Y0–Y3、NE555 的 RC 脚、
  CX20106A 的 C1/C2/C3/f0、DS1302 的 X1/X2/VCC1、LM386 的 GAIN/BYPASS、PCF8591 的 OSC
  按 NC 处理。

## 与基准原理图的差距

以下是有意保留的当前范围；器件库已交付对应包不等于已接入整板，本轮也不为
`examples/ct107d` 新增器件实例。

- **未上板**：`hall`（基准 U21，`U21.2 → N_HALL → J3.1`）、`lm324`（基准 U26 + RB4，
  `IN± → J7`、`out → AIN2 → U16.vin2`）与 `ir-emitter`（基准 LD1，`mod → J2.5`/`N_A2`）
  暂不新增实例；网表中因此没有 `N_HALL`、`IN+`、`IN-`，`AIN2` 只接 `U16.vin2`，
  `N_A2` 只接 `J2.p5`。
- **J3 简化**：基准 J3 是 20 脚扩展排针（pin 15 = `NET_SIG`、pin 16 = `P34`），本示例只用
  2 脚 `jumper` 模拟 15–16 的跳线帽，其余 18 脚未建模；接入 `hall` 前需要先建模该排针。
- **U22 位号冲突**：基准的 `U22`/`U23` 是 8 脚数码管扩展排针，本示例的 `U22` 是
  `ultrasonic` 实例；这两个排针尚未建模。
- **LED 位号**：基准 LED 位号是 `L1`–`L8`，`D1`–`D8` 是 1N4148；本示例沿用旧生成器把 LED
  记为 `D1`–`D8`、把网络记为 `L1`–`L8`。电气连接与画布绑定不受影响，但位号不能与基准
  逐一对读。

后续若把 `hall`/`ir-emitter`/`lm324` 上板，需要同步处理 20 脚 J3（pin 1 = `N_HALL`）、
4 脚模拟输入 J7 与 U22 位号冲突。

```powershell
cd dist\ct107d
pnpm run schematic        # node verify-schematic.mjs
pnpm run build:devices    # 重新生成 .sch 前先构建统一器件包
node build-schematic.mjs  # 修改网表/布局后重新生成
```

`verify-schematic.mjs` 依次做五件事：解析 `ct107d.sch` 折出网表并与 `ct107d.netlist.json`
逐网络对照（同时检查悬空导线端点与器件本体重叠）；用全部 51 个器件建板跑 1 ms 确认没有
装配故障；装一段固件走 `P2 → 74HC138 → 74HC02 → 74HC573 → LED`，确认 D1 亮度 0.1639、其余
熄灭；同一段固件再按 `Y7 → U7（段码）`、`Y6 → U8（位选）` 逐位扫描，确认 DS1/DS2 八位分别
锁存到写入的段码；最后装入 `assets/ct107d-demo.bin`，确认 8 位全亮且走马灯逐位轮转。器件
来自统一包，符号由 `legacy/schematic-metadata.mjs` 按清单引脚合成。

## 板面画布 `ct107d.cnv`

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
  只有通道 2（2-4/4-6）的 `closed2` 可切换。
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

`bench/` 是整板性能基准，与 `examples/devices/bench` 里的器件基准同构，差别只有两处：

- 读数用**进程 CPU 时间**（`process.cpuUsage`）而不是挂钟，避免并行任务抢 CPU 时读数抖动；
- 器件从器件库 `examples/devices/` 装载：`bench/board.ts` 按 `ct107d.sch` 折出网表，
  装载统一包 `examples/devices/dist/<id>/{package.json, model.js}`，因此 `bench` 脚本
  先运行 `pnpm run build:devices`。

```powershell
pnpm --filter @mica-js/example-ct107d bench     # vitest run --config vitest.perf.config.ts
```

口径：装配整板 → `runUntil(0)` → 预热 20 ms → 测量窗口 500 ms，重复 3 轮；`wallMs` / `rtf`
取 CPU 时间最小的一轮，`usPerSolve` 取各轮最小值。固件是 `assets/ct107d-demo.bin`（12 MHz 8051，
8 位数码管全亮 + 8 路 LED 走马灯），板子按 `ct107d.sch` 装配 51 颗器件、99 条网络，
电气求解、通道与执行引擎都走真实运行时。

**行为对照必须用 `execution: 'precise'`。** 默认的 `throughput` 模式按
[吞吐合同](../../docs/spec/jit/throughput.rst)允许错过 GPIO 中间态、合并受保护执行段内的检查，
因此同一份固件在两种模式下 `topicDigest` 本来就会不同。演示固件把每个锁存的 LE 高电平相位
保持一整个 `DELAY`（实测约 4 ms，长于预览的 2 ms 推进步长），并且两次刷新之间 `P0` 一直等于
LED 图案，所以两种模式都能稳定锁存；差异只能来自其它引脚中间态，跨模式比较仍按合同允许的
可见性差异判定，见 [conformance](../../docs/spec/conformance.rst)；
`MICA_PERF_STREAM=<path>` 可导出原始 `(simTime, topic, payload)` 流做差分。

| 字段                                          | 含义                                                                                                     |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `rtf`                                         | 墙钟（CPU 时间）/ 仿真时间，1 表示实时；越小越快                                                         |
| `wallMs` / `simMs`                            | 测量窗口的 CPU 时间与仿真时间（毫秒）                                                                    |
| `coldMs`                                      | 装配 + `runUntil(0)` + 预热的 CPU 时间（不含测量窗口）                                                   |
| `usPerSolve`                                  | 每次电气求解摊到的时钟时间：`network.solveSlots` 内用 `hrtime` 累计 / 调用次数                           |
| `solves`                                      | 窗口内 `ElectricalStats.solves` 的增量                                                                   |
| `prepareTopology`                             | 整图重建次数；迁移桶命中时走恢复而不是重建                                                               |
| `components` / `factorizations` / `leafPlans` | 同一次求解统计里的分量数、矩阵分解次数、叶计划（复用形状）数，用来观察拓扑重建频率                       |
| `boundaryCalls`                               | 窗口内运行时 `boundary()` 的调用次数（每次块边界都会经过它）                                             |
| `publishCalls` / `electricalPublishes`        | 窗口内 `publish()` 的调用次数 / 其中真正推进了电气求解的次数                                             |
| `topicMessages`                               | 窗口内话题消息条数，也就是参与 `topicDigest` 的消息数                                                    |
| `dirtySlots`                                  | 每次电气发布前脏槽数量的峰值                                                                             |
| `direct` / `directCalls`                      | 直接 JIT 是否接管 MCU / 直接程序的调用次数                                                               |
| `directPrograms` / `compileDirectJit`         | 直接程序缓存条数 / 成功编译次数（整轮累计，含预热；预热期间就会编译完，只统计窗口内会恒为 0）            |
| `fallbackRate`                                | 直接程序返回 `fallback` 的比例                                                                           |
| `topicDigest`                                 | 窗口内每条消息按 `(simTime, topic, payload)` 规范化后取 SHA-256 的前 16 位，作为「行为不变」的统一对照值 |
| `topicDigestStable`                           | 同一次测量的多轮摘要是否完全一致                                                                         |
| `unavailable`                                 | 拿不到或退化了的指标及原因                                                                               |

每次运行把整份结果追加到 `bench/results.jsonl`（gitignore 已忽略），`vitest` 只在用例失败时
回显 `console`，所以基线用 `process.stdout.write` 打印 `PERF {...}`。

`topicDigest` 是跨改动比对的锚点：改引擎或编译器之后摘要不变，说明话题层面的行为没变；
它只覆盖话题消息、不覆盖引脚电平，电气层面的等价性仍由 `test/` 的用例负责。用例里另有一轮
`SJMP $` 空转固件，确认摘要对行为敏感（两次摘要必须不同）。`prepareTopology` 这类拿不到的
指标列在 `unavailable` 里，需要精确计数时给 `ElectricalStats` 补计数器，而不是在基准里猜。

## 验证

```powershell
cd dist\ct107d
pnpm run typecheck        # mica prepare && tsc --noEmit
pnpm run test             # mica build + vitest
pnpm run schematic        # node verify-schematic.mjs
pnpm run canvas           # node verify-canvas.mjs
```

器件行为用例和板级夹具随器件源码迁到 `examples/devices/test/`；本包保留
`widgets.test.ts` 与 `seg4-preview.test.ts`。`test/seg4-preview.test.ts` 使用
`bench/board.ts` 装配整板，覆盖真实预览固件的数码管轨迹；`widgets.test.ts` 用最小
widget API 与假 2D 上下文覆盖全部板面 widget 的元数据与行为。
