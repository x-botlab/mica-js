# Mica 示例器件库

仓库内所有示例板共用的 Mica 器件源码。器件 ID 就是 `src/devices/<id>/` 的目录名，
`mica build` 一次输出全部 25 个器件：

```
dist/devices/<id>/{device.json, device.js}
```

工程位于 `examples/devices`，纳入 pnpm workspace（包名
`@mica-js/example-devices`）：

```bash
pnpm --filter @mica-js/example-devices build      # 输出 dist/devices/<id>/
pnpm --filter @mica-js/example-devices test       # mica build + vitest
pnpm --filter @mica-js/example-devices typecheck
pnpm --filter @mica-js/example-devices bench      # 器件性能基准（不进 test）
```

`test` 与 `bench` 会先构建兄弟工程 [`../ideal-led`](../ideal-led/README.md)，IAP15F2K61S2
的闪烁用例用它作为真实负载。器件测试直接编译 `src/devices/<id>/model.ddl` 并装载
同目录的 `index.ts`；`artifact.test.ts` 再装载 `dist/` 产物，保证交付文件本身也能工作。

## 目录

```text
examples/devices/
  mica.config.ts                  Mica 工程标志（读取 src/，输出 dist/）
  package.json
  tsconfig.json
  vitest.config.ts                正确性用例：串行执行，超时放宽
  vitest.perf.config.ts           基准专用配置：只装 bench/，串行执行
  src/devices/<id>/
    model.ddl                     器件行为：引脚、状态、通道、进程与反应
    index.ts                      适配器：把输出通道转发到同名话题
    device.json                   元数据：属性、引脚、端口、符号与说明
    kernel/ peripherals/          JIT 器件的内部模块（IAP15F2K61S2）
  test/
    manifest.test.ts              全库元数据、DDL 与适配器的一致性
    ct107d/*.test.ts              CT107D 板级芯片与 IAP15F2K61S2 的整板相关用例
    iap15f2k61s2/*.test.ts        IAP15F2K61S2 内核、外设与交付产物
    stm32g431rbt6/*.test.ts       STM32G431RBT6 指令、外设与交付产物
    ili9325/*.test.ts             ILI9325 协议、GRAM、联合仿真与融合模型
    seg4/*.test.ts                四位数码管行为与交付产物
    blue-led/*.test.ts            蓝色 LED 行为与交付产物
  bench/
    iap15f2k61s2/                 IAP15F2K61S2 JIT 基准
    stm32g431rbt6/                STM32G431RBT6 与 HAL_06_LCD 基准
    ili9325/                      ILI9325 与 MCU + LCD 联合基准
  docs/<id>.md                    每个器件的引脚、行为、端口与理想化说明
```

## 器件

| id              | 型号 / 类别                         | 主要使用方                                    |
| --------------- | ----------------------------------- | --------------------------------------------- |
| `74hc02`        | 四路 2 输入或非门                   | `examples/ct107d`                             |
| `74hc138`       | 3-8 译码器（低有效）                | `examples/ct107d`                             |
| `74hc573`       | 八路透明 D 锁存器                   | `examples/ct107d`                             |
| `74hc14`        | 六施密特触发反相器                  | `examples/ct107d`                             |
| `at24c02`       | 2 Kb I²C EEPROM                     | `examples/ct107d`                             |
| `buzzer`        | 有源蜂鸣器                          | `examples/ct107d`                             |
| `cx20106a`      | 红外前置放大 / 整形                 | `examples/ct107d`                             |
| `ds1302`        | 三线实时时钟                        | `examples/ct107d`                             |
| `ds18b20`       | 1-Wire 温度传感器                   | `examples/ct107d`                             |
| `jumper`        | 两脚跳线                            | `examples/ct107d`                             |
| `jumper-2x3`    | 2×3 跳线排针                        | `examples/ct107d`                             |
| `lm386`         | 音频功放（数字跟随）                | `examples/ct107d`                             |
| `ne555`         | 无稳态定时器                        | `examples/ct107d`                             |
| `pcf8591`       | 8 位 ADC + DAC（I²C）               | `examples/ct107d`                             |
| `push-button`   | 轻触按键                            | `examples/ct107d`                             |
| `relay`         | 电磁继电器                          | `examples/ct107d`                             |
| `uart-probe`    | UART 8N1 探针                       | `examples/ct107d`                             |
| `uln2003`       | 七路达林顿驱动                      | `examples/ct107d`                             |
| `ultrasonic`    | 超声波收发器件                      | `examples/ct107d`                             |
| `vs1838`        | 38 kHz 红外接收头                   | `examples/ct107d`                             |
| `iap15f2k61s2`  | STC15 系列 8051 MCU（JIT）          | `examples/ct107d`、`examples/led8`            |
| `stm32g431rbt6` | STM32G431RBT6 Cortex-M4F MCU（JIT） | `examples/ct117e-m4`、`examples/devices` 基准 |
| `ili9325`       | 240×320 GRAM TFT 控制器             | `examples/ct117e-m4`                          |
| `seg4`          | 共阴 / 共阳四位数码管               | `examples/ct107d`                             |
| `blue-led`      | 蓝色 LED                            | `examples/ct107d`、`examples/led8`            |

每个器件的引脚表、行为、端口编码与理想化见 [`docs/<id>.md`](docs/)。

## 在其他示例中使用

- `examples/ct107d` 的原理图、画布与固件联调脚本从本库 `src/devices/` 读元数据，
  并从本库 `dist/devices/` 装载器件产物；`examples/ct107d` 自身不再保存器件源码。
- `examples/ct117e-m4` 的测试夹具复用本库的 `test/ili9325/joint-harness.ts` 与
  `bench/stm32g431rbt6/HAL_06_LCD.hex`。
- `examples/led8` 直接装载本库 `dist/devices/iap15f2k61s2/` 与
  `dist/devices/blue-led/`。
- Playground 的 `scripts/components.mjs` 会先构建本库，再把器件复制到
  `public/components/ct107d/devices/`。

## 建模约定

- **电气**：每颗芯片声明 `vcc` / `gnd` 引脚，推挽输出用
  `resistor(to: vcc|gnd, resistance: outputResistance)`，释放用 `[]`；开漏输出只拉低或释放。
  输入引脚不带内部上拉，I²C/1-Wire 总线需要装配侧提供外部上拉。
- **电平**：`pin.sample.level == Logic.high` 为高，其余（低与未知）按低处理；阈值由
  `lowThreshold` / `highThreshold` 属性给出。
- **组合逻辑**用 `derived` + `process ... on <derived>`；**边沿**用 `reaction` 配合
  `capture`；**定时/超时**用 `now()` + `await ticks(remaining)`。
- **通道负载**只能是 `number`、`bool`、`bytes`、扁平 `record`；旧版字符串端口改为
  `bytes`（ASCII）或 `number`。
- **器件状态**放在 `state` 里，批量数据（EEPROM、RTC RAM、GRAM）放在 `memory` 里。

统一理想化：零传播延迟（NE555 的振荡周期除外）、不模拟驱动强度、电源电流、结温与电磁兼容。
各器件文档另列具体简化。
