# CT117E-M4 单器件融合工程（STM32G431RBT6 + 板载 IO）

`ct117e-m4` 把 CT117E-M4 上 MCU、ILI9325、74HC573/8 LED/4 按键、AT24C02/MCP4017、
R37/R38 电位器和两个 XL555 的固定接线合成一个器件模型：**一个 instance、一个 JIT**。
它用于验证单器件融合路径和真实 Keil 固件的运行行为，不是完整 CT117E-M4 开发板仿真。

- 器件 ID：`example:ct117e-m4`
- 源码：`src/`（融合电气行为在 `model.ddl`，装配与 MCU/LCD/板载器件适配在
  `index.ts`/`board.ts`/`mcu.ts`/`lcd.ts`）
- 构建产物：包根 `dist/{package.json,model.js}`
- 参考固件：`HAL_06_LCD.hex`（LCD 基线；测试夹具位于
  `examples/devices/bench/stm32g431rbt6`；统一模型从 `ctx.props.firmware` 接收
  `FirmwareImage`）

## 构建与检查

需要 Node.js 24（仓库当前使用 Node 24.20.0）。

```bash
cd examples/ct117e-m4
pnpm build        # 生成热函数 IR，然后 mica build
pnpm typecheck    # 生成热函数 IR、DDL 类型，然后 tsc --noEmit
pnpm test         # 构建并运行正确性测试
pnpm bench        # 构建并运行三轮基准
```

`pnpm test` 会先构建，再只从 `dist/model.js` 装载产物；测试不会退回 `src/`，也不会在
测试里重新编译 DDL。

本工程本地保存 LCD 模型、适配器、融合变换和热函数展开器；MCU 内核来自工作区包
`@mica-js/stm32g431rbt6-core`（`examples/stm32g431rbt6-core`，`workspace:*` 开发依赖），
与器件库 `examples/devices` 中的 STM32G431RBT6 器件共用同一份 Thumb 译码、总线/内存布局与外设模型。该包对外
提供 `/bus`、`/cpu`、`/decode`、`/gpio`、`/ir`、`/layout`、`/machine`、`/memory`、
`/nvic`、`/pwr`、`/rcc`、`/register-facts`、`/systick`、`/thumb16`、`/thumb32`、`/tick`、
`/usart` 子路径；`mcu.ts` 通过 `/layout`、`/ir`、`/decode`、`/machine`、`/gpio`、
`/memory`、`/systick`、`/usart`、`/nvic`、`/register-facts` 引用内核，只保留本器件的
属性、复位值与 JIT 编排。

`scripts/prepare-model.mjs` 在构建期编译本地 `model.ddl`，生成忽略提交的
`hot-model.ts`，供运行时展开 BlockIR 热函数；SDK 同时把完整模型编进最终产物。
`mica build` 在构建期把共享内核打包进产物，构建与运行不引用兄弟 example 的源码或
测试文件。`model.js` 是单个自包含模块，导出 `model` 和同步 `create`，运行时不加载共享包。

## 统一模型接口

`src/index.ts` 使用 `.mica/device.d.ts` 生成的 `DeviceFactory`、`DeviceMethods` 和
`DeviceEvents`。`package.json` 的 `model.methods` / `model.events` 是公共接口的唯一
权威；本 README 只描述能力，不复制扩展方法的参数和事件载荷，具体名称、签名和载荷以
最终公开 manifest 为准。LCD 侧的 `getFramebuffer`、`onDidFramebuffer`、Fault 和
USART1–3 发送事件保持原合同；扩展接口覆盖按键、8 位 LED 锁存状态、EEPROM 预置/导出、
MCP4017 wiper、两个 ADC 电位器位置、两个 555 调频电位器位置和 555 频率查询。重复设置
相同值不重复发事件。`create` 返回的实例同步执行并公开 `methods`；内部 MCU、LCD 和
板载器件只通过 `ctx.events` 发事件，不使用旧话题。

固件属性由清单声明为 `firmware`，工厂拿到的是按 `flash` 地址空间解析后的只读
`FirmwareImage`；模型 IR 不声明同名 DDL 属性。`mcu.ts` 在工厂执行前把镜像段映射到
`code` 内存，并拒绝未知地址空间或越界段。

## 旧 simulator 兼容边界

旧 `createBoard` 仍使用话题与裸字节属性；测试夹具通过 SDK 的 `adaptModelFactory` +
`firmwareImage` 做显式投影，并把测试固件包装成 `FirmwareImage`。这只是旧消费适配，
不是融合运行时实现。

## 接线与运行设置

### 外部引脚

模型只公开三个外部引脚：

- `VDD1 = 3.3 V`、`VSS1 = 0 V`。所有板载器件共用这组电源轨。
- `NRST` 可在外部拉低以保持 MCU halted，释放沿从向量表重启；它只复位 MCU，
  LCD 侧保持自己的状态。当前基线测试不接 NRST，保持内部/外部上拉的释放态。

除这三个引脚外，下列连接都在器件内部固定，不形成跨器件 net，也不通过公共引脚暴露。

### 固定接线

[`ct117e-m4.netlist.json`](ct117e-m4.netlist.json) 是按 `CT117E_M4_SCH.pdf` V1.0 第 1 页
手工整理的子网表，格式为「网络名 → 位号.引脚」，不是原厂 CAD 导出。LCD 模组以 CN3 接口为边界；
跳线两侧仍是独立网络，下表注明模型中哪些跳线常闭。网表供核对，不是运行时输入，
不包含 DAP-Link、USB、扩展排针及完整电源去耦网络。

实板的 `LCD_RST` 与 U4 `PG10-NRST` 相连；融合模型只将公共 `NRST` 接到 MCU，
LCD `RST` 固定为高。模型也把 VDDA/VREF+ 固定为 3.3 V，不仿真 L1/R21 的电源网络。

| 子系统        | 固定接法                                                                                                                                                                              |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| LCD           | `D0–D15 = PC0–PC15`，`WR = PB5`，`RS = PB8`，`CS = PB9`，`RD = PA8`；LCD 的 VDD/VSS 在内部连接，`RST` 恒高。                                                                          |
| 74HC573 + LED | U1 `OE# = GND`，`LE = PD2`，`1D–8D = PC8–PC15`；`1Q–8Q` 接 `LD1–LD8` 阴极，阳极各经 300 Ω 接 VDD，**Q 低电平点亮**。`LE` 高时 Q 透明跟随 D，`LE` 低时保持最后电平。                   |
| 按键          | `B1 = PB0`、`B2 = PB1`、`B3 = PB2`、`B4 = PA0`；另一端接 GND，各 10 kΩ 上拉到 VDD，**按下 = 0**。                                                                                     |
| EEPROM        | U2 M24C02（AT24C02 兼容）：`SCL = PB6`、`SDA = PB7`，`E1/E2/E3 = GND`，`WC# = GND`（低 = 可写），7 位地址 **0x50**。                                                                  |
| 数字电位器    | U3 MCP4017：`SCL/SDA = PB6/PB7`，`W` 经 J15 到 **PB14**，`B` 经 J16 到 GND，`R17` 10 kΩ 将 W 上拉到 VDD；7 位地址 **0x2f**，上电 wiper = 0x3F。                                       |
| I²C 上拉      | `R9/R11` 10 kΩ 与 `R18/R19` 10 kΩ 两组上拉共用 PB6/PB7。模型把它们合成为理想释放高，不计算并联阻值、容差和上升时间。                                                                  |
| ADC 电位器    | R37 为 VDD–GND 分压，滑臂经 J11 到 **PB15**（ADC2_IN15）；R38 为 VDD–GND 分压，滑臂经 J12 到 **PB12**（ADC1_IN11）。MCP4017 的 W 节点为 **PB14**（ADC1_IN5）。                        |
| ADC 参考      | `VDDA = VREF+ = 3.3 V`；J17 常闭，把 VDDA 接到 VREF+。                                                                                                                                |
| 555 U7        | `OUT` 经 J9 到 **PB4**（TIM3_CH1）。R39 左端悬空，滑臂接 `OUT`，右端经 R31 100 Ω 到 RC 节点；C26 100 nF 从 RC 节点到 GND；`DISCH` 悬空，`RESET = VDD`，`CONT` 经 C27 10 nF 到 GND。   |
| 555 U8        | `OUT` 经 J10 到 **PA15**（TIM2_CH1）。R40 左端悬空，滑臂接 `OUT`，右端经 R32 100 Ω 到 RC 节点；C28 100 nF 从 RC 节点到 GND；`DISCH` 悬空，`RESET = VDD`，`CONT` 经 C29 10 nF 到 GND。 |
| 跳线          | J9/J10（555 输出）、J11/J12（ADC 电位器）、J15/J16（MCP4017 W/B）和 J17（VREF+）在模型中按常闭处理；不建模开路。                                                                      |

### 板载器件行为

- **573/LED 与 LCD 共用 PC8–PC15**：573 是锁存器，不是缓冲器。`LE` 为低时 LCD 写
  `D8–D15` 不会改变 LED；`LE` 为高时 Q 跟随 D，LED 随 `PC8–PC15` 更新。
- **I²C 用 GPIO 模拟**：PB6/PB7 由固件 bit-bang，模型按边沿解码 START/STOP、地址、
  ACK 和读写数据；SDA 为开漏，只有 ACK 或读数据位会拉低。它不依赖硬件 I²C AF，
  也不做时钟拉伸、上升沿延迟和总线仲裁。
- **AT24C02**：256 B 阵列、8 B 页写、随机读/当前地址读和地址回卷；`WC#` 固定为低，
  因此本模型没有写保护状态。页写和字节写都不模拟 `tWC` 写周期，数据在事务内立即
  更新阵列；8 B 页边界和地址回卷仍按器件行为处理。初值可由宿主预置/导出。
- **MCP4017**：7 位 wiper（0..127），W–B 为变阻器。若位置码为 `N`，
  `R_WB = 100 kΩ × N / 127 + 100 Ω`，W 电压为
  `3.3 V × R_WB / (10 kΩ + R_WB)`；code 0/63/127 约为
  0.0327 V / 2.747 V / 3.0003 V。
- **ADC**：只把 PB14/PB12/PB15 三个节点作为 ADC1_IN5、ADC1_IN11、ADC2_IN15 的模拟
  输入；R37/R38 位置按 0..1 归一化，电压为 3.3 V × position。未接入的 ADC 通道不会
  由 GPIO 或随机值伪造。位置改变只影响之后的采样，已完成的转换不被追溯修改。
- **555**：U7/U8 是输出反馈型无稳态，不是 `ne555` 器件包的 rA/rB/DISCH 结构。半周期
  相同、占空比约 50%：`R = 100 Ω + position × 10 kΩ`，
  `T = 2 × ln2 × R × C`，`f = 1 / T`，`C = 100 nF`。position 0 约 72.1 kHz，
  position 1 约 714 Hz。555 输出为推挽，既作为 GPIO 输入电平，也作为
  TIM2_CH1/TIM3_CH1 的捕获边沿；不叠加 MCU 上拉。改位置后，频率查询即时反映新设定，
  振荡在当前半周期结束后按新频率重新计时。周期按理想公式计算，不模拟阈值偏差、
  温度漂移和输出摆率。
- **调试复用**：PB4/PA15 分别与 JTAG 的 NJTRST/JTDI 复用，不是 SWD 的 PA13/PA14。
  模型不模拟 JTAG/SWD；接入 555 后这两个脚在模型里只按 GPIO/AF 输入使用。

### 运行设置

- 单主机、理想数字总线；没有第二个总线主设备，也没有模拟竞争。
- `clockFrequency` 是模型的时间基准，必须与固件实际配置的主频一致；本固件为
  80 MHz。它不是自动从 RCC 寄存器反推的值。
- `refreshRate` 默认 60 Hz，控制脏矩形合帧发布的最大频率。
- `runUntil(0)` 完成复位和初始化；之后可用任意步长推进到目标时间。
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
- 板载器件事件覆盖按键、LED 锁存、EEPROM 写、wiper、电位器位置和 555 边沿；
  555 频率通过查询接口读取。边沿事件只供观测，队列满时丢弃最旧的观测事件，
  不改变振荡电平或 TIM 捕获。相同状态重复设置不重复发布。

旧兼容投影只覆盖显式列出的既有事件，把它们映射回 `framebuffer`、`fault`、
`serial1.tx`–`serial3.tx` 话题；新增板载器件事件以统一接口为准。
`framebuffer` 的矩形可能重叠或只覆盖局部区域，消费方应按顺序合成；没有脏像素时不会
发布空帧。

## 测试覆盖

### 当前板载器件验收

Node.js 24.20.0 下，融合产物 `dist/model.js` 构建和类型检查通过。以下仅记录定向验收
（9 项通过、2 项失败、1 项超时），不是整板验收通过：

| 器件 / 路径        | 当前结果                                                                                                                                              |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| U1、LD1–LD8 与 LCD | LED 低有效、锁存保持及 LCD 共享总线短用例通过。                                                                                                       |
| B1–B4、R37/R38     | 四键及 ADC1_IN11 (PB12) / ADC2_IN15 (PB15) 采样通过。                                                                                                 |
| U2/U3 共用 I²C     | GPIO 开漏拉低与释放通过；EEPROM 总线 ACK / 随机读回用例 45 秒超时，结果未定。                                                                         |
| U2 M24C02          | 宿主写入用例失败：向 `0xFE` 写入 `0x11` 后读回 `0x00`。                                                                                               |
| U3 MCP4017         | 宿主写入用例在 EEPROM 断言处提前中止，wiper 改值和 PB14 / ADC1_IN5 未完成产物验收。                                                                   |
| U7/U8 XL555        | 公共接口、端点频率、绝对相位和调频切换通过。固件输入捕获中 PA15 / TIM2 断言通过，PB4 / TIM3 的 CCR 差值为 `0`（预期 `112012–112013`），双路用例失败。 |

当前 MCU 性能限制下未运行完整测试、独立 WFI 用例、长窗口 LCD 逐帧对账或基准。
旧 HAL LCD oracle 在未改动的 `2073dc8` 基线上，220 ms 处只得到 `80` 次 WR 变化
（预期 `272506`）；本轮保留该 oracle，未重跑或修改 MCU 基线。

### 历史 MCU + LCD 基线

> 下文的固定工作量和用例计数是 **2026-11-15 的 MCU+LCD 基线**。扩展板载器件后仍用
> 它们做 LCD/内核回归参照，不作为当前板载器件验收结果。

`test/device.test.ts` 是正式交付产物用例：

- 从 `dist/model.js` 装载并创建**单个** instance；
- 严格解析 `examples/devices/bench/stm32g431rbt6/HAL_06_LCD.hex`，按 80 MHz 从复位推进到 220 ms / 440 ms；
- 固定工作量：220 ms 为 272,506 次 WR 电平变化、136,008 次 GRAM store、5 帧；
  440 ms 为 **545,004 次 WR 变化、272,007 次像素 store、10 帧、76,800 个非零
  像素**；
- 板状态保持 `ready`，无 error/fault；
- 最终 GRAM、寄存器文件、逐帧内容、精确 `frameInfo` 时间以及 MCU 状态/内存摘要
  与旧的分立 `examples/devices/test/ili9325/joint-harness.ts` oracle 对账；
- 额外用独立总线 oracle 核对 MCU intent 计数、像素写次数与最终图像。

oracle 只在正确性用例中运行，不进入任何性能计时。它依赖兄弟 example 的测试夹具，
这是**测试依赖**，不是器件运行时的依赖。

`test/firmware.test.ts` 覆盖 HEX 解析器的记录格式、校验和、地址范围、EOF、重叠冲突
和不支持的记录类型。

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

- 0 → 200 µs 为冷启动（建板 + 复位 + 首次翻译），200 µs → 220 ms 为 active，
  220 → 440 ms 为 post；
- 三轮独立建板，进程 CPU 与墙钟都输出；
- 每轮结束在计时之外校验 440 ms 工作量、帧数、非零像素以及 `ready`/无 fault；
- 不安装逐 intent oracle，不做大型性能矩阵。

运行：

```bash
pnpm bench
```

stdout 会输出 `CT117E_M4_PERF` 行和 `CT117E_M4_REPORT` 临时目录；`readings.json`
包含每轮的 CPU/墙钟、实时倍率和工作量快照。绝对耗时随宿主和 V8 状态变化，结论以
同机三轮读数为准。

2026-11-15，Node 24.20.0：**扩展前的 MCU+LCD 基线**完成构建、类型检查、8 项正确性
测试及三轮基准。测试确认产物创建单个 instance 和单个 JIT；三轮均完成上述 440 ms
固定工作量。下表保留为基线读数，不包含新增板载器件的验证；旧 HAL oracle 的历史
状态未在本轮复核，也不能用旧读数推断本轮通过。

| 轮次 | 冷启动 CPU / ms | active CPU / ms | post CPU / ms | 总 CPU / ms | 总墙钟 / ms |
| ---- | --------------: | --------------: | ------------: | ----------: | ----------: |
| 1    |        5711.121 |        1696.914 |       200.539 |    7608.574 |    4803.857 |
| 2    |         209.898 |         644.505 |       206.970 |    1061.373 |     546.479 |
| 3    |         114.511 |         481.314 |       134.181 |     730.006 |     366.631 |

首轮包含首次翻译和 V8 预热。计时关闭测试侧的期望帧重组；这些正式产物读数与旧的
源码基准有夹具开销差异，不能据此推断算法进一步提速。扩展板载器件后是否保持这些
读数，应以重新运行的结果为准，而不是沿用旧表作结论。

## 适用限制

- **固定 3.3 V、RST 恒高**。LCD 数据读回要求 MCU 释放数据总线；I²C 上拉、按键和
  555 周期按理想值处理。模拟竞争、驱动强度、电阻容差、浮空/模拟电平、温度、EMC、
  LED 伏安特性和任意外部接线不在本示例的验证范围内。
- **不是完整 CT117E-M4 开发板**。本模型只覆盖 LCD、74HC573/8 LED/4 按键、AT24C02、
  MCP4017、R37/R38 电位器和 U7/U8 两个 555 的固定接线；不包含 DAP-Link 侧
  （STM32F103C8T6、稳压器、USB、晶振）、连接器/排针，以及未列入固定接线表的板载
  器件。
- **共享内核的 MCU 子集**：Cortex-M4 Thumb/Thumb-2 指令、GPIO、RCC、PWR（时钟配置
  所需）、SysTick、NVIC、USART1–3 发送/接收、128 KiB Flash、22 KiB SRAM、10 KiB CCM
  SRAM；LCD 侧为 16 位 8080 并口、窗口寻址、GRAM 与 RGB565 帧发布。
- **ADC/TIM/I²C 只按本板固定节点接入**：ADC 仅 PB14/PB12/PB15 三个通道，TIM 捕获仅
  PB4/PA15 两个通道，I²C 仅 PB6/PB7 的 GPIO bit-bang 从机总线。fused profile 不是
  MCU 全部 ADC/TIM/I²C 通道的通用支持入口；未接入的通道不会因寄存器可写或 GPIO
  电平而被视为已支持。
- **AT24C02 写保护不建模**：原理图 `WC#` 接 GND，本模型按始终可写处理，不提供写
  保护状态或引脚。
- 器件运行时只接收解析后的 `FirmwareImage`，不读取 HEX/BIN 文件；文件解析属于宿主或测试夹具。
- 本示例不能用来证明任意 CT117E-M4 固件或任意外部接线都与真实硬件等价；它只覆盖
  上述固定接法和 MCU 子集。
