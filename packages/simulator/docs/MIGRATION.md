# 迁移到统一 IR 架构

统一 IR 把整块电路——器件逻辑、电气网络解算和主循环——编译进**一个** `@mica-js/ir` module。
一次 `step()` 是一次引擎调用，一次 `runBatch(n)` 是**整批**一次引擎调用；没有调度器事件队列，
也没有每器件一次的模块边界。

## 为什么迁移

| 维度     | 调度器路径（每器件一个 module） | 统一 IR                                           |
| -------- | ------------------------------- | ------------------------------------------------- |
| 批处理   | 每 tick 多次宿主调用            | 整批一次引擎调用                                  |
| 器件访问 | 事件 / 端口 / 消息              | 类型化访问器（`circuit.devices.led1.isOn()`）     |
| 电气解算 | JavaScript 桥接，跨模块读写     | 生成进 IR，与器件共享引脚空间                     |
| 确定性   | 取决于投递顺序                  | 单模块、单一执行顺序，逐 tick 可复现              |
| 吞吐     | 基准线                          | 10–1000×（见 [PERFORMANCE.md](./PERFORMANCE.md)） |

## API 对照

| 旧 API（v0 原型，已移除）               | 新 API                                     |
| --------------------------------------- | ------------------------------------------ |
| `createUnifiedCircuit(config, options)` | `Circuit.create(input, options)`           |
| `circuit.tick()`                        | `circuit.step()`                           |
| `circuit.run(count)`                    | `circuit.runBatch(count)`                  |
| `circuit.ledOn('led')`                  | `circuit.devices.led.isOn()`               |
| `circuit.readPinInput(pin)`             | `circuit.getPin('device.pin')`             |
| `circuit.pinOf('device', 'pin')`        | 直接用 `'device.pin'`                      |
| `generateUnifiedIR(config)`             | `compileCircuit({ devices, connections })` |
| `UnifiedCircuitError`                   | `CircuitError` / `UnifiedIRCompilerError`  |
| `pinOffset` + `netlist.nets`            | 器件 id + `connections: [{ from, to }]`    |

调度器路径的对照见文末[从 `DeviceSimExecutor` 迁移](#从-devicesimexecutor-迁移)。

## 快速迁移

### 1. 旧代码（v0 原型）

```ts
const config = createMcuLedCircuit().config;
const circuit = createUnifiedCircuit(config);
circuit.tick();
console.log(circuit.ledOn('led'));
```

### 2. 新代码

```ts
import { Circuit, createLedDescription, createMcuDescription } from '@mica-js/simulator';

const circuit = await Circuit.create({
  devices: [
    { id: 'mcu1', type: 'mcu', description: createMcuDescription() },
    { id: 'led1', type: 'ideal-led', description: createLedDescription() },
  ],
  connections: [
    { from: 'mcu1.PA0', to: 'led1.anode' },
    { from: 'led1.cathode', to: 'GND' },
  ],
});

circuit.step();
console.log(circuit.devices.led1.isOn());
circuit.runBatch(1_000_000);
circuit.dispose();
```

要点：

- **`await`**：`Circuit.create` 编译并校验 module 后返回（含一次 `initialize`）。
- **无需手写引脚地址**：`connections` 用 `<器件 id>.<引脚名>` 描述导线，编译器分配全局引脚空间。
- **访问器按字面量推导**：`type: 'ideal-led'` 让 `circuit.devices.led1` 得到 `LedAccessor`，`type: 'mcu'`
  得到 `McuAccessor`；未知类型退回通用 `DeviceAccessor`。
- **`GND` / `VCC` / `VDD` 是默认电平轨**，无需声明；自定义轨用 `electrical.rails`。

## 器件迁移

### LED

```ts
import { createLedIR, LED_IR_TYPE } from '@mica-js/simulator';

const lamp = createLedIR('led1', { color: 'green', activeLow: false });
// 把 lamp.device.description 放进 Circuit.create 的 devices
const circuit = await Circuit.create({
  devices: [{ id: 'led1', type: LED_IR_TYPE, description: lamp.device.description }],
  connections: [
    { from: 'led1.anode', to: 'VCC' },
    { from: 'led1.cathode', to: 'GND' },
  ],
});
circuit.devices.led1.isOn();
circuit.devices.led1.getBrightness();
circuit.devices.led1.setBrightness(128);
```

内置的 `ideal-led`（`createLedDescription()`）只有 `lamp` 状态，适合最简电路；`createLedIR` 额外提供
亮度、颜色和 `activeLow`。

### Button

```ts
import { createButtonIR, BUTTON_IR_TYPE } from '@mica-js/simulator';

const sw = createButtonIR('sw1', { debounceTicks: 2 });
// sw.device.description 放进 devices；A 是开关端，B 是参考端
circuit.devices.sw1.press(); // 原始位置
circuit.devices.sw1.isClosed(); // 去抖后的触点
circuit.devices.sw1.getPressCount();
```

### Teaching MCU

```ts
import { createTeachingMCUIR, TEACHING_MCU_IR_TYPE } from '@mica-js/simulator';

const mcu = createTeachingMCUIR('mcu', {
  isa: 'm3',
  firmware, // Uint8Array
  instructionsPerTick: 8,
});

const circuit = await Circuit.create({
  devices: [
    { id: 'mcu', type: TEACHING_MCU_IR_TYPE, description: mcu.device.description },
    { id: 'led1', type: 'ideal-led', description: createLedDescription() },
  ],
  connections: [
    { from: 'mcu.PA0', to: 'led1.anode' },
    { from: 'led1.cathode', to: 'GND' },
  ],
});

const guest = circuit.devices.mcu; // TeachingMCUAccessor
guest.getPC();
guest.readRegister('r0');
guest.writeGPIO('A', 0b1);
guest.raiseInterrupt(0);
```

`examples/teaching-mcu` 是**参考实现**：它随包提供，用于示例、测试和器件开发模板。
生产器件应放在独立包里（例如 `@mica-js/device` 或第三方包），由宿主加载。

## 自定义器件

统一 IR 的器件由三部分组成：

1. **IR 工厂**：生成 `initialize` / `tick` / `update` 中需要的 phase 函数；
2. **描述**：`DeviceDescription`（`pins`、`states`、`kernel`、`accessor` 可选）；
3. **访问器**（可选）：在 `accessor` 钩子里拿到 `StorageAccessor` 构造类型化 API。

最小的自定义器件可以只声明描述，用 `behaviors` 写行为：

```ts
import type { DeviceDescription } from '@mica-js/simulator';

const counter: DeviceDescription = {
  name: 'counter',
  pins: { out: { direction: 'output' } },
  states: { count: { type: 'u32', initial: 0 } },
  behaviors: {
    tick: (api) => {
      const b = api.builder;
      const next = b.int.add(api.state<'u32'>('count').load(), b.const('u32', 1));
      api.state<'u32'>('count').store(next);
      api.pin('out').writeDigital(b.int.cmp('ne', next, b.const('u32', 0)));
    },
  },
};
```

完整契约见 [API.md](./API.md#deviceconfig--devicedescription) 与
`src/unified-ir/examples/teaching-mcu/`。

## 常用操作

| 需求              | 写法                                                               |
| ----------------- | ------------------------------------------------------------------ |
| 推进一个 tick     | `circuit.step()`                                                   |
| 推进一批          | `circuit.runBatch(1_000_000)`                                      |
| 读已完成 tick 数  | `circuit.tickCount`（`bigint`）                                    |
| 读一个引脚电平    | `circuit.getPin('mcu.PA0')`（解算后的电平）                        |
| 从宿主强制引脚    | `circuit.setPin('sw1.A', true)`                                    |
| 读/写器件内部状态 | `circuit.devices.led1.getState('level')`                           |
| 复位              | `circuit.reset()`（恢复声明初值并重跑 `initialize`）               |
| 释放              | `circuit.dispose()`（幂等；之后所有调用抛 `CircuitError`）         |
| 参考解释器对照    | `Circuit.create(input, { engine: 'reference' })`                   |
| 关闭 IR 校验      | `Circuit.create(input, { validateIR: false })`（仅用于已测温路径） |

## 错误处理

运行时错误统一是 `CircuitError`，带稳定的 `code`：

| code                     | 场景                                            |
| ------------------------ | ----------------------------------------------- |
| `invalid-options`        | `create` 的选项非法                             |
| `invalid-count`          | `runBatch(count)` 不是 u32                      |
| `pin-not-found`          | `getPin` / `setPin` 的引脚不存在                |
| `pin-not-writable`       | 对 load/passive 引脚调用 `writePin`             |
| `state-not-found`        | `getState` / `setState` 的状态名不存在          |
| `invalid-state-value`    | 状态值类型不符                                  |
| `register-not-found`     | `readRegister` / `writeRegister` 寄存器名不存在 |
| `invalid-register-value` | 寄存器值越界                                    |
| `unresolved-device`      | `createCircuitFromSchematic` 找不到器件         |
| `disposed`               | 电路释放后继续调用                              |

编译期错误是 `UnifiedIRCompilerError`（`unknown-device`、`pin-not-found`、`driver-conflict`、
`power-short`、`rail-conflict`、`capacity-exceeded`、`unsupported-device`、`invalid-ir` 等）。

## 从 `DeviceSimExecutor` 迁移

`createDeviceSimExecutor()` 是调度器路径，处于维护模式（见 [DEPRECATIONS.md](./DEPRECATIONS.md)）。
在它仍被需要的场景（原理图 → 器件模块实例、与 `WidgetHost` 互投消息）中，两套 API 的分工是：

| `DeviceSimExecutor`                     | 统一 IR 对应                                              |
| --------------------------------------- | --------------------------------------------------------- |
| `loadSchematic(document)`               | `createCircuitFromSchematic(document, { resolveDevice })` |
| `advance(delta)`（皮秒）                | `runBatch(n)`（tick 数）                                  |
| `getSimTime()`                          | `circuit.tickCount`                                       |
| `getTopics()` / `onPublish` / `deliver` | **尚无对应能力**（宿主集成待补齐）                        |
| `reset()` / `dispose()`                 | 同名方法                                                  |

```ts
import { Circuit, createLedDescription } from '@mica-js/simulator';

const circuit = await createCircuitFromSchematic(schematic, {
  devices: symbolProvider, // 与画布同一份符号几何
  resolveDevice: (reference) => bindings.get(reference.deviceId),
});
```

统一 IR 目前**不负责**：加载 `@mica-js/device` 模块、消息路由、按皮秒推进。需要这些能力时继续使用
`createDeviceSimExecutor()`；两者可以在同一个应用里并存（例如编辑器用调度器路径，批处理分析用统一 IR）。

## 常见问题

**Q：`Circuit.create` 为什么是 async？**
编译、IR 校验和引擎构建都是同步的，但 API 保留 promise 以便将来加入异步编译（例如 Worker）。
生成的 module 在返回前已经执行过 `initialize`。

**Q：一个网可以有两个驱动吗？**
默认不行，编译期报 `driver-conflict`。必须线与时传 `electrical: { allowMultiDriver: true }`。
双向器件（如教学 MCU 的 GPIO）与按钮接在同一个网上时通常需要打开它。

**Q：`step()` 和 `runBatch(1)` 有区别吗？**
语义相同。`runBatch` 走模块内的批处理入口；单 tick 时两者都只付一次引擎调用。

**Q：`reset()` 之后访问器还能用吗？**
能。`reset()` 恢复所有内存初值并重跑 `initialize`，`tickCount` 归零。`dispose()` 之后不能再用。

**Q：为什么没有 `createLed()` / `createButton()` 这样的旧工厂？**
`@mica-js/simulator` 的 v0 原型从未提供这些名字；统一 IR 的工厂统一命名为
`createXxxIR()`，访问器统一为 `XxxAccessor`。

**Q：删除 v0 原型 API 算 breaking change 吗？**
不算。原型从未出现在包的导出入口中（`package.json` 只导出 `.`，`files` 只包含 `dist`），
删除只影响直接深层导入 `src/unified-ir` 的本地脚本。按本文改写即可。
