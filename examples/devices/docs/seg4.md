# 四位数码管器件包

四位七段数码管（CT107D 上的 DS1/DS2 之一）的 Mica 器件工程。器件 ID 是 `seg4`：
8 个段脚与 4 个公共端之间是 32 条等效电阻支路，显示内容按「选中位时锁存段码」的方式
体现多路扫描结果；`commonAnode` 选择共阴（默认）或共阳极性。构建产物是
`dist/devices/seg4/{device.json, device.js}`。

器件源码位于器件库 `examples/devices/src/devices/seg4`，随
`pnpm --filter @mica-js/example-devices build|typecheck|test` 一起构建与验证。

## 目录

```
examples/devices/
  mica.config.ts                       器件库工程标志
  package.json                         build = mica build，typecheck = mica prepare && tsc --noEmit
  tsconfig.json
  vitest.config.ts
  src/devices/seg4/
    device.json                        12 个引脚、两项属性、四个段码端口、四位数字符号
    model.ddl                          采样式选位、段码编码与锁存
    index.ts                           把四个段码端口发布到同名话题
  test/seg4/
    harness.ts                         板级夹具：DDL + 适配器 + 12 个数字驱动源
    device.test.ts                     源码级行为用例
    artifact.test.ts                   交付产物用例（device.js / device.json）
```

## 模型要点

- **电气**：每根段脚都声明四条 `resistor(to: com1..com4, resistance: forwardResistance)`，
  8 段 × 4 位共 32 条支路。平台的电气合同只提供线性电阻意图，所以「段」是一段双向电阻：
  共阴管段脚高、公共端低时该段点亮，共阳管段脚低、公共端高时点亮；极性相反时按电阻
  反向导通但不发光。
- **选位**：`commonAnode` 为 false（默认）时公共端低有效，为 true 时高有效。位脚被选中时
  模型把此刻点亮的段保存下来；选中期间段码继续跟随，取消选中（释放或反极性）后只保持、
  不清屏。
- **段码编码**：8 位掩码，`bit0 = a`、`bit1 = b`、…、`bit7 = dp`，始终按「点亮的段」
  编码，与极性无关。共阴管写 0x00 会熄灭该位，共阳管写 0xFF 会熄灭该位：两种情况下
  `digit` 端口都报告 0。
- **判定阈值**：段脚沿用常规逻辑阈值（低 < 0.8 V、高 > 2.0 V）；公共端用
  `low: 2.0, high: 3.0`。线性模型没有正向压降，选中位的公共端会被导通的段路径拉动
  （共阴 8 段全亮、25 Ω 驱动、500 Ω 段阻时约 1.4 V；共阳同条件约 4.4 V），而未选中的位
  被驱动器拉到对侧电源轨，抬高后的阈值才能把这两态分开。
- **上电**：`process start` 先按当前电压锁存一次再发布，因此固定电平的板（装配期就解出
  电压、之后不再有变化事件）也能看到内容，未接驱动的板四位都是 0。
- **输出**：`digit1`–`digit4` 四个 `delivery: level` 数值端口，只在锁存值真正变化时发送；
  适配器把每批里的最后一条发布到同名话题。

## 属性

| 属性                | 类型    | 默认值 | 说明                                                          |
| ------------------- | ------- | ------ | ------------------------------------------------------------- |
| `forwardResistance` | number  | 500    | 段阳极到公共端的等效串联电阻（Ω）；线性模型，不含二极管压降   |
| `commonAnode`       | boolean | false  | false = 共阴（公共端低选中、段脚高点亮），true = 共阳（相反） |

DDL 断言：`forwardResistance ∈ [0.001, 1e9]`。外部限流电阻按 `blue-led` 的做法并入该属性
（CT107D 的 1 kΩ 排阻 + 500 Ω 段阻记为 1500）。CT107D 的两片数码管是共阳管，原理图
实例因此带 `commonAnode: true`。

## 引脚与端口

| 引脚          | 说明                                       |
| ------------- | ------------------------------------------ |
| `a`–`g`       | 七段阳极，共阴高电平、共阳低电平点亮       |
| `dp`          | 小数点阳极，极性同上                       |
| `com1`–`com4` | 公共端，共阴低电平选中、共阳高电平选中该位 |

| 端口     | 方向   | 负载   | 说明                                      |
| -------- | ------ | ------ | ----------------------------------------- |
| `digit1` | output | number | 第 1 位最近一次选中时的 8 位段码（0–255） |
| `digit2` | output | number | 第 2 位，编码同上                         |
| `digit3` | output | number | 第 3 位，编码同上                         |
| `digit4` | output | number | 第 4 位，编码同上                         |

符号左侧是 8 根段脚、右侧是 4 根位脚，画了四位数字轮廓与各自的小数点（32 个图形）。

## 已知简化

- **没有正向压降，也不阻塞反向电流**：段支路是纯电阻，反向时仍按电阻导通，不模拟
  LED 的反向截止与击穿。
- **不做时间积分**：真实数码管靠多路扫描刷新，人眼看到的是各段亮度的积分；模型只保存
  「最近一次选中时」的段码，没有余辉、占空比、闪烁与亮度概念。
- **浮空段脚按电平判定**：段脚释放时会由仍在驱动的位脚通过支路分压，可能读到高电平。
  正常用法（段脚始终被锁存器驱动）不会遇到。
- **不模拟共阴/共阳的电流方向差异**：段支路是纯电阻，两种极性都靠电平判定，没有正向
  压降、反向截止与发光效率。

## 验证

```powershell
cd examples/devices
pnpm run typecheck        # mica prepare && tsc --noEmit
pnpm run test             # mica build + vitest（源码用例 + 交付产物用例）
```

`test/seg4/harness.ts` 用 `compileDDL` 现场编译 `model.ddl` 并直接装载 `src/`，同时就地建立
12 个数字驱动源（1 → 5 V、0 → 0 V、2 → 释放，输出电阻 25 Ω），因此选位、段码与扫描
保持都在真实仿真板上跑电气求解。`test/seg4/artifact.test.ts` 装载 `dist/` 里的交付文件，用
固定电压网建板，保证真正上传的 JS/JSON 也能工作（未构建时跳过）。
