# 官方工程固件整板联合仿真记录（2026-11-13）

用 `dist/代码/` 下的 14 个 Keil C51 工程固件，在 `ct107d.sch` 整板（48 颗器件、96 个网络）上
逐份跑联合仿真，记录板面可观测输出（LED 亮度、数码管显示、锁存器话题、串行器件话题），
并汇总由此暴露的模型与板级问题。本文是一次运行的实测记录，不是器件行为规范；器件行为
以各器件的 `docs/<id>.md` 与 `model.ddl` 为准。

本次运行前修复了首轮记录里的三个模型/夹具问题（`seg4` 极性、DS18B20 复位语义、I²C/1-Wire
紧时序的推进粒度）。下面的汇总与逐份观察都是修复后的结果；「已修复的三个问题」保留现象、
证据与改动，`12.0`/`13.0` 缺外部激励的问题不在本次范围内。

## 运行方法

固件来自仓库根的 `dist/代码/*.zip`：每个工程只有一个可执行产物 `Objects/*.hex`（Intel HEX，
C51 生成，起始记录在 `:020000`/`:030000` 之后，程序入口在 0000H）。

临时工具 `examples/ct107d/verify-firmware.mjs` 负责整条链路（完整选项见脚本头部注释）：

```bash
# 解压固件
unzip -q -o "dist/代码/1.0 led.zip" -d /tmp/ct107d-firmware   # 其余同理

# 整板联合仿真（Node ≥ 22，chevrotain 依赖 Object.groupBy）
node examples/ct107d/verify-firmware.mjs "/tmp/ct107d-firmware/1.0 led/Objects/led.hex" --ms=2600
```

- 器件：`dist/devices/<id>/device.js` + `device.json`（`mica build` 产物），与
  `verify-schematic.mjs` 同源。
- 网络：`parseSchematic` → `deriveSchematicTopology`，VCC/GND 换成 5 V / 0 V 理想源。
- 时钟：原理图里 MCU 的 `clockFrequency` 是 12 MHz（配合仓库自带演示固件），官方工程按
  11.0592 MHz 写定时器初值，本次用 `--clock=11059200` 覆盖（脚本默认值）。
- 执行模式：`--execution=precise`（默认）。官方固件的 I²C（10.0/11.0/12.0/14.0）与 1-Wire
  （9.0 等）都是软件位冲击，`throughput` 会把几十条指令合并成一段、只在段末发布电平，字节
  会错位（问题 3）。`--execution=throughput --step=2` 复现 Playground 预览的可见性。
- 步长：`--step=2`（2 ms）。`precise` 下它只是观测和输入注入的节奏，电气求解逐指令发生；
  `throughput` 下它就是实际的发布粒度。每个固件只跑 30 ms–2.6 s 仿真时间。
- 性能对比：`throughput` 的直接 JIT 有一次性编译成本。使用 `--warmup-ms=200` 在同一块板上预热，
  再单独计量 `--ms` 指定的仿真窗口；预热期的输入仍按仿真时刻注入。
- 输入注入：`--press=S9@300:150`（300 ms 按下、150 ms 后松开）、`--temp=26.5`（DS18B20
  环境温度）、`--ain0=0.8`（PCF8591 模拟输入）。
- GPIO 电气：IAP15 的准双向模式由 MCU 模型提供 10 kΩ 内部弱上拉；固件验证工具不再给板子
  注入原理图中不存在的外部电阻，因此与 Playground 使用相同的端口行为。

## 结果汇总

| 工程                    | 固件大小 | 仿真窗口 | 实际耗时 | RTF   | 观测结论                                           |
| ----------------------- | -------- | -------- | -------- | ----- | -------------------------------------------------- |
| `1.0 led`               | 125 B    | 2.6 s    | 40.63 s  | 0.064 | 走马灯逐步移动，每 500 ms 一位                     |
| `2.0 seg`               | 680 B    | 30 ms    | 1.43 s   | 0.021 | 段码/位选交替锁存，扫描链路通                      |
| `3.0 button`            | 1285 B   | 1.2 s    | 31.79 s  | 0.038 | LED 每 500 ms 一位；数码管显示时钟 `08-30-00`      |
| `4.0 keyboard`          | 1978 B   | 0.6 s    | 14.92 s  | 0.040 | 注入 S9 后显示「13 2」（键索引 + 状态）            |
| `5.0 button_keyboard`   | 1388 B   | 0.6 s    | 8.79 s   | 0.068 | 注入 S4 + S9，显示时钟与按键状态                   |
| `6.0 uart`              | 1915 B   | 0.4 s    | 18.81 s  | 0.021 | 显示「08-3」「0-00」；无串口观测                   |
| `7.0 uart_pro`          | 2260 B   | 0.4 s    | 8.55 s   | 0.047 | 同上                                               |
| `8.0 实时时钟DS1302`    | 2542 B   | 0.8 s    | 13.13 s  | 0.061 | `U19.datetime` 2 ms 内变为 `08:30:00`              |
| `9.0 温度传感器DS18B20` | 3908 B   | 1.0 s    | 24.59 s  | 0.041 | RTC 写入成功；`temperatureOut` 在 750 ms 发布 26.5 |
| `10.0 eeprom`           | 4179 B   | 0.5 s    | 13.59 s  | 0.037 | EEPROM 正确写入 `0x1E`；RTC 14 ms 内写成功         |
| `11.0 adc_dac`          | 4865 B   | 0.4 s    | 13.06 s  | 0.031 | `U16.channel` 切换 7 次；EEPROM 写入正确           |
| `12.0 超声波测距`       | 5557 B   | 0.3 s    | 9.32 s   | 0.032 | 无回波源，显示只剩分隔符；EEPROM 正确              |
| `13.0 NE555频率测量`    | 5838 B   | 0.3 s    | 9.21 s   | 0.033 | NE555 自振但输出未接 MCU，读数恒 0                 |
| `14.0 补充`             | 8602 B   | 0.3 s    | 13.31 s  | 0.023 | EEPROM 与 DS1302 都在 14 ms 内写成功               |

全部 14 份固件都没有 `faults`（运行期诊断为空）。数码管端口 `digit1`–`digit4` 始终按
「点亮的段」编码（`bit0=a`…`bit7=dp`），与实例的 `commonAnode` 无关，因此可以直接读成字符：
上表里的 `08-30-00` 是各工程共用 `time = {8, 30, 0}` 初值的时钟显示。

## 逐份观察

### `1.0 led`

修复节拍覆盖问题（见「早期修复」）之前，`U6.latch` 恒为 0xFF、`P0` 从不变化：主循环是
`CLR C / MOV A,direct / SUBB A,#05 / MOV A,direct / XRL A,#80 / SUBB A,#80 / JC`，
指令地址 0x16、0x17、0x19、0x1B、0x1D、0x1F、0x21 全都不是 `TICK_DIVISOR = 4` 的倍数，
整圈没有一个节拍点，Timer0 永远不溢出，`time_count` 永远到不了 500。

修复后：

```
U6.latch: 2ms:0xff 502ms:0xfe 1002ms:0xfd 1502ms:0xfb 2002ms:0xf7 2502ms:0xef
LEDs(>0.1): 502ms:D1 1002ms:D2 1502ms:D3 2002ms:D4 2502ms:D5
```

一次中断周期 = `500 × 1 ms`，与 11.0592 MHz、T0 1T 模式下 `TH0/TL0 = 0xD4CD` 的 1 ms 溢出一致。

### `2.0 seg` / `3.0 button` / `6.0 uart` / `7.0 uart_pro`

`U7.latch` 在段码与 `0xBF`（共阳分隔符，点亮掩码 `0x40`）之间交替，`U8.latch` 出现
`0x01`、`0x04`、`0x10`、`0x40`——正是 `1 << i` 的位选序列（共阳高电平选中），说明
P2 → 74HC138 → 74HC02 → 74HC573 的片选链路与数码管扫描都已跑通。段码端口按点亮段解码后
显示为时钟：`3.0` 是 `08-30-01`，`6.0`/`7.0` 是 `08-30-00`。

`3.0 button` 的 `U7.latch` 在 1.2 s 内变化 389 次，即扫描周期约 3.1 ms；`2.0 seg` 的
`U8.latch` 只留下十几条，是因为话题按 2 ms 批次只保留最后一条（见限制 1）。

### `4.0 keyboard` / `5.0 button_keyboard`

`4.0` 的矩阵扫描先拉低列（`P44`/`P42`/`P35`/`P34`）再读行（`P33`–`P30`）。注入 S9 后：

```
U7.latch: 2ms:0xff 322ms:0xf9 324ms:0xff 330ms:0xf9 …  共 71 次
DS1 末值: 0x06 0x4f 0x00 0x5b   显示「13 2」
```

`0xF9` 是 `seg_code[1]` 的共阳驱动码，锁存点亮的段是 `0x06`（字符 `1`）；`seg_buffer[3]`
的 `0x5B`（字符 `2`）对应 `keyboard[i].state = 2`。但 `digit2` 是 `0x4F`（字符 `3`），即
`seg_code[i%10]` 的 `i = 13`，而不是按「列 `P42`、行 `P32`」推出来的 `i = 5`：

- 原理图里 J13 把 `P42/WR` 短接到 GND（模拟「WR 接 0 V」的装配位置），因此固件把
  `P42 = 1` 也拉不高——S9 所在列的按键会把 `P32` 永久拉低，每一列的扫描都读到该行低。
- `keyboard_action()` 顺序遍历 `i = 0..15`，最后一次匹配覆盖前面的结果，于是显示落在最后
  一列（`P34`）的索引 `12 + 1 = 13`。

这是当前装配（J13 闭合）下的真实行为，不是仿真误差；要验证列索引需要把 J13 打开或改用
不经过 `P42` 的按键。

`5.0` 同时注入 S4（独立按键）与 S9，时钟被改到 `08-31-59`：S4 的递减与 S9 改变的
`time.index` 都生效了。

### `8.0` / `9.0` / `10.0` / `11.0`

DS1302 三线时序在所有四份固件里都写成功：`U19.datetime` 从 `2026-01-01 00:00:00`
在 2–16 ms 内变为 `2026-01-01 08:30:00`，与 `ds1302_set_time(time.hour, time.minute,
time.second)` 的初值 `{8, 30, 0}` 一致。

`9.0` 注入 `--temp=26.5` 后，`U5.temperatureOut` 在转换满 750 ms 时发布 `26.5`，之后
每次读取都基于上一轮转换结果。`10.0`/`11.0` 的 `U4.dump` 在 6 ms 时出现 `1e`（`0x1E`）：
`at24c02_write_byte(8, 30)` 被正确写入，读回路径（`at24c02_read_byte`）也走通了。
`11.0` 的 `U16.channel` 在 400 ms 内切换 7 次。

### `12.0 超声波测距` / `13.0 NE555频率测量` / `14.0 补充`

- 12.0 的超声波换能器没有器件模型，`sonic_receive()` 的 `while(Rx && !TF1)` 总是超时，
  距离读数为 0；显示只剩分隔符（点亮掩码 `0x40`）。它的 EEPROM 写入与 10.0 一致，
  `U4.dump` 在 6 ms 出现 `0x1E`。
- 13.0 用 PCA 捕获 NE555 的 `NET_SIG`，但 `ct107d.netlist.json` 里 `NET_SIG` 只连
  `U15.out`，没有连到 MCU 的任何引脚——按现有原理图无法测量。`U15` 自身按默认
  `frequency=4810.0048 Hz`、`dutyCycle=66.67%` 自振。
- 14.0 的 EEPROM 与 DS1302 在 300 ms 窗口内都写成功（`U4.dump` 6 ms 出现 `0x1E`，
  `datetime` 14 ms 变为 `08:30:00`），首轮记录里「150 ms 内都没完成」是推进粒度问题，
  而不是固件顺序问题。

## 问题与修复

### 问题 1（已修复）：`seg4` 段码极性与 CT107D 实物相反

**现象**：整板跑官方固件时，段码话题的值是固件写入值的取反，且被锁存的位与位选序列错开
一位。例如 `2.0 seg` 写 `0xC0`（共阳 `0`），`seg4` 报告的 `digit` 是 `0xC0`，但按模型自己
的约定（`bit0=a`…`bit7=dp` 高电平点亮）这对应「a、b、c、d、e、f 全灭、g 亮」，不是数字 0；
`3.0 button` 写 `1 << i` 选中第 i 位，模型却把 `com` 为高的位判为选中（模型里 `com` 低
有效）。

**证据**：

- 模型 `model.ddl` 注释与 `examples/seg4/README.md` 都写「共阴」「公共阴极低有效」，
  `digit` 编码为段脚高电平点亮的掩码。
- 官方固件的段码表 `{0xC0, 0xF9, 0xA4, …}` 是共阳编码（`0` = a–f 低、g/dp 高），
  位选 `P0 = 1 << i` 配合 `Y6` 是「共阳位驱动」写法。
- 用共阳解释跑出来的结果自洽：`0xC0→0`、`0xF9→1`、`0x92→5`、`0xBF→-`、`0xFF→空`。

**修法**：`seg4` 增加 `commonAnode: bool` 属性（默认 `false`），`com` 的选中极性和段脚的
点亮极性都由它决定，`digit1`–`digit4` 仍然按「点亮的段」编码，因此适配器、话题与 board
widget 都不用改。CT107D 的两片数码管在 `build-schematic.mjs`/`ct107d.sch` 里配成
`commonAnode: true`；`examples/seg4` 与 `examples/ct107d/src/devices/seg4` 两份镜像同步，
新增共阳用例（`0xC0 → 0x3F`、共阴/共阳互补、共阳扫描保持）。

顺带修了仓库自带的演示固件：它的「段码 `0xFF` = 全亮、位选 `0xFE` = 选第 1 位」是按共阴写的，
改成共阳后若仍逐位扫描，`U6` 在粗粒度推进下会把位选值锁存成 LED 图案（旧极性下这恰好也是
「只有一个 0 位」，所以看不出来）。现在演示固件上电把段码 `0x00`（全亮）与位选 `0xFF`
（八位全选）各锁存一次，主循环只刷新 LED 锁存并把 LE 高电平相位保持满一个 DELAY（实测
约 4 ms），因此 `throughput` 与 `precise` 都能稳定锁存。逐位扫描链路由 `verify-schematic.mjs`
的专用固件继续覆盖（8 位分别锁存 0–7 的点亮掩码）。

### 问题 2（已修复）：DS18B20 的转换永远完不成

**现象**：注入 `--temp=26.5` 后，`U5`（DS18B20）的 `temperatureOut` 话题一次都不发布，
蜂鸣器判定用的是上电暂存器里的 +25.0 ℃。

**证据**：官方模板 `onewire.c` 的 `ds18b20_get_temp()` 是

```c
init_ds18b20(); Write_DS18B20(0xCC); Write_DS18B20(0x44);   // Convert T
init_ds18b20(); Write_DS18B20(0xCC); Write_DS18B20(0xBE);   // Read Scratchpad
low = Read_DS18B20(); high = Read_DS18B20();
```

`main.c` 里 `tim_temp` 每 50 个 1 ms 节拍置位，主循环每次置位都调用一次
`ds18b20_get_temp()`。因此在 750 ms 转换期内会连发 15 次 Convert T，转换永远从头开始；
即使没有复位，暂存器也拿不到新值。给模型加临时调试通道后可以看到模型每 ~50 ms 依次收到
`0xCC`、`0x44`、`0xCC`、`0xBE`，但 `finishConversion()` 一次都没触发；此外首轮实现还在
`busReset()` 里中止转换，使「Convert → 复位 → 读」的模板更不可能拿到结果。

**修法**：`busReset()` 只清协议状态机，不再中止转换（与真实芯片一致，转换由内部定时器
独立完成）；转换进行中的 Convert T 被忽略，不重启 750 ms 计时。这样 50 ms 轮询的模板在
750 ms 后拿到本次转换结果，之后每次读的都是上一轮完成值。`test/ds18b20.test.ts` 的用例
改成断言「Convert 后的复位不中止转换、等满 750 ms 读到注入值」；`docs/ds18b20.md` 的
实现要点与理想化同步更新。

修复后 `9.0` 在 1.0 s 窗口里 `U5: temperatureOut=26.5(1)`。注意 1-Wire 位冲击同样要求
`precise`：`throughput` 下 2 ms 的发布粒度会把位时隙合并掉，模型按错位字节（`0x00`、
`0xC0`）解码，收不到 `0xCC`/`0x44`。

### 问题 3（已修复）：AT24C02 与官方 I2C 驱动不兼容

**现象**：`10.0 eeprom` 启动时 `temp.alarm = at24c02_read_byte(8)` 返回 0，于是走
`at24c02_write_byte(8, 30)` 分支；`throughput` 下 `U4.dump` 的三次发布依次是

```
2ms:  00 00 00 00 00 00 00 00 00 00 00 00 …   （上电）
4ms:  00 00 00 00 00 00 00 00 a1 ff 00 00 …   （地址 8 被写成 0xA1 = 读地址字节）
6ms:  00 00 00 00 00 00 00 00 3c ff 00 00 …   （地址 8 被写成 0x3C = 0x1E << 1）
```

即：读事务的地址字节 `0xA1` 被当成数据写进了 EEPROM；随后的写数据 `0x1E` 又左移一位变成
`0x3C`。

**证据**：

- 把 `10.0` 固件的 T0 中断向量（0x0B）改成 `RETI` 后仍复现（`/tmp/10.0-eeprom-no-isr.bin`），
  可排除「中断打断 I2C 位流」与 P2 竞态。
- 用仓库 `test/at24c02.test.ts` 的时序（每个电平变化后显式推进 2 µs）复刻官方
  `at24c02_read_byte` + `at24c02_write_byte`，写入是正确的 `0x1E`；把每步推进改成 1 µs 也
  正确。说明问题出现在「电平变化之间没有额外推进」的紧时序上。
- 电气网络只在推进边界求解：`throughput` 的直接 JIT 会把整段指令合并到下一个事件或
  `runUntil` 目标，AT24C02 自身不排事件，所以 2 ms 的 `--step` 就是事实上的采样周期，
  90 µs 的位时隙被整体混叠。
- `cpuQuantum` 不是可用的调节旋钮：`runtime.ts` 只校验 1..10 000 000 ps，随后丢弃，
  框架其余部分不再引用；推进粒度由 `runUntil` 目标、模型事件与 JIT 段边界决定。

**修法**：`verify-firmware.mjs` 增加 `--execution=<precise|throughput>`（默认 `precise`）
与 `--quantum=<ps>`，把执行模式传给 `createBoard` 的 `BoardOptions`。`precise` 逐指令求解，
位冲击的每个电平变化都会发布，I²C/1-Wire 时序不再被混叠：

```
precise, 10.0, --ms=500:  U4.dump: 2ms:00…  6ms:00 00 00 00 00 00 00 00 1e 00 00 00 …
```

模型本身没有改：`at24c02.test.ts` 的位级状态机、页回绕与 WP 用例本来就正确。需要保留
Playground 预览口径时用 `--execution=throughput --step=2`，此时 10.0 仍会复现 `0xA1`/`0x3C`。

### 问题 4（保留，不在本次范围）：`12.0` / `13.0` 缺外部激励

**现象**：

- `13.0` 的 `NET_SIG` 在 `ct107d.netlist.json` 里只连 `U15.out`，没有连到 MCU。固件把
  PCA 时钟源设为 ECI 且 `CCP_S1:CCP_S0 = 01`，模型里该组的 ECI 是 `P34`，而 `P34` 上只有
  矩阵键盘第 3 列——缺的是实物跳线（J3）那一段。
- `12.0` 的超声波换能器（发射/接收）没有器件模型，`sonic_receive()` 必然超时。

**影响**：这两份固件的核心功能（频率测量、距离测量）在整板仿真里无法验证，只能观察到
显示刷新与串行外设初始化；`14.0` 的超声页与频率页因此同样读不到有效值（`999` 与 `0`）。

**修法与验收判据**：见 [`official-firmware-gaps.md`](official-firmware-gaps.md)，其中也列出了
`6.0`/`7.0` 串口可观测的两项必做改动（MCU 串口端口 + 独立 `uart-probe` 器件）。

## 观测口径的已知限制

1. **话题只保留每批最后一条**。脚本每 2 ms 取一次快照，`sync(batch)` 里同一话题的多条
   消息只取最后一条，因此 `U8.latch` 的 8 个位选在一个扫描周期内只留下少数几条。要看
   完整的扫描序列，应把 `--step` 调到小于锁存间隔（例如 0.2 ms），代价是耗时线性增长。
2. **锁存捕获依赖发布粒度**。74HC573 的 LE 脉冲宽度与电气采样点的关系决定锁存能否被看到：
   `precise` 逐指令求解，几百纳秒的脉冲也能捕获；`throughput` 只在事件与 `runUntil` 边界
   求解，整段指令内的中间电平会丢失。演示固件因此把 LE 高电平相位拉到一个 DELAY（实测
   约 4 ms），保证粗粒度推进也能稳到；官方固件的短脉冲只能靠 `precise`。
3. **串口无可观测端口**。`iap15f2k61s2` 没有 `ports` 声明，`U1` 的 TXD 不上任何话题；
   6.0/7.0 的发送内容与接收行为都未被验证。要验证需要给 MCU 增加串口输出端口，或在
   装配侧挂一个位级 UART 探针。
4. **时间尺度**。RTF 0.021–0.068 意味着 1 s 仿真要跑 15–48 s 墙钟；8.6 KB 的 14.0 在
   300 ms 窗口里已经要 13 s。长期功能（走时到分钟、超时重试）无法在整板里验证，需在
   `iap15f2k61s2` 单板夹具里用更小的网络跑。

## 早期修复：节拍点漏掉紧循环

`iap15f2k61s2` 原来只在两类 PC 上推进外设：

- `pc % TICK_DIVISOR == 0`（`TICK_DIVISOR = 4`）；
- 回跳距离小于 `TICK_DIVISOR` 的转移指令。

第二种条件的本意是补上 `SJMP $`、`JNB RI,$` 这类短循环，但漏掉了「整圈都长于 4 字节
且没有一个地址对齐」的循环——官方 `1.0 led` 的主循环正是这种形状（0x16–0x21，回跳距离
11 字节，没有 4 的倍数）。结果是 Timer0 不溢出、中断不响应、`P0` 恒为 0xFF。

修复：回跳一律算节拍点。两处镜像（`examples/iap15f2k61s2` 与 `examples/ct107d`）同步，
回归用例在 `examples/iap15f2k61s2/test/timer.test.ts` 的「节拍覆盖」组：同一段紧循环
固件在旧实现下 `P2` 读到 `0xFF`，新实现下正确写入 `0xA5`。MCU 工程 96 个用例全部通过。

## 复现

```bash
export PATH="$HOME/.nvm/versions/node/v24.20.0/bin:$PATH"   # 需要 Node ≥ 22
cd /home/ll/mica-js/examples/ct107d
npx mica build                                                # 刷新 dist/devices

# 走马灯（先确认节拍修复生效）
node verify-firmware.mjs "/tmp/ct107d-firmware/1.0 led/Objects/led.hex" --ms=2600

# 矩阵键盘
node verify-firmware.mjs "/tmp/ct107d-firmware/4.0 keyboard/Objects/project.hex" \
  --ms=600 --press=S9@300:150

# EEPROM 写入（precise 默认值；加 --execution=throughput 可复现 0xA1/0x3C 错位）
node verify-firmware.mjs "/tmp/ct107d-firmware/10.0 eeprom/Objects/project.hex" --ms=500

# 温度注入（1-Wire 位冲击需要 precise）
node verify-firmware.mjs "/tmp/ct107d-firmware/9.0 温度传感器DS18B20/Objects/project.hex" \
  --ms=1000 --temp=26.5
```
