# Mica 示例器件库

仓库内所有示例板共用的统一器件开发项目。器件 ID 由清单的 `publisher:name` 组成，目录名
等于 `name`，发布者固定为 `example`，因此 `examples/devices/blue-led/` 对应
`example:blue-led`。

每个器件是一个独立开发项目：

```text
examples/devices/
  <id>/
    package.json            单器件清单（publisher、name、engines、pins、model）
    mica.config.ts          本项目构建配置；发布包写到 ../dist/<id>/
    tsconfig.json           extends "./.mica/tsconfig.json"
    .mica/                  mica prepare 生成的 device.d.ts 与 tsconfig（忽略）
    src/
      model.ddl             电气模型、通道、进程与反应
      index.ts              具名导出 create: DeviceFactory，同步 methods 并发事件
  test/                     跨器件测试夹具、板级行为与清单合同测试
  bench/                    复杂器件的性能基准
  docs/<id>.md              每个器件的说明
  scripts/for-each-device.mjs
  package.json              聚合脚本
  dist/<id>/                每器件发布包（忽略）
    package.json
    model.js
    release.json            位于 dist/<id>.release.json
```

## 命令

```bash
pnpm --filter @mica-js/example-devices prepare:types  # 逐个 mica prepare，生成 .mica
pnpm --filter @mica-js/example-devices build          # 逐个 mica build，输出 dist/<id>/
pnpm --filter @mica-js/example-devices typecheck      # 逐器件 tsc + 共享 test TypeScript 检查
pnpm --filter @mica-js/example-devices test           # 聚合构建 + ideal-led 构建 + vitest
pnpm --filter @mica-js/example-devices bench          # 聚合构建 + 基准
```

单器件可用 `mica prepare --root <id>`、`mica build --root <id>` 和
`tsc -p <id> --noEmit`。每个 `.mica/device.d.ts` 只属于当前器件，聚合脚本不会把多个
器件的全局 `DeviceProps` / `DeviceMethods` 装进同一个 TypeScript 程序。

## 统一器件合同

- `package.json` 是唯一清单。根字段为 `publisher`、`name`、`version`、`engines.mica`、
  `displayName`、可选 `designatorPrefix`、`properties`、`pins`、`model`。本轮只交付
  仿真内核，不声明 `view2d`，也不提供编辑器/2D 展示适配。
- `model.entry` 固定为 `model.js`；`model.types`、`model.methods`、`model.events` 声明
  公共载荷、同步方法和 `onDidXxx` 事件。构建后的 `model.js` 具名导出 `model` 与
  `create`。
- `src/index.ts` 使用 `mica prepare` 生成的全局类型：

  ```ts
  export const create: DeviceFactory = (context) => {
    let value = 0;
    const methods: DeviceMethods = { getValue: () => value };
    return {
      methods,
      sync(batch) {
        for (const message of batch.outputs.value) {
          value = message.value;
          context.events.onDidValue.fire(value);
        }
      },
      dispose() {},
    };
  };
  ```

  状态查询与事件载荷使用独立快照；二进制事件交付真实的 `Uint8Array`。适配器不读取
  `context.topics`，输入通过公共方法提交，输出通过事件交付。

- 引脚集合在清单与模型 IR 两处必须完全一致。旧 `device.json` 的 `ports`、`symbol` 与
  话题名不是新合同；旧仿真消费者的兼容适配由 SDK 层承担。
- 统一器件包允许纯 headless：不声明 `view2d` 时不进入 2D 场景。旧 symbol 仅是旧清单
  内容，不再迁移为本轮的新视图资源。
- 器件之间不共享 2D 或编辑器源码；本轮所有包只含模型、清单与发行资源。

## 旧仿真消费者兼容边界

旧 `@mica-js/simulator` 的 `DeviceFactory` 上下文仍提供 `topics`，而统一器件只暴露
`methods` / `events`。SDK 提供 `adaptModelFactory(create, options)` 在边缘完成桥接；
映射必须显式写出，不按名称猜语义：

```ts
import { adaptModelFactory } from '@mica-js/sdk/device';

const legacyCreate = adaptModelFactory(module.create, {
  events: { onDidPress: { topic: 'press' } },
  inputs: { press: 'press' },
});
```

- 输出方向：每个 `onDidXxx` 必须显式给出旧 topic；需要改变载荷时提供 `transform`。
  例如 `onDidClosedState → closedState`、`onDidTemperatureOut → temperatureOut`、
  `onDidPress → press`。没有列出的新事件不投影到旧 topic。
- 输入方向：旧 topic 显式映射到公共方法：`press → press`、`control → setClosed`、
  `control2 → selectVs1838`、`carrier → setCarrier`、`temperature → setTemperature`、
  `ain0..3 → setAin0..3`、`send → send`。
- `props` 可由静态默认值或 `legacy => 完整 props` 函数提供；旧 `device.json` 的
  `ports` / `symbol` 不属于本轮交付内容，兼容层不得依赖新包提供它们。
- 兼容适配器不得向新模型上下文泄漏 `topics`，否则会形成第二套通信路径。

测试夹具 `test/harness.ts` 只给新适配器注入 `props` / `inputs` / `events`：事件出口按
当前器件 `model.events` 生成，访问未声明的事件会立即失败；旧 topic 字段名由
`LEGACY_EVENT_TOPICS` 逐器件显式映射，只影响 `board.topics` 断言，不进入适配器。

## 器件

| id              | 型号 / 类别                                     | 使用方 / 目标板                    |
| --------------- | ----------------------------------------------- | ---------------------------------- |
| `74hc02`        | 四路 2 输入或非门                               | `examples/ct107d`                  |
| `74hc138`       | 3-8 译码器（低有效）                            | `examples/ct107d`                  |
| `74hc573`       | 八路透明 D 锁存器                               | `examples/ct107d`                  |
| `74hc14`        | 六施密特触发反相器                              | `examples/ct107d`                  |
| `at24c02`       | 2 Kb I²C EEPROM                                 | `examples/ct107d`                  |
| `buzzer`        | 有源蜂鸣器                                      | `examples/ct107d`                  |
| `cx20106a`      | 红外前置放大 / 整形                             | `examples/ct107d`                  |
| `ds1302`        | 三线实时时钟                                    | `examples/ct107d`                  |
| `ds18b20`       | 1-Wire 温度传感器                               | `examples/ct107d`                  |
| `hall`          | 三脚开关型霍尔传感器                            | `examples/ct107d`（目标板）        |
| `ir-emitter`    | 红外发射数据调制端                              | `examples/ct107d`（目标板）        |
| `jumper`        | 两脚跳线                                        | `examples/ct107d`                  |
| `jumper-2x3`    | 2×3 跳线排针                                    | `examples/ct107d`                  |
| `lm324`         | CT107D fused 可调差分放大器（内部电位器调增益） | `examples/ct107d`（目标板）        |
| `lm386`         | 音频功放（数字跟随）                            | `examples/ct107d`                  |
| `mcp4017`       | MCP4017 7 位 I²C 数字电位器                     | `examples/ct117e-m4`（目标板）     |
| `ne555`         | 无稳态定时器                                    | `examples/ct107d`                  |
| `pcf8591`       | 8 位 ADC + DAC（I²C）                           | `examples/ct107d`                  |
| `potentiometer` | 三端线性电位器                                  | `examples/ct117e-m4`（目标板）     |
| `push-button`   | 两脚抽象轻触开关                                | `examples/ct107d`                  |
| `relay`         | 电磁继电器                                      | `examples/ct107d`                  |
| `uart-probe`    | UART 8N1 探针                                   | `examples/ct107d`                  |
| `uln2003`       | 七路达林顿驱动                                  | `examples/ct107d`                  |
| `ultrasonic`    | 超声波收发器件                                  | `examples/ct107d`                  |
| `vs1838`        | 38 kHz 红外接收头                               | `examples/ct107d`                  |
| `iap15f2k61s2`  | STC15 系列 8051 MCU（JIT）                      | `examples/ct107d`、`examples/led8` |
| `stm32g431rbt6` | STM32G431RBT6 Cortex-M4F MCU（JIT）             | `examples/ct117e-m4`、基准         |
| `ili9325`       | 240×320 GRAM TFT 控制器                         | `examples/ct117e-m4`               |
| `seg4`          | 共阴 / 共阳四位数码管                           | `examples/ct107d`                  |
| `blue-led`      | 蓝色 LED                                        | `examples/ct107d`、`examples/led8` |

本轮新补齐的 `hall`、`ir-emitter`、`mcp4017`、`potentiometer`、`lm324` 只交付器件库；
“目标板”表示预期接线目标。`mcp4017` 与 `potentiometer` 的独立器件包未装配到对应
整板，但 `examples/ct117e-m4` 的 fused 模型在自身 `model.ddl` 内自有实现，不复用
这些包；`at24c02`、`ne555`、`74hc573`、`blue-led` 同样不被 ct117e fused 复用。
ct117e 的 555 是输出反馈型无稳态，`DISCH` 悬空，与 `ne555` 的 rA/rB/DISCH 拓扑不同。

`push-button` 是把真实四脚轻触开关抽象成 `a`/`b` 两端的业务模型，不声明四脚封装。
按下在两端建立 1 Ω 支路，松开移除支路并保持悬空；旧模型的 1 GΩ “假断开”已删除。

`hall` 是带迟滞的单极开关型开漏输出，不模拟线性磁场；`ir-emitter` 只交付逻辑载波
端点，不内置 NEC/RC5 等协议，协议时序由连接两端的测试夹具定义。

`lm324` 是 CT107D U26 + RB4 的 fused 业务模型：内部电位器直接调差分增益，AIN2 输出
饱和到 0–VCC；只覆盖这条可调放大链路，不提供独立运放单元或外部反馈网络求解。

## 测试

- `test/device-projects.ts`：共享的器件目录发现与专项排除规则；除已知非器件目录外，
  带 `package.json` 但清单损坏或缺字段的项目会直接失败，不静默跳过。
- `test/manifest.test.ts`：按共享规则发现简单器件，校验清单、模型 IR、引脚、方法与事件
  一致性；复杂 MCU 与把多个输出通道合成为单个事件的 `seg4`/`ili9325` 由各自专项测试覆盖。
- `test/artifact.test.ts`：同一批简单器件的 `dist/<id>/` 发布包合同，真实装载 `model.js`
  并在仿真板上创建实例。
- `test/ct107d/*.test.ts`：板级电气行为，仍使用真实仿真板；交互断言通过新方法提交、
  通过新事件归档到旧字段名，不再绕过适配器直接写 DDL 输入。
- `test/blue-led/*.test.ts`：LED 电气基线、适配器查询与交付产物。
- `test/<id>/*.test.ts`：新增器件的专属行为与交付产物用例；统一由 `tsconfig.json` 的
  `test/**/*.ts` 做 TypeScript 检查，不把单器件 `.mica/device.d.ts` 并入共享程序。
- `bench/`：IAP15F2K61S2、STM32G431RBT6 与 ILI9325 的性能基准。

统一理想化：数字逻辑通常按零传播延迟近似；振荡、解调去抖与 lm324 周期采样的时间
语义见各器件文档。不模拟驱动强度、电源电流、结温与电磁兼容；各器件文档另列具体简化。
