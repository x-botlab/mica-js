# CT107D 器件包

CT107D 竞赛板的 Mica 示例工程：17 个器件（13 种芯片 + 轻触按键 + IAP15F2K61S2、
`seg4` 数码管、`blue-led` 指示灯）、4 个板面 widget（背景图 / 按键 / 四位数码管 /
指示灯）、整板原理图 `ct107d.sch`、板面画布 `ct107d.cnv` 与一段 8051 演示固件。

工程位于仓库的 `examples/ct107d`，纳入 pnpm workspace（包名 `@mica-js/example-ct107d`）：

```bash
pnpm --filter @mica-js/example-ct107d build       # 输出 dist/devices、dist/widgets
pnpm --filter @mica-js/example-ct107d test        # 器件与 widget 用例
pnpm --filter @mica-js/example-ct107d typecheck
pnpm --filter @mica-js/example-ct107d schematic   # 原理图校验
pnpm --filter @mica-js/example-ct107d canvas      # 画布校验
pnpm --filter @mica-js/example-ct107d firmware    # 重新汇编固件
```

整板用到的器件全部在本包 `src/devices/` 下，`mica build` 一次输出 17 个器件，
不依赖其它工程的构建产物。Playground 的 `scripts/components.mjs` 会把本包的 `dist/`
与 `ct107d.{sch,cnv,assets}` 复制到被忽略的 `public/components/ct107d/`。

其中 `seg4`、`blue-led`、`iap15f2k61s2` 另有独立的源工程
（[`../seg4`](../seg4/README.md)、[`../blue-led`](../blue-led/README.md)、
[`../iap15f2k61s2`](../iap15f2k61s2/README.md)），带各自的测试、基准与文档。本包里的
这三份是**镜像副本**，`test/mirrors.test.ts` 会逐文件比对，防止两边漂移；修改器件行为
时两处都要改（或先改独立工程再同步过来）。

器件是 `dist/public` 里旧版 playground 器件（`<id>/devices/<id>.{json,js,md}`，基于已退役的
`@mica-js/device` IR API）的迁移版本：每个器件一个 `src/devices/<id>/` 目录，用 DDL 描述行为，
`mica build` 输出 `dist/devices/<id>/{device.json, device.js}`。

画布控件按新端口重写为 `src/widgets/<id>/`，构建产物是 `dist/widgets/<id>/{widget.json, widget.js}`；
`ct107d.cnv` 把背景图与 17 个按键热区、2 片四位数码管铺在开发板照片上，并通过
`bindings` 接到 `ct107d.sch` 里的按键与数码管器件。

## 与旧实现的对应

| 旧路径                               | 新路径                                    |
| ------------------------------------ | ----------------------------------------- |
| `dist/public/<id>/devices/<id>.json` | `src/devices/<id>/device.json`            |
| `dist/public/<id>/devices/<id>.js`   | `src/devices/<id>/model.ddl` + `index.ts` |
| `dist/public/<id>/devices/<id>.md`   | `docs/<id>.md`                            |
| `dist/public/<id>/widgets/<id>.json` | `src/widgets/<id>/widget.json`            |
| `dist/public/<id>/widgets/<id>.js`   | `src/widgets/<id>/index.ts`               |
| `dist/public/<id>/canvases/*.cnv`    | `ct107d.cnv`（单块板面画布）              |

旧 `.js` 使用已退役的 `@mica-js/device` IR API（`api.ir.pin.writeDigital`、`observeDigital`、
`event.at`），在当前运行时不工作；迁移保留其行为契约与理想化说明，但把实现换成 DDL。器件
放在同一个 Mica 包里（旧 playground 也是单个 `demo` 包），`mica build` 为每个
`src/devices/<id>/` 输出独立的 `device.json` / `device.js`，可单独上传；widget 同理。

## 目录

```
examples/ct107d/
  mica.config.ts                  Mica 工程标志（读取 src/，输出 dist/）
  package.json                    build = mica build，typecheck = mica prepare && tsc --noEmit
  tsconfig.json
  vitest.config.ts
  src/devices/<id>/
    model.ddl                     器件行为：引脚、状态、通道、进程与反应
    index.ts                      适配器：把输出通道转发到同名话题
    device.json                   元数据：属性、引脚、端口（省略 symbol，按引脚自动生成）
  src/devices/iap15f2k61s2/       JIT 器件：kernel/ 与 peripherals/ 多个模块
  src/devices/{seg4,blue-led}/    板级显示器件（与整板同步迁移进来）
  src/widgets/<id>/
    widget.json                   元数据：属性、端口
    index.ts                      widget 实现（render / input / dispose）
  src/widgets/drawing.ts          颜色、裁剪、文字等共用绘制工具
  test/
    harness.ts                    共享板级夹具：DDL + src 适配器 + 电阻/探针/数字源
    manifest.test.ts              元数据、DDL、适配器三份声明的一致性
    widgets.test.ts               四个板面 widget 的元数据与绘制/交互
    <id>.test.ts                  各器件行为用例
  docs/<id>.md                    器件说明：引脚、行为、端口、理想化
  assets/ct107d-board.webp        板面照片（画布背景图，1068×768）
  assets/ct107d-demo.bin          演示固件（70 字节，assemble-firmware.mjs 生成）
  firmware/demo.asm               8051 汇编源
  ct107d.sch                      整板原理图（生成物）
  ct107d.netlist.json             同一网表的可读形式（生成物）
  ct107d.cnv                      板面画布：背景图 + 按键热区 + 数码管（生成物）
  assemble-firmware.mjs           极简 8051 汇编器：firmware/demo.asm → assets/*.bin
  build-schematic.mjs             原理图生成器：PDF 逐网络对照表与布局
  build-canvas.mjs                画布生成器：照片像素坐标 → 实例摆放与绑定
  verify-schematic.mjs            原理图校验：网表、建板、锁存链路、数码管扫描
  verify-canvas.mjs               画布校验：解析、绑定、对位、widget 渲染、按键网络
```

## 器件

| id            | 型号                     | 类别           | 端口（方向）                     |
| ------------- | ------------------------ | -------------- | -------------------------------- |
| `74hc02`      | 四路 2 输入或非门        | 组合逻辑       | —                                |
| `74ls04`      | 六反相器                 | 组合逻辑       | —                                |
| `74hc138`     | 3-8 译码器（低有效）     | 组合逻辑       | `select`、`enabled`、`code`      |
| `74hc573`     | 八路透明 D 锁存器        | 时序逻辑       | `latch`                          |
| `uln2003`     | 七路达林顿驱动           | 驱动           | `mask`、`channels`               |
| `lm386`       | 音频功放（数字跟随）     | 模拟（数字化） | `active`                         |
| `at24c02`     | 2 Kb I²C EEPROM          | 串行存储       | `dump`                           |
| `pcf8591`     | 8 位 ADC + DAC（I²C）    | 混合信号       | `ain0`–`ain3`、`aout`、`channel` |
| `ds1302`      | 三线实时时钟             | 串行时钟       | `datetime`、`running`            |
| `ds18b20`     | 1-Wire 温度传感器        | 串行传感器     | `temperature`、`temperatureOut`  |
| `ne555`       | 无稳态定时器             | 定时           | `frequency`、`dutyCycle`         |
| `cx20106a`    | 红外前置放大/整形        | 红外接收       | `carrier`、`receiving`           |
| `vs1838`      | 一体化 38 kHz 红外接收头 | 红外接收       | `carrier`、`receiving`           |
| `push-button` | 轻触按键（S1、S4–S19）   | 机电           | `press`                          |

每个器件的引脚表、行为、端口编码与理想化见 [`docs/<id>.md`](docs/)。

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

DDL 标识符不能以数字开头，也不能含 `#`，因此旧引脚名做了机械改名，`device.json` 的 `label`
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
  `bytes`（ASCII）或 `number`，见各器件文档与 `device.json` 的 `description`。
- **器件状态**（协议位计数、移位寄存器、暂存器）放在 `state` 里；批量数据（EEPROM、RTC RAM）
  放在 `memory` 里。

## 理想化

统一约定：零传播延迟（NE555 的振荡周期除外）、不模拟驱动强度、电源电流、结温与电磁兼容。
每个器件文档另列该型号的具体简化（例如 AT24C02 无写周期、DS1302 晶振不建模、DS18B20
无寄生供电、ULN2003 导通压降按 0 V、LM386 只有逻辑电平输出）。

## 原理图 `ct107d.sch`

按 CT107D 原理图（仓库根的 `SCH_硬件原理图V30.pdf`）逐网络还原竞赛板，包含本包的
14 个芯片/按键器件，以及 `iap15f2k61s2` MCU、`blue-led` LED 与 `seg4` 四位数码管
（DS1/DS2 两片）；这三个器件同时有独立源工程，见上文。未实现器件——电阻、电容、晶振、LCD、拨码开关、排针与跳线、CH340C、霍尔、
运放、继电器、蜂鸣器、电机、红外发射管——暂时忽略。

| 文件                   | 说明                                                                |
| ---------------------- | ------------------------------------------------------------------- |
| `ct107d.sch`           | 原理图；器件引用为 `xbotlab:<器件ID>`，跨器件网络用 `builtin:label` |
| `ct107d.netlist.json`  | 同一网表的可读形式：网络名 → `位号.引脚` 列表                       |
| `build-schematic.mjs`  | 生成器：内含 PDF 逐网络对照表与布局，重新生成两个产物               |
| `verify-schematic.mjs` | 校验：解析网表并对照、建板、跑通锁存链路与数码管扫描                |

器件引用由宿主解析到本包的 `./dist/devices/<ID>/`（共 17 个器件，均由本包一次构建）。

已实现的连接：

- **数据/片选**：P00–P07 → U6–U9 的 D0–D7；P25/P26/P27 → U24（A/B/C）；Y4–Y7 与 WR 经
  U25 得到 Y4C–Y7C，分别接 U6/U9/U8/U7 的 LE。
- **负载**：U6 Q0–Q7 → `L1`–`L8` → D1–D8 阴极（阳极接 VCC）；U7 Q0–Q7 → `a`–`dp`；
  U8 Q0–Q7 → `com1`–`com8`；U9 Q0–Q6 → U10 IN1–IN7（网名 `U9Q0`–`U9Q6`）→ `STEPA`–`STEPD`/`N_RELAY`/`N_MOTOR`/
  `N_BUZZ`，Q7 → `N_SPK` → U14 IN1+ → `SPK`。
- **数码管**：DS1 的 `a`–`dp` 并到段总线、`com1`–`com4` 接 `com1`–`com4`；DS2 同样并段总线、
  `com1`–`com4` 接 `com5`–`com8`。
- **按键**：S4–S7 一端接地（J5 的 2-3 短接）、另一端接 `P30/TXD`–`P33`；S8–S19 构成 3×4
  矩阵，行同上四根、列接 `P42/WR`/`P35`/`P34`；S1 接在 `VCC` 与 `RST` 之间。详见
  [`docs/push-button.md`](docs/push-button.md)。
- **串行**：`P20/SCL`/`P21/SDA` → U4（地址脚与 WP 接地）与 U16（A0–A2/EXT 接地）；
  `P13`/`P23`/`P17/SCK` → U19；`P14` → U5；U16 模拟端为 `AIN0`–`AIN3` 与 `OUT` 网标。
- **定时/红外**：U15 OUT → `NET_SIG`，RST 与 VCC 接高；CX20106A 与 VS1838 的输出经
  J2 短接后进 U18 的整形/并联门（`U18N1`–`U18N4`）。

忽略器件后的替代约定：

- 74HC573 的 OE#、74HC138 的 E1#/E2#、ULN2003 的 E、AT24C02 的 A0–A2/WP、PCF8591 的
  A0–A2/EXT、LM386 的 IN1- 直接接 GND；74HC138 的 E3、各芯片 VCC 接 VCC。
- LED 阳极经 1 kΩ 限流电阻接 VCC；电阻不建模，改为每颗 LED 的 `forwardResistance = 1500 Ω`
  （500 Ω 器件等效 + 1 kΩ 外部），5 V 时亮度约 0.164。数码管的段阳极同样按
  `seg4.forwardResistance = 1500 Ω` 并入 1 kΩ 排阻。
- `N_A1` / `N_A2` 表示 J2 的 1-2、5-6 已短接；`P42/WR` 除了 74HC02 的四个 B 输入，还接矩阵
  键盘的第二列——MCU 模型没有 P4 端口，J13 的 WR 源不建模，板级验证按 J13 2-3（WR 接 0 V）处理。
- `RST` 只连 S1 与网标：MCU 模型没有复位引脚，复位电路里的 CR1/R3 不建模。
- 执行器输出 `STEPA`–`STEPD`/`N_RELAY`/`N_MOTOR`/`N_BUZZ`、`SPK`、`AIN0`–`AIN3`、`OUT`、
  `NET_SIG` 等只保留驱动侧网标，作为未实现器件的接口桩；74HC138 的 Y0–Y3、NE555 的 RC 脚、
  CX20106A 的 C1/C2/C3/f0、DS1302 的 X1/X2/VCC1、LM386 的 GAIN/BYPASS、PCF8591 的 OSC
  按 NC 处理。

```powershell
cd dist\ct107d
pnpm run schematic        # node verify-schematic.mjs
node build-schematic.mjs  # 修改网表/布局后重新生成
```

`verify-schematic.mjs` 依次做四件事：解析 `ct107d.sch` 折出网表并与 `ct107d.netlist.json`
逐网络对照（同时检查悬空导线端点与器件本体重叠）；用全部 44 个器件建板跑 1 ms 确认没有
装配故障；装一段固件走 `P2 → 74HC138 → 74HC02 → 74HC573 → LED`，确认 D1 亮度 0.1639、其余
熄灭；同一段固件再按 `Y7 → U7（段码）`、`Y6 → U8（位选）` 逐位扫描，确认 DS1/DS2 八位分别
锁存到写入的段码。

## 板面画布 `ct107d.cnv`

把 `assets/ct107d-board.webp`（1068×768 的板面照片）当背景，在上面覆盖 17 个按键热区与
2 片四位数码管；每个实例都按照片像素定位，再通过 `bindings` 接到 `ct107d.sch` 的器件端口。

| widget            | 数量 | 位置                                                                                                  | 绑定                                          |
| ----------------- | ---- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `xbotlab:image`   | 1    | (0, 0) 1068×768                                                                                       | —                                             |
| `xbotlab:button`  | 17   | 独立按键一列 x≈143、矩阵三列 x≈202/261/320、行 y≈491/539/588/637，热区 40×40；复位键 S1 在 (379, 540) | `press` → 对应 `S*.press`                     |
| `xbotlab:segment` | 2    | DS1 (502, 206) 126×60、DS2 (636, 206) 127×60                                                          | `digit1`–`digit4` → `DS1/DS2.digit1`–`digit4` |

- **按键**：半透明圆角热区，`pointerdown` 落在热区内即输出 `press=true`，`pointerup` /
  `pointercancel` 回到 `false`；指针被捕获后拖出热区再松手同样会松开。
- **数码管**：四个输入端口各接 8 位段码（`bit0=a` … `bit6=g`、`bit7=dp`），与 `seg4` 的
  输出一一对应；不做亮度积分，端口给什么就画什么。
- **背景图**：`image` 属性用 `{ src, mode: "file" }` 资源引用，`src` 相对 `.cnv` 所在目录；
  读数来自宿主预取的字节，widget 自身没有网络访问。
- 数码管默认红色、按键默认青色高亮，都可在 `.cnv` 的实例 `properties` 里覆盖。

```powershell
cd dist\ct107d
pnpm run canvas           # node verify-canvas.mjs（需要先 mica build / pnpm run test）
node build-canvas.mjs     # 修改坐标或位号后重新生成 ct107d.cnv
```

`verify-canvas.mjs` 做四件事：用 `parseCanvas` 解析画布并按 `ct107d.sch` 的 symbol/端口
校验全部绑定；按照片尺寸检查对位（背景图铺满整块板、17 个热区互不重叠且不出界、两片数码管
盖住两个黑色窗口）；用假 2D 上下文跑三个 widget 的实现（位图绘制、按下/松开发布、段码点亮
段数）；最后用 `ct107d.sch` 的按键网表建一块只含按键与辅助器件的板，逐个按下 17 个键，
确认矩阵行/列与 `RST` 的电平按 PDF 的接法变化。

## 验证

```powershell
cd dist\ct107d
pnpm run typecheck        # mica prepare && tsc --noEmit
pnpm run test             # mica build + vitest
pnpm run schematic        # node verify-schematic.mjs
pnpm run canvas           # node verify-canvas.mjs
```

`test/harness.ts` 用 `compileDDL` 现场编译 `model.ddl` 并直接装载 `src/` 适配器，同时就地
声明三种辅助器件：线性电阻（上拉/下拉/串联）、电平探针（`pin y` → `level` 通道）、数字源
（`level` 通道 → `pin y`）。被测器件不被 mock，电气求解与通道都走真实仿真板。
`manifest.test.ts` 保证 `device.json`、`model.ddl` 与适配器描述的属性、引脚、端口不会漂移；
`decode-chain.test.ts` 把 74HC138、74HC02、74HC573 接成 CT107D 真实的
`P2.5–P2.7 → Y4# → WR 或非 → LE` 片选—锁存链路，端到端验证三颗器件的组合行为；
`widgets.test.ts` 用最小 widget API 与假 2D 上下文覆盖四个板面 widget 的元数据与行为。
