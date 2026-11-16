# 三端线性电位器

通用三端电位器器件：VDD、GND 与滑臂 W。滑臂位置在运行期可调，电压完全由板级线性
电阻网络求解。器件 id 为 `example:potentiometer`，源码在 `potentiometer/`，发布包在
`dist/potentiometer/`。

本器件用于 CT117E-M4 页 1 的 R37/R38 一类 VDD–GND 分压电位器，也可用于任何需要
“两段有限电阻 + 可调滑臂”的电路。R39/R40 的 555 调频电阻按计划走 fused 实现，不
实例化本器件。

## 元数据

| 项       | 值                                        |
| -------- | ----------------------------------------- |
| 器件 id  | `potentiometer`                           |
| 文件     | `model.ddl` / `index.ts` / `package.json` |
| 位号前缀 | `RV`                                      |
| 引脚数   | 3（VDD/GND/W）                            |
| 模型     | 两段线性电阻，无内部电压源                |

## 引脚

| 引脚 | DDL 名  | 方向/电气 | 说明                     |
| ---- | ------- | --------- | ------------------------ |
| VDD  | `vdd`   | 被动      | 轨道上端，接板级正电源   |
| GND  | `gnd`   | 被动      | 轨道下端，接板级地       |
| W    | `wiper` | 被动      | 滑臂，两段电阻的公共节点 |

器件不引用板级电源或地名称；VDD/GND 只作为普通引脚参与装配。未连接时整个电阻网络
浮空，滑臂没有确定电压。

## 电阻模型

设位置为 `p`（0..1），轨道总电阻为 `R_track`，端点电阻为 `R_end`：

```text
R_upper = R_end + R_track × (1 - p)   // VDD 到滑臂
R_lower = R_end + R_track × p         // 滑臂到 GND
```

`p = 0` 表示滑臂靠近 GND，`p = 1` 表示靠近 VDD。两段都保留 `R_end`，因此端点仍是
有限电阻，不会出现 0 Ω 硬短路到某一电源轨。

无外部负载、GND 为 0 V 时：

```text
V_wiper = V_VDD × R_lower / (R_upper + R_lower)
```

滑臂接外部负载时，负载与 `R_lower` 并联后参与同一分压，电压由真实求解器计算，不是
预先写死的比例。

默认 `R_track = 10 kΩ`、`R_end = 10 Ω`、`p = 0.5`，在 3.3 V 下约 1.65 V。`p = 0/1`
分别约为 3.3 mV 与 3.2967 V，而不是 0 V 与 3.3 V。

## 属性

| 属性              | 默认值 | 说明                                               |
| ----------------- | ------ | -------------------------------------------------- |
| `trackResistance` | 10000  | 轨道总电阻，单位 Ω；与 `endResistance` 合计 ≤ 1 GΩ |
| `endResistance`   | 10     | 每端保留的有限电阻，单位 Ω                         |
| `initialPosition` | 0.5    | 上电位置；创建期必须在 0..1                        |

`trackResistance` 与 `endResistance` 必须为有限正数；两者之和受引脚电阻意图的 1 GΩ
上限约束。`initialPosition` 必须为有限值且在 0..1。

## 公共接口

| 成员            | 类型               | 说明                                                                                |
| --------------- | ------------------ | ----------------------------------------------------------------------------------- |
| `setPosition`   | `(number) => null` | 同步设置位置；非法值抛 `MethodError`，code 为 `potentiometer/invalid-position`      |
| `getPosition`   | `() => number`     | 最近一次已接受的位置                                                                |
| `getVoltage`    | `() => number`     | 最近一次有效滑臂电压；尚无有效采样时抛 `MethodError`，code 为 `voltage/unavailable` |
| `onDidPosition` | `number`           | 位置变化事件；重复位置不发事件                                                      |
| `onDidVoltage`  | `number`           | 滑臂有效电压变化事件                                                                |

`setPosition` 的非法输入是可恢复的业务拒绝，不改变板状态、不产生 fault。DDL 输入端
`setPosition` 另有一条运行期断言；通过测试夹具直接注入非法值会使真实板 `faulted`，
不会静默钳位。

滑臂网络浮空时 `pin.sample.voltage` 为 `none`，模型不发布 `onDidVoltage`，也不把浮空
伪装成某个电压。此前没有有效采样时 `getVoltage` 抛出 `MethodError('voltage/unavailable')`，
因此不会把“无样本”与真实 0 V 混淆。一旦收到有效采样，`getVoltage` 返回最近一次有效
样本；该值是历史样本，不保证等于当前网络状态。输出通道只能承载 `number`，因此没有
单独的浮空状态事件。

## 实现要点

- 引脚初值按 `initialPosition` 直接建立两段电阻；运行期 `setPosition` 改变位置时完整
  替换 `wiper.intent`，不保留旧并联支路；重复位置直接返回，不重写电阻也不发位置事件。
- `process start` 发布初始位置与有效电压，随后常驻接收 `setPosition`。
- `reaction wiperVoltageChanged` 在求解边界后读取 `wiper.sample.voltage`；只有非
  `none` 才发布电压，因此事件对应真实网络解。
- 位置输出与电阻更新在同一同步片段完成；电压事件在随后的求解边界发布。

## 理想化

- 无触点抖动、接触噪声、机械行程、线性锥度误差与磨损。
- 无额定功率、温度系数、寄生电容/电感与频响。
- 不模拟 VDD/GND 极性保护、电源电流与滑臂电流限值。
- 不增加引擎级 analog 抽象；仅使用既有 `resistor` 意图、`sample.voltage` 与线性
  电阻求解。

## 测试

- `test/potentiometer/device.test.ts`：初始 50% 分压、运行期设位置、重复位置不重复
  发事件、0/1 有限端点、外部负载、VDD=0、无供电浮空的 `voltage/unavailable`、
  `setPosition` 的 `MethodError` 可恢复性、直接注入非法值的 faulted、非法属性。
- `test/potentiometer/artifact.test.ts`：装载 `dist/potentiometer/model.js`，在真实
  仿真板上重新验证分压、运行期改位置，以及浮空时的 `voltage/unavailable`。

测试全部使用 `@mica-js/simulator` 的真实求解板；没有宿主注入的假电压。
