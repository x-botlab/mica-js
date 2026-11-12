# led8：IAP15F2K61S2 驱动 8 颗蓝色 LED

用 [`iap15f2k61s2`](../iap15f2k61s2/README.md) 与 [`blue-led`](../blue-led/README.md) 两个器件工程的交付产物搭一块最小板：
P2.0–P2.7 各接一颗蓝色 LED，用 `Project.hex` 固件跑走马灯。

```
led8/
  led8.sch        原理图：1 颗 MCU、8 颗蓝色 LED、VCC 母线、P2 网标
  Project.hex     固件（Intel HEX）
  Project.bin     固件裸二进制（Project.hex 去掉 Intel HEX 记录后的 79 字节）
  verify.mjs      无头验证：折网表、装载产物、跑固件、检查点亮顺序
  package.json    验证脚本的依赖声明
```

## 电路

| 位号  | 器件                   | 连接                                                      |
| ----- | ---------------------- | --------------------------------------------------------- |
| U1    | `xbotlab:iap15f2k61s2` | VCC 接 5 V、GND 接地；P2.0–P2.7 经网标 `P2_0`–`P2_7` 引出 |
| D1–D8 | `xbotlab:blue-led`     | 阳极经 VCC 母线接 5 V，阴极分别接 `P2_0`–`P2_7`           |

- **低电平点亮**：8051 准双向口灌电流，固件把 P2 的某一位写 0 时对应 LED 导通；写 1 时
  端口释放，阴极悬空，亮度按 0 处理。
- **不串限流电阻**：`blue-led` 自带 500 Ω 等效串联电阻。5 V 经端口下拉的 25 Ω 到地，
  正向电流 5 V / 525 Ω ≈ 9.5 mA，亮度 ≈ 0.476（额定 20 mA）。低于器件的 20 mA 额定值，
  也低于端口灌电流上限。
- **网表**：VCC 接 9 个引脚（U1 电源脚 + D1–D8 阳极），GND 接 1 个引脚（U1 地脚），
  `P2_0`–`P2_7` 各接 2 个引脚（MCU 引脚 + 对应 LED 阴极）。未用引脚保持开放。
- 阳极侧用一条 VCC 母线 + 8 个显式交点分支；P2 用同名网标跨接，避免 8 根长导线交叉。

## 固件

`Project.hex` 是 Intel HEX；器件属性 `firmware` 是**裸二进制**，所以 `Project.bin` 是去掉
记录头/校验和后的字节映像（79 字节）。反汇编要点：

| 地址    | 内容                                                                          |
| ------- | ----------------------------------------------------------------------------- |
| `0000H` | `LJMP 0043H`                                                                  |
| `0003H` | 主循环：`MOV P2,#0FEH` → `LCALL 0035H`，随后 `FD/FB/F7/EF/DF/BF/7FH` 依次重复 |
| `0033H` | `SJMP 0003H`（回到主循环）                                                    |
| `0035H` | 延时子程序：`R7=04H`、`R6=0CDH`、`R5=0BBH` 三层 `DJNZ` 嵌套后 `RET`           |
| `0043H` | 复位初始化：清 `00H–7FH` 内部 RAM、`SP=07H`、`LJMP 0003H`                     |

即 P2 上始终只有一个 0，从 P2.0 走到 P2.7 后回卷，对应 D1 → D8 依次点亮。延时循环约
15.4 万次 `DJNZ`，11.0592 MHz 下每步约 90 ms（仿真观测值）。

## 验证

```powershell
cd dist\led8
node verify.mjs              # 800 ms 仿真窗口，覆盖 D1 → D8 → D1
node verify.mjs --ms 200     # 只跑前几步，用于冒烟
node verify.mjs --quiet      # 只输出结论
```

脚本按宿主运行时的真实路径工作：

1. `parseSchematic` 读取 `led8.sch`，`deriveSchematicTopology` 用两个器件的符号几何折出网表；
   检查悬空端点、P2 引脚网络名、每颗 LED 阴极与对应引脚同网、VCC/GND 成员数。
2. 读取 `Project.bin`（缺失时就地转换同目录的 `Project.hex`）作为 `firmware` 资源。
3. 用 `createDeviceLibrary` / `createBoard` 装载 `../iap15f2k61s2/dist/devices/iap15f2k61s2/device.js`
   与 `../blue-led/dist/devices/blue-led/device.js`，按原理图实例属性与网表建板。
4. 以 10 ms 为步长推进，记录 `brightness` 话题，断言：同一时刻只有一颗亮、顺序为
   D1 → D8、8 颗都亮过、点亮亮度 ≈ 5 V / (500 Ω + 25 Ω) / 20 mA。

实测输出：

```text
器件：
  U1  xbotlab:iap15f2k61s2  79 字节固件，11059200 Hz
  D1–D8  xbotlab:blue-led  500 Ω / 20 mA
网表：10 个网络，VCC 接 9 个引脚，GND 接 1 个引脚

点亮时间线：
  t=  10 ms  D1
  t= 100 ms  D2
  t= 190 ms  D3
  t= 280 ms  D4
  t= 370 ms  D5
  t= 460 ms  D6
  t= 550 ms  D7
  t= 640 ms  D8
  t= 730 ms  D1
...
✓ 8 颗蓝色 LED 均按 P2.0 → P2.7 的走马灯顺序点亮
```

800 ms 仿真约需 1.6 s 墙钟时间（器件优化前是 75–190 s）：延时子程序是 `DJNZ` 紧循环，
节拍点仍覆盖每个回跳（见 iap15f2k61s2 README 的「外设节拍」），但节拍块只累加时间与门控，
外设推进入口集中在共享服务块，空闲时热循环全部走 JIT 直接后端。

## 依赖

`verify.mjs` 优先使用本目录安装的 `@mica-js/document` / `@mica-js/sdk`；未安装时回退到
`../iap15f2k61s2/node_modules` 里的同一套依赖（两个器件工程已装好）。要建立本地副本：

```powershell
cd dist\led8
pnpm install
```

## 已知简化

- `blue-led` 是线性等效电阻：没有正向压降、反向截止与发光效率，反向电流为负但亮度恒为 0。
- 准双向口释放时只建模为高阻，不建模弱上拉；因此未点亮的 LED 阴极为浮空，亮度读数 0。
- 原理图只使用这两个器件与内建电源/地/网标；没有限流电阻、晶振、复位电路与去耦电容。
- 器件引用使用 `xbotlab:` 包 ID，宿主需要把该包映射到两个 `dist/devices/<器件ID>/` 目录。
  仓库的 playground 目前只注册 `demo:` 器件，所以不能直接在主页面打开本原理图。
