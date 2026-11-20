# 蓝色 LED 器件包

蓝色 LED（InGaN，典型正向电压 3.0 V 级、额定电流 20 mA）的统一器件项目。器件 ID 是
`example:blue-led`：阳极–阴极之间是一段等效串联电阻，亮度取正向电流相对额定电流的比值。
构建产物是 `dist/blue-led/{package.json, model.js}`；本轮不提供 2D/编辑器视图资源。

器件源码位于 `examples/devices/blue-led`，随
`pnpm --filter @mica-js/example-devices build|typecheck|test` 一起构建与验证。

## 目录

```
examples/devices/blue-led/
  package.json                         清单：pins、properties、model
  mica.config.ts                       输出到 ../dist/blue-led/
  tsconfig.json                        extends ./.mica/tsconfig.json
  src/
    model.ddl                          采样、亮度换算与输出通道
    index.ts                           具名 create；缓存状态并发出 onDidXxx
test/blue-led/
  harness.ts                           板级夹具：DDL + 适配器 + 测试电阻 + 电源网络
  device.test.ts                       源码级行为用例
  artifact.test.ts                     交付产物用例（model.js / package.json）
```

## 模型要点

- **电气**：`pin anode = [resistor(to: cathode, resistance: forwardResistance)]`。平台的电气
  合同只提供线性电阻意图，因此 LED 是一段阻值为 `forwardResistance` 的双向电阻：正向
  导通由外部网络分压决定电流，反向也允许电流通过（值为负），但没有发光。
- **亮度**：`brightness = clamp(current / ratedCurrent, 0, 1)`，其中
  `current = (V阳极 − V阴极) / forwardResistance`。反向电流为负，亮度因此恒为 0。
- **默认工作点**：`forwardResistance = 500 Ω`、`ratedCurrent = 20 mA`。5 V 经 330 Ω 串联时
  LED 分得约 3.01 V、6.02 mA，亮度 0.30，与典型蓝色 LED 的 3.0 V / 6 mA 接近；直接把
  LED 接到 5 V 时电流 10 mA、亮度 0.50。
- **输出**：`voltage`、`current`、`brightness` 三个输出通道。模型在
  `anode`/`cathode` 的采样电压变化时重新计算并发送，不需要额外时钟；`src/index.ts`
  缓存每批最后一条，供 `getVoltage()` / `getCurrent()` / `getBrightness()` 查询，并发出
  对应的 `onDidVoltage` / `onDidCurrent` / `onDidBrightness` 事件。
- **浮空**：任一端没有确定电压时发送 `0 V / 0 A / 0 亮度`，指示器保持熄灭，不把浮空
  当成低电平参与物理解算。

## 属性

| 属性                | 类型   | 默认值 | 说明                                                      |
| ------------------- | ------ | ------ | --------------------------------------------------------- |
| `forwardResistance` | number | 500    | 等效串联电阻（Ω），决定正向电流；线性模型，不含二极管压降 |
| `ratedCurrent`      | number | 0.02   | 达到该正向电流（A）时亮度为 1，更大电流仍按 1 处理        |

DDL 断言：`forwardResistance ∈ [0.001, 1e9]`，`ratedCurrent ∈ (0, 1]`。

## 引脚与公共接口

| 引脚      | 说明                           |
| --------- | ------------------------------ |
| `anode`   | 阳极：相对阴极为正时导通并发光 |
| `cathode` | 阴极：接较低电位               |

| 成员                  | 类型     | 说明                             |
| --------------------- | -------- | -------------------------------- |
| `getBrightness(null)` | `number` | 正向电流 / 额定电流，钳到 [0, 1] |
| `getCurrent(null)`    | `number` | 阳极到阴极的电流（A），反向为负  |
| `getVoltage(null)`    | `number` | 阳极相对阴极的电压（V）          |
| `onDidBrightness`     | 事件     | 亮度变化                         |
| `onDidCurrent`        | 事件     | 电流变化                         |
| `onDidVoltage`        | 事件     | 电压变化                         |

本轮只提供仿真内核与模型接口，不提供新的 2D 光晕或编辑器展示适配。

## 已知简化

- **没有正向压降**：真实蓝色 LED 在 20 mA 时约 3.0–3.4 V，本模型用等效电阻近似这段
  特性；串联电阻极小时 LED 会分到接近全部电源电压。
- **不阻塞反向电流**：反接时电流为负、亮度为 0，但电气上仍按电阻导通，不模拟反向
  击穿电压。
- **无温度、老化与发光效率模型**：亮度只由电流比值决定，不做光通量、波长或结温计算。
- **亮度不是线性光感**：指示器把 `brightness` 直接当作视觉强度使用，没有做 gamma 校正。

## 验证

```powershell
cd examples/devices
pnpm run typecheck        # 逐器件 mica prepare + tsc -p <id>
pnpm run test             # 聚合 build + vitest（源码用例 + 交付产物用例）
```

`test/blue-led/harness.ts` 使用共享夹具：现场编译 `src/model.ddl`、装载具名 `create`，
并通过真实仿真板建立测试电阻与电压源网络；读数经 `getBrightness()` 等方法查询。
`test/blue-led/artifact.test.ts` 装载 `dist/blue-led/` 里的 `model.js` 与 `package.json`，
保证真正交付的文件也能在真实仿真板上工作（未构建时跳过）。
