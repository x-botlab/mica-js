# 迁移到统一 IR 架构

统一 IR 把整块电路——器件逻辑、电气网络解算和主循环——编译进**一个** `@mica-js/ir` module。
一次 `step()` 是一次引擎调用，一次 `runBatch(n)` 是**整批**一次引擎调用；没有调度器事件队列，
也没有每器件一次的模块边界。

## 为什么迁移

| 维度     | 调度器路径（每器件一个 module） | 统一 IR                                                |
| -------- | ------------------------------- | ------------------------------------------------------ |
| 批处理   | 每 tick 多次宿主调用            | 整批一次引擎调用                                       |
| 器件访问 | 事件 / 端口 / 消息              | 通用访问器（`circuit.devices.sink1.getState('lamp')`） |
| 电气解算 | JavaScript 桥接，跨模块读写     | 生成进 IR，与器件共享引脚空间                          |
| 确定性   | 取决于投递顺序                  | 单模块、单一执行顺序，逐 tick 可复现                   |
| 吞吐     | 基准线                          | 10–1000×（见 [PERFORMANCE.md](./PERFORMANCE.md)）      |

## API 对照

| 旧 API（v0 原型，已移除）               | 新 API                                     |
| --------------------------------------- | ------------------------------------------ |
| `createUnifiedCircuit(config, options)` | `Circuit.create(input, options)`           |
| `circuit.tick()`                        | `circuit.step()`                           |
| `circuit.run(count)`                    | `circuit.runBatch(count)`                  |
| `circuit.ledOn('led')`                  | `circuit.devices.sink1.getState('lamp')`   |
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
import { Circuit } from '@mica-js/simulator';

const circuit = await Circuit.create({
  devices: [
    { id: 'drive1', type: 'push-pull-driver', description: driverDescription() },
    { id: 'sink1', type: 'lamp-sink', description: sinkDescription() },
  ],
  connections: [
    { from: 'drive1.PA0', to: 'sink1.anode' },
    { from: 'sink1.cathode', to: 'GND' },
  ],
});

circuit.step();
console.log(circuit.devices.sink1.getState('lamp'));
circuit.runBatch(1_000_000);
circuit.dispose();
```

要点：

- **`await`**：`Circuit.create` 编译并校验 module 后返回（含一次 `initialize`）。
- **无需手写引脚地址**：`connections` 用 `<器件 id>.<引脚名>` 描述导线，编译器分配全局引脚空间。
- **访问器只有通用一面**：`circuit.devices.<id>` 是 `DeviceAccessor`（`readPin` / `writePin` /
  `getState` / `setState`）。需要更丰富表面的器件包用 `description.accessor` 自带一个，在调用处断言。
- **`GND` / `VCC` / `VDD` 是默认电平轨**，无需声明；自定义轨用 `electrical.rails`。

## 器件迁移

### 器件实现已移出本包

`@mica-js/simulator` 不再导出 `createLedIR` / `createButtonIR` / `createRelayIR` / `createTeachingMCUIR`
及其访问器类型，也不再提供原理图器件目录（`mica:ideal-button` 等）。器件定义与模型由调用方维护：

- demo 器件在 Playground：模型 `apps/playground/src/sim/device-models.ts`，契约 `apps/playground/public/devices`；
- 其它项目把器件放进自己的包，只需要 `@mica-js/simulator` 的通用类型与 `@mica-js/ir`。

### 也没有内建内核

编译器不再自带 `mcu` / `led` 内核：`createLedDescription()` / `createMcuDescription()` /
`BUILTIN_DEVICE_TYPES` / `LedAccessor` / `McuAccessor` 已删除，`type` 只是器件模型的自由标签。
每个 `description` 必须自带 `pins`（以及需要的 `states` / `behaviors` / `kernel`），否则编译期报
`unsupported-device`。没有描述就没有默认值——这保证了「LED 是什么」只存在于器件包里。

包内测试与基准使用自己的最小描述（`drive1` / `sink1`），它们只是测试夹具，不是公开 API。

### 自带渲染与主题的器件

器件包按 `DeviceDescription` 提供 `pins` / `states` / `kernel` / `accessor`（可选），再把 `DeviceConfig`
交给 `Circuit.create`。需要接入画布时，同一个器件包同时提供 `SchematicDeviceBinding`（`type` +
`description` + `topics` + `deliver` / `read`），宿主用 `resolveDevice` 把它交给
`createSchematicCircuit` 或 `createSchematicDeviceSimulationHost`。

```ts
import type { DeviceConfig, DeviceDescription, SchematicDeviceBinding } from '@mica-js/simulator';

const description: DeviceDescription = {
  name: 'counter',
  pins: { clk: { direction: 'input' } },
  states: { count: { type: 'u32', initial: 0 } },
  behaviors: {
    update: (api) => {
      const count = api.state<'u32'>('count');
      count.store(api.builder.int.add(count.load(), api.builder.const('u32', 1)));
    },
  },
};

const device: DeviceConfig = { id: 'U1', type: 'counter-ir', description };

const binding: SchematicDeviceBinding = {
  type: 'counter-ir',
  description,
  topics: [{ port: 'count', direction: 'output', type: 'number' }],
  read: (accessor) => accessor.getState('count'),
};
```

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

完整契约见 `src/unified-ir/README.md`；需要示例时看 Playground 的 `apps/playground/src/devices`（模型）与 `apps/playground/src/sim/device-library.ts`（定义加载与绑定）。

## 常用操作

| 需求              | 写法                                                               |
| ----------------- | ------------------------------------------------------------------ |
| 推进一个 tick     | `circuit.step()`                                                   |
| 推进一批          | `circuit.runBatch(1_000_000)`                                      |
| 读已完成 tick 数  | `circuit.tickCount`（`bigint`）                                    |
| 读一个引脚电平    | `circuit.getPin('drive1.PA0')`（解算后的电平）                     |
| 从宿主强制引脚    | `circuit.setPin('sw1.A', true)`                                    |
| 读/写器件内部状态 | `circuit.devices.sink1.getState('lamp')`                           |
| 复位              | `circuit.reset()`（恢复声明初值并重跑 `initialize`）               |
| 释放              | `circuit.dispose()`（幂等；之后所有调用抛 `CircuitError`）         |
| 参考解释器对照    | `Circuit.create(input, { engine: 'reference' })`                   |
| 关闭 IR 校验      | `Circuit.create(input, { validateIR: false })`（仅用于已测温路径） |

## 错误处理

运行时错误统一是 `CircuitError`，带稳定的 `code`：

| code                  | 场景                                    |
| --------------------- | --------------------------------------- |
| `invalid-options`     | `create` 的选项非法                     |
| `invalid-count`       | `runBatch(count)` 不是 u32              |
| `pin-not-found`       | `getPin` / `setPin` 的引脚不存在        |
| `pin-not-writable`    | 对 load/passive 引脚调用 `writePin`     |
| `state-not-found`     | `getState` / `setState` 的状态名不存在  |
| `invalid-state-value` | 状态值类型不符                          |
| `unresolved-device`   | `createCircuitFromSchematic` 找不到器件 |
| `disposed`            | 电路释放后继续调用                      |

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
import { Circuit, createCircuitFromSchematic } from '@mica-js/simulator';

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
`@mica-js/simulator` 的 v0 原型从未提供这些名字；统一 IR 只导出通用编译器与运行时，
具体器件描述由器件包提供。

**Q：现在还能拿到 `circuit.devices.led1.isOn()` 吗？**
不能。`LedAccessor` / `McuAccessor` 与内建类型映射已删除，访问器统一是 `DeviceAccessor`：
用 `getState('lamp')` 读同样的布尔状态，需要更丰富表面时由器件包用 `description.accessor` 提供并在调用处断言。

**Q：删除内建内核算 breaking change 吗？**
是。`createLedDescription` / `createMcuDescription` / `BUILTIN_DEVICE_TYPES` / `LedAccessor` /
`McuAccessor` / `createSingleDeviceCircuit` 已从公开入口移除，调用方必须把描述改成自带
`pins` / `states` / `behaviors`。

**Q：删除 v0 原型 API 算 breaking change 吗？**
不算。原型从未出现在包的导出入口中（`package.json` 只导出 `.`，`files` 只包含 `dist`），
删除只影响直接深层导入 `src/unified-ir` 的本地脚本。
