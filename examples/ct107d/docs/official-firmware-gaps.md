# 官方工程固件验收缺口与所需改动（2026-11-13）

本文记录 `dist/代码/` 下 14 个 Keil C51 工程在 `ct107d.sch` 整板上无法通过完整验收的条目，
以及为此需要补的器件、端口、网络与夹具。实测数据与已修复的问题见
[`official-firmware-simulation.md`](official-firmware-simulation.md)；器件行为以各器件的
`docs/<id>.md` 与 `model.ddl` 为准。

## 验收口径

一份固件「通过验收」指：它 `main.c` 里声明并在本次窗口内实际执行的核心功能，能在板面端口或
器件话题上产生可判读、可对照源码预期的结果。只有「显示刷新了」「没有 faults」不算通过。

判读依据（`verify-firmware.mjs`）：

- 数码管 `digit1`–`digit4` 端口按「点亮的段」编码（`bit0=a`…`bit7=dp`），可直接解码成字符。
- 串行器件用话题：`U4.dump`（AT24C02）、`U19.datetime`（DS1302）、`U5.temperatureOut`
  （DS18B20）、`U16.channel`/`aout`（PCF8591）。
- 按键与传感器注入用 `--press`、`--temp`、`--ain*`；同一个位号可以重复给 `--press`，
  用于连按切页。

## 无法通过完整验收的固件

### 硬缺口：核心功能无法产生可判读结果

#### `12.0 超声波测距` — 距离恒为超时值 999

- `sonic.c` 用 `Tx = P10` 发 8 个 12 µs 脉冲，用 `Rx = P11` 等回波
  （`while(Rx && !TF1)`，T1 20 ms 超时）；无回波时 `sonic_get_data()` 返回 999。
- 原理图 `ct107d.netlist.json` 中 `P10` 只有 `["J2.p3", "U1.P1_0"]`，`P11` 只有
  `["J2.p4", "U1.P1_1"]`；J2 的实例属性是 `vs1838: true`，即 4-6 短接，`P11` 实际读的是
  VS1838 的输出（无载波时恒高），而超声波换能器本身没有器件模型。
- 实测：按 `S9` 三次切到第 4 页（超声页）后，`DS2` 的千/百/十位都出现 `0x6F`（字符 `9`），
  即 `999`。EEPROM、RTC、温度、ADC 都正常。

#### `13.0 NE555频率测量` — 频率恒为 0

- `ne555.c` 的 `ne555_start()` 写 `CMOD = (CMOD & 0xF0) | 0x06`（`CPS2:CPS0 = 011`，ECI
  边沿计数）与 `P_SW1 = (P_SW1 & ~0x30) | 0x10`（`CCP_S1:CCP_S0 = 01`）。
- MCU 模型 `peripherals/pca.ts` 的复用组下标 1 为
  `[P3.5, P3.6, P3.7, P3.4]`，其中第 4 项是 ECI，即 ECI 落在 `P34`。
- 但 `ct107d.netlist.json` 里 `NET_SIG` 只有 `["U15.out"]`，`P34` 只有
  `["S16.a", "S17.a", "S18.a", "S19.a", "U1.P3_4"]`。缺的是实物上把 NE555 输出接到
  `P34` 的跳线（`README.md` 已把 J3 列为未实现器件）。
- 实测：按 `S9` 四次切到第 5 页（频率页）后，五位全是 `0`；`U15` 自身按默认
  `frequency=4810.0048 Hz`、`dutyCycle=66.67%` 自振。

#### `14.0 补充` — 6 页里 2 页不可验收

页面顺序是时钟 / 温度 / ADC / 超声 / NE555 / LED PWM。第 4 页复用 `seg_update_sonic()`、
第 5 页复用 `seg_update_ne555()`，因此与 12.0、13.0 同源：超声页读到 `999`，频率页读到 `0`。

其余 4 页可验收：`U5.temperatureOut=30.5`、`U16.aout`/`channel` 有动作、LED PWM 有锁存
变化；EEPROM（`U4.dump` 在 6 ms 写入 `0x1E`）与 DS1302（14 ms 写入 `08:30:00`）也成功。

### 观测缺口：功能可能正确，但整板拿不到判据

#### `6.0 uart` / `7.0 uart_pro` — 串口收发不可观测

- 数码管时钟、按键、LED 路径都能验收（显示 `08-3` / `0-00`）。
- `iap15f2k61s2` 的 `device.json` 没有 `ports` 字段，`model.ddl` 也没有声明任何
  channel，因此 `U1` 的 TXD/RXD 不上任何话题；`setTime:HH:MM:SS` 的解析与
  `success`/`failure` 回应都不产生可观测输出。
- 这两份要同时用两种手段验收：MCU 侧增加串口端口（方案 A，直接看固件收发内容），板上
  增加独立的串口探针器件（方案 B，从引脚电平独立复原帧，证明总线上真的走了数据）。
  两者都实现后，A/B 的帧内容应逐字节一致。

## 可通过验收的 9 份

`1.0 led`、`2.0 seg`、`3.0 button`、`4.0 keyboard`、`5.0 button_keyboard`、
`8.0 实时时钟DS1302`、`9.0 温度传感器DS18B20`、`10.0 eeprom`、`11.0 adc_dac`。

两处判读注意：

- `4.0 keyboard` 注入 `S9` 后显示索引 `13` 而不是 `5`，是当前装配（J13 把 `P42/WR` 短接
  GND，`S9` 所在列拉不高、行 `P32` 恒低，`keyboard_action()` 取最后一次匹配）导致的真实
  行为，不是固件失败。判据要按「最后一次匹配」解释，或先打开 J13。
- 全部 14 份固件在 `--execution=precise`（默认）下都没有 `faults`。

## 需要补的改动

### 1. `13.0`：补 `NET_SIG → MCU`

- 在 `build-schematic.mjs` 的网表里把 `U15.out` 接到 `U1.P3_4`；若要保留实物跳线语义，
  额外加一个 `xbotlab:jumper` 实例（`J3`）串在中间，默认 `closed: true`。
- 重新生成 `ct107d.sch` 与 `ct107d.netlist.json` 后跑 `verify-schematic.mjs` 确认网表一致。
- 验收判据：`13.0` 切到频率页后显示 `04810` 附近（`U15` 默认 `4810.0048 Hz`，计 1000 ms
  边沿数），而不是 `0`；`14.0` 第 5 页同理。

### 2. `12.0` / `14.0`：补超声波换能器

- **新增器件**：一个超声波收发器件，`trig` 引脚检测 `P10` 的 8 个脉冲串后，在 `echo`
  上等待 `2 × distance / 340 m·s⁻¹` 的往返传播时间再拉低一个等宽脉冲（固件实际等待
  `P11` 由高变低）。可参考 `cx20106a`/`vs1838` 的定时器写法（`now()` + `await ticks()` +
  序号取消旧请求），距离用 `distanceCm` / `echoUs` 属性注入。装配时把 `trig → P10`、
  `echo → P11` 接上，并让 J2 的 `vs1838` 选择与回波高阻空闲兼容的红外接收侧。

验收判据：`12.0` 第 4 页显示的厘米数与注入距离一致（源码公式 `time_us * 17 / 1000`）。

### 3. `6.0` / `7.0`：串口可观测（方案 A + B 都要实现）

两项改动同时落地，缺一不可：方案 A 证明固件自己认为发了什么，方案 B 证明引脚上真的
出现了同样的帧。串口探针是**独立器件**（`src/devices/uart-probe/`），不是
`verify-firmware.mjs` 里就地编译的夹具模型，因为它要能进原理图、画布与 Playground 预览。

#### 方案 A：`iap15f2k61s2` 增加串口端口

- `model.ddl` 增加 `output channel uart1Tx: bytes(maxLength: 1, capacity: 16, overflow: Overflow.drop_oldest)`
  与 `input channel uart1Rx: bytes(...)`（或一个 `uart1Rx` 输出端口汇报已收到的字节）；
  `device.json` 的 `ports` 同步声明，`test/manifest.test.ts` 会自动比对两份声明。
- `peripherals/uart.ts` 在帧的停止位完成时 `body.send('uart1Tx', ...)`（IR 构建器的
  `send` 只接受输出通道），接收同理。注意 `send` 是可观察效果，会让该指令离开直接
  后端；只在真正收发字节时发，不在每位都发。
- 适配器 `index.ts` 的 `sync(batch)` 把 `batch.outputs.uart1Tx` 转发到同名话题。
- 端口负载选 `bytes`（每字节一条消息），不累积整行：`success`/`failure` 这类响应很短，逐
  字节更接近线上字节流；要按行判读时由夹具自己拼接。

#### 方案 B：新增独立器件 `uart-probe`

- 目录：`src/devices/uart-probe/{model.ddl,device.json,index.ts}`，文档 `docs/uart-probe.md`，
  用例 `test/uart-probe.test.ts`（与其它器件同构，`test/manifest.test.ts` 自动纳入）。
- 引脚：`rxd`（输入，接 MCU 的 TXD）、`txd`（输出，接 MCU 的 RXD）、`vcc`/`gnd`。
- 属性：`baud`（默认 9600）、`driveResistance`（默认 25 Ω）。波特率按属性换算成
  `round(1e12 / baud)` ps 的位时间，不写死。
- 端口：`tx: bytes`（探针从 `rxd` 复原出的字节，每字节一条）、`rx: bytes`（探针注入的
  字节）；`input channel send: bytes` 或逐字节的 `number` 用于注入命令。
- 行为：8N1、空闲高；`rxd` 下降沿开帧，在每位中点采样，停止位校验后发布；注入时按
  `now()` + `await ticks()` 依次驱动起始位/8 数据位/停止位，并用序号取消未完成的注入。
  可参考 `vs1838`/`ds18b20` 的定时器写法；溢出与未知电平按低处理，帧错误丢弃并计数
  （可选 `errors` 端口）。
- 装配：`build-schematic.mjs` 加 `UART_PROBE_REF`、实例与网络。MCU 的实际 UART1 复用方向是
  `P3.1/TXD`、`P3.0/RXD`，因此把 `P31/RXD → probe.rxd`、`P30/TXD → probe.txd`；同时在
  `CHIP_IDS`（`verify-schematic.mjs`、`verify-firmware.mjs`）与 `README.md` 的器件表/数量里
  登记（连同超声波器件从 21 个变成 23 个）。
- 夹具：`verify-firmware.mjs` 增加 `--uart=<text>`（按 9600 bps 经探针注入，自动补 `\r`），
  并打印 `tx`/`rx` 话题；`--uart-baud=<n>` 可选。
- 单测不依赖 MCU：`test/uart-probe.test.ts` 用数字源按 9600 bps 逐位驱动 `rxd`、用探针读
  `txd`，就能覆盖接收采样点、起始/停止位校验、帧错误与注入时序。

#### 验收判据

- 注入 `setTime:20:59:50` 后：`U1.uart1Tx` 与 `uart-probe.tx` 都出现 `success`，两者逐字节
  一致；数码管显示 `20:59:50` 并继续走时。
- 注入非法值（如 `setTime:99:99:99`）后两份输出都是 `failure`，时钟不变。
- 注意这两份固件的 `setTime` 只改 RAM 里的 `time` 结构、不写 DS1302，因此
  `U19.datetime` 不会变。

## 复现命令

```bash
export PATH="$HOME/.nvm/versions/node/v24.20.0/bin:$PATH"
cd /home/ll/mica-js/examples/ct107d
npx mica build

# 12.0：连按 3 次切到超声页，默认 100 cm 应观测到 099（固件整数截断）
node verify-firmware.mjs "/tmp/ct107d-firmware/12.0 超声波测距/Objects/project.hex" \
  --ms=900 --step=0.2 --press=S9@100:60 --press=S9@300:60 --press=S9@500:60

# 13.0：连按 4 次切到频率页，应观测到 04810
node verify-firmware.mjs "/tmp/ct107d-firmware/13.0 NE555频率测量/Objects/project.hex" \
  --ms=2000 --press=S9@100:60 --press=S9@300:60 --press=S9@500:60 --press=S9@700:60

# 14.0：6 页依次切换
node verify-firmware.mjs "/tmp/ct107d-firmware/14.0 补充/Objects/project.hex" \
  --ms=2600 --temp=30.5 --ain0=0.8 \
  --press=S9@100:60 --press=S9@300:60 --press=S9@500:60 \
  --press=S9@700:60 --press=S9@900:60 --press=S9@1100:60

# 6.0 / 7.0：经独立探针注入命令，同时打印 MCU 与线上两侧的字节流
node verify-firmware.mjs "/tmp/ct107d-firmware/6.0 uart/Objects/project.hex" \
  --ms=600 --uart=setTime:20:59:50
node verify-firmware.mjs "/tmp/ct107d-firmware/7.0 uart_pro/Objects/project.hex" \
  --ms=600 --uart=setTime:20:59:50
node verify-firmware.mjs "/tmp/ct107d-firmware/7.0 uart_pro/Objects/project.hex" \
  --ms=600 --uart=setTime:99:99:99
```

## 2026-11-14 落地与复测

- `J3`、`ultrasonic`、`uart-probe` 已进入原理图；`iap15f2k61s2` 已增加 `uart1Tx` / `uart1Rx`
  端口、话题转发和逐帧发布。`verify-firmware.mjs` 支持 `--distance`、`--uart`、`--uart-baud`、
  `--uart-at` 与 `--display-after`。
- `13.0` 在频率页观测到 `0/4/8/1/0` 各字形，即约 `04810`；`14.0` 六页切换无 faults，
  温度页读到 `30.5`、ADC 与 LED PWM 均有动作。
- `12.0` 在默认 `100 cm` 下观测到 `099`：固件以 `time_us * 17 / 1000` 做整数截断，`100 cm`
  的理论回波时间会少算约 1 cm；不再出现超时值 `999`。
- `7.0` 注入合法值得到两侧逐字节一致的 `success`，非法值得到两侧一致的 `failure`；
  `U1.uart1Rx` 与 `UART_PROBE.rx` 都完整复原 17 字节的 `setTime:...\r`。
- `6.0` 同样能完整接收 17 字节，但只发出响应首字节 `s` 或 `f` 后停住。其
  `uart_send_byte()` 在主循环轮询 `TI`，而 UART ISR 同时清除了 `TI`；这是固件应用层竞争，
  不是新增 MCU 串口端口或探针的模型缺陷。因此 `6.0` 的 A/B 可证明首字节确实上线，但完整
  `success`/`failure` 验收仍需修正该固件。
