# API 参考

统一 IR 的公开 API 都从包入口导入：

```ts
import {
  Circuit,
  CircuitError,
  compileCircuit,
  createButtonIR,
  createCircuitFromSchematic,
  createLedDescription,
  createLedIR,
  createMcuDescription,
  createSingleDeviceCircuit,
  BUTTON_IR_TYPE,
  LED_IR_TYPE,
} from '@mica-js/simulator';
```

调度器路径的 API（`createDeviceSimExecutor`、`createCircuitHost`）见 [README](../README.md)。

---

## `Circuit<Devices>`

一块已编译电路的宿主门面。它拥有引擎实例与 tick 计数；器件、网络和主循环都在同一个
`@mica-js/ir` module 里。

### `Circuit.create(input, options?)`

```ts
static create<const I extends CircuitCompilationInput>(
  input: I,
  options?: CircuitRuntimeOptions,
): Promise<Circuit<I>>;
```

编译输入、构建引擎并执行一次 `initialize`。输入按 `const` 推断，所以

```ts
const circuit = await Circuit.create({
  devices: [{ id: 'led1', type: 'led-ir', description: led.device.description }],
  connections: [
    { from: 'led1.anode', to: 'VCC' },
    { from: 'led1.cathode', to: 'GND' },
  ],
});
circuit.devices.led1.isOn(); // LedAccessor，无需断言
```

`CircuitCompilationInput`：

| 字段          | 类型                      | 说明                                                 |
| ------------- | ------------------------- | ---------------------------------------------------- |
| `devices`     | `readonly DeviceConfig[]` | 器件实例；`id` 全局唯一且必须是标识符                |
| `connections` | `readonly Connection[]`   | `{ from: 'a.pin', to: 'b.pin' }`；右值可以是电平轨名 |

`Connection` 的两端都写成 `<器件 id>.<引脚名>`；`GND`、`VCC`、`VDD` 以及 `electrical.rails`
声明的名字表示固定电平轨。

### `CircuitRuntimeOptions`

| 选项         | 默认值              | 说明                                            |
| ------------ | ------------------- | ----------------------------------------------- |
| `engine`     | `'jit'`             | `'reference'` 使用解释器，逐值对照时用          |
| `jit`        | —                   | `IRJITTuning`，透传给 `@mica-js/ir`             |
| `validateIR` | `true`              | 编译后运行 `validateIR`；只应在已测温的路径关闭 |
| `electrical` | —                   | `{ allowMultiDriver?, rails?, supplyVoltage? }` |
| `instanceId` | `'unified-circuit'` | 报告给引擎的实例 id                             |

### 实例成员

| 成员                                   | 说明                                                                                             |
| -------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `devices`                              | 按器件 id 索引的类型化访问器（只读、冻结）                                                       |
| `step()`                               | 推进一个 tick（调试路径；一次引擎调用）                                                          |
| `runBatch(count)`                      | 推进 `count` 个 tick（吞吐路径；整批一次引擎调用，`count` 为 u32）                               |
| `reset()`                              | 恢复所有内存的声明初值，重跑 `initialize`，`tickCount` 归零                                      |
| `getPin(name)`                         | 读 `<器件>.<引脚>` 的电平：有感知的引脚读解算值，纯驱动引脚读实际驱动值                          |
| `setPin(name, v)`                      | 从宿主强制引脚：驱动引脚写输出锁存，感知引脚覆盖解算值直到下一 tick                              |
| `samplePin(symbol, pin)`               | 探针采样引脚，返回 `{ value: 0 \| 1; ready: true }`；语义同 `getPin`                             |
| `samplePinVoltage(symbol, pin)`        | 探针采样引脚电压（伏特，RFC 0002 §5）：读上一次解网得到的节点电压                                |
| `electricalFault`                      | 上一次解算是否因强驱动冲突而暂停（`0.001 V` 容差，RFC 0002 §4.4）                                |
| `clearElectricalFault()`               | 清除已锁存的冲突标志；驱动仍冲突时下一步会再次锁存                                               |
| `sampleConnection(symbol, connection)` | 探针采样触点，返回 `{ state: 'open' \| 'closed'; ready: true }`（读 `connection_states`）        |
| `turnOn(symbol, domain)`               | 给器件已声明的电源域上电（RFC 0007）；域上的引脚恢复驱动、门控采样恢复、`tick`/`update` 恢复执行 |
| `turnOff(symbol, domain)`              | 断开器件已声明的电源域：驱动引脚释放（高阻）、采样读确定值 `0`、器件逻辑跳过；配置与输出锁存保留 |
| `isPowered(symbol, domain)`            | 查询电源域是否上电；未声明任何域的器件恒为 `true`                                                |
| `tickCount`                            | 已完成 tick 数（`bigint`）                                                                       |
| `jit`                                  | 底层 `IRInterpreter`，用于诊断或调用自定义入口                                                   |
| `disposed`                             | 是否已释放                                                                                       |
| `dispose()`                            | 幂等释放；之后所有调用（含已取出的访问器）抛 `CircuitError('disposed')`                          |

> 电源域（RFC 0007）：器件在 `description.powerDomains` 中按顺序声明
> `{ name, voltage }`，第一个域是该器件的主域。域是布尔门控：所有域在创建与
> `reset()` 后默认上电；`turnOn`/`turnOff` 只写 `power_ready`，下一次
> `step()`/`runBatch()` 重新解网。`voltage` 同时是 RFC 0002 电压解算器的高电平
> （5 V 域推挽输出 5 V），也是该域引脚默认门限的来源。未绑定域的引脚、未声明域的
> 器件保持原有行为。`turnOff` 对未声明域的器件抛 `CircuitError('no-power-domains')`，
> 未知域抛 `CircuitError('power-domain-not-found')`。
>
> 电压与冲突（RFC 0002 §4/§5）：每个节点解出一个电压，写入 `pin_voltage`；
> `pin_voltage_intent` 保存 `pin.writeAnalog` 的模拟输出意图。数字读取在无开关
> 节点上按该引脚的门限判定（`< low` 为 0、`> high` 为 1，中间保持上一次值）。
> 两个强驱动电压相差超过 `0.001 V` 时锁存 `electrical_fault`：主循环在器件更新前
> 返回，`step()`/`runBatch()` 抛 `CircuitError('electrical-conflict')`，直到
> `clearElectricalFault()` 或 `reset()`。

> 失败语义：`runBatch` 在引擎调用成功后才累加 `tickCount`，抛错时时钟不前进。

---

## `compileCircuit(input, options?)`

```ts
function compileCircuit(
  input: CircuitCompilationInput,
  options?: CircuitCompilationOptions,
): CompiledCircuit;
```

编译管线：校验输入 → 全局引脚/状态分配 → 网络拓扑分析 → 每器件每 phase 一个函数 →
每网一个 solver → 主循环 → `validateIR`。

`CircuitCompilationOptions`：

| 选项               | 默认值  | 说明                                            |
| ------------------ | ------- | ----------------------------------------------- |
| `rails`            | —       | 额外的固定电平轨，合并到 `GND`/`VCC`/`VDD` 之上 |
| `allowMultiDriver` | `false` | 多驱动网按线与解算，而不是报 `driver-conflict`  |
| `validate`         | `true`  | 生成后运行 `validateIR`                         |
| `entryPointNames`  | —       | 覆盖 `tick` / `initialize` / `batch` 入口名     |

`CompiledCircuit` 的常用字段：`module`、`entryPoints`、`pinMap`、`deviceMap`、`netlist`、
`pins`、`states`、`memory`、`validation`、`executionOrder`、`functions`。

### 生成的入口

| 入口                    | 说明                                     |
| ----------------------- | ---------------------------------------- |
| `unified_initialize`    | 配置引脚、写入状态初值                   |
| `unified_tick`          | 一个完整步进：驱动 → 解网 → 负载         |
| `unified_tick_batch(n)` | 模块内循环，一次引擎调用跑完 `n` 个 tick |

### 内存布局

| 数组          | 类型   | 长度                       | 含义                                             |
| ------------- | ------ | -------------------------- | ------------------------------------------------ |
| `pin_mode`    | `u8`   | `UNIFIED_PIN_CAPACITY=256` | `0` 高阻 / `1` 推挽 / `2` 开漏 / `3` 模拟        |
| `pin_output`  | `bool` | 256                        | 器件写入的输出锁存                               |
| `pin_input`   | `bool` | 256                        | 解算后负载看到的电平                             |
| `pin_pull`    | `u8`   | 256                        | 弱偏置：`0` 无 / `1` 上拉 / `2` 下拉（RFC 0002） |
| `power_ready` | `bool` | 每个已声明电源域一项       | 电源域就绪位，初值全 `true`（RFC 0007）          |

每器件最多 `DEVICE_PIN_STRIDE=32` 个引脚；整块电路最多 256 个引脚。

RFC 0002 电压内存（同样按全局引脚编号寻址）：

| 数组                 | 类型  | 长度 | 含义                                         |
| -------------------- | ----- | ---- | -------------------------------------------- |
| `pin_voltage`        | `f32` | 256  | 上一次解网得到的节点电压（伏特）             |
| `pin_voltage_intent` | `f32` | 256  | `pin.writeAnalog` 写入的模拟输出意图（伏特） |
| `pin_low_threshold`  | `f32` | 256  | 低于该电压读数字 0；按引脚电源域初值缩放     |
| `pin_high_threshold` | `f32` | 256  | 高于该电压读数字 1                           |
| `electrical_fault`   | `u8`  | 1    | `0` 正常 / `1` 强驱动冲突（RFC 0002 §4.4）   |

---

## 器件

### 内置器件

不提供 `description.behaviors` 时，编译器按 `type` 选择内置内核：

| `type`（别名）          | 引脚               | 行为                                   |
| ----------------------- | ------------------ | -------------------------------------- |
| `mcu`（`teaching-mcu`） | `PA0`              | 每个 tick 翻转所有输出引脚并配置为推挽 |
| `led`（`ideal-led`）    | `anode`、`cathode` | `lamp = anode && !cathode`             |

```ts
import { createLedDescription, createMcuDescription } from '@mica-js/simulator';

const mcu = createMcuDescription(); // PA0 输出
const led = createLedDescription(); // anode / cathode + lamp 状态
```

描述可以覆盖引脚与状态；未声明的部分由内置内核补齐。

### `LedConfig` — `createLedIR(id, config?)`

| 字段                | 默认值  | 说明                                               |
| ------------------- | ------- | -------------------------------------------------- |
| `anode` / `cathode` | 同名    | 端子引脚名                                         |
| `color`             | `'red'` | `red`、`green`、`blue`、`yellow`、`amber`、`white` |
| `forwardVoltage`    | `2`     | 信息字段                                           |
| `activeLow`         | `false` | 反向安装：阳极低、阴极高时点亮                     |
| `maxBrightness`     | `255`   | 亮度上限（1–255）                                  |
| `initialBrightness` | 上限值  | 初始亮度上限                                       |

返回 `LedIRDevice`：`{ id, type, config, module, layout, device, validation, buildAccessor }`。
把 `device.description` 放进 `Circuit.create` 的 `devices` 即可。

`LedIRAccessor`（包入口的导出名；内置 `led` / `ideal-led` 的访问器叫 `LedAccessor`）：
`isOn()`、`isForwardBiased()`、`getBrightness()`、`getLevel()`、
`setBrightness(value)`、`readAnode()`、`readCathode()`、`readPinInput(name)`、`samplePin(name)`、
`refresh()`、`step(count?)`、`run(count)`、`snapshot()`，以及通用访问器成员。

### `ButtonConfig` — `createButtonIR(id, config?)`

| 字段             | 默认值        | 说明                               |
| ---------------- | ------------- | ---------------------------------- |
| `a` / `b`        | `'A'` / `'B'` | 开关端 / 参考端                    |
| `initialPressed` | `false`       | 初始位置                           |
| `debounceTicks`  | `0`           | 原始输入稳定的 tick 数，之后才发布 |
| `activeLow`      | `false`       | 按下时把 `A` 拉低而不是拉高        |

`ButtonIRAccessor`（包入口的导出名）：`press()`、`release()`、`toggle()`、`setPressed(v)`、`isPressed()`（原始）、
`isClosed()`（去抖后）、`isBouncing()`、`getPressCount()`、`resetPressCount()`、`getHoldTicks()`、
`getLineLevel()`、`getReferenceLevel()`、`readPinInput(name)`、`samplePin(name)`、`step(count?)`、
`run(count)`、`snapshot()`。

---

## 访问器

### `DeviceAccessor`

所有访问器都实现：

```ts
interface DeviceAccessor {
  readonly deviceId: string;
  readonly type: string;
  readonly pinNames: readonly string[];
  readonly stateNames: readonly string[];
  readPin(pinName: string): boolean; // 器件驱动到该引脚的输出锁存
  writePin(pinName: string, value: boolean): void; // 仅驱动引脚
  getState(name: string): unknown;
  setState(name: string, value: unknown): void;
}
```

- `readPin` 返回**器件驱动**的电平；`Circuit.getPin` 返回**解算后**的电平。
- `writePin` 对 load / passive 引脚抛 `CircuitError('pin-not-writable')`。

### `StorageAccessor`

自定义访问器（`DeviceDescription.accessor`）拿到的存储子集，`IRStorage` 结构性满足：

```ts
interface StorageAccessor {
  loadState<T extends ScalarType>(ref: StateRef<T>): RuntimeScalar;
  storeState<T extends ScalarType>(ref: StateRef<T>, value: RuntimeScalar): void;
  loadArray<T extends ScalarType>(ref: ArrayRef<T>, index: number): RuntimeScalar;
  storeArray<T extends ScalarType>(ref: ArrayRef<T>, index: number, value: RuntimeScalar): void;
}
```

教学 MCU 的访问器额外需要 `loadBytes` / `storeBytes` / `updateBytes`。

### 自定义访问器

```ts
const description: DeviceDescription = {
  pins: { out: { direction: 'output' } },
  states: { count: { type: 'u32', initial: 0 } },
  kernel: (context) => {
    // 在这里向 context.module 声明私有内存并返回 phase 函数
  },
  accessor: ({ deviceId, storage, assertActive }) => ({
    deviceId,
    type: 'counter',
    pinNames: ['out'],
    stateNames: ['count'],
    readPin: () => false,
    writePin: () => {},
    getState: () => storage.loadState(countRef),
    setState: (value) => {
      assertActive();
      storage.storeState(countRef, value as number);
    },
  }),
};
```

---

## 工厂

### `createSingleDeviceCircuit(type, config?, options?)`

```ts
const led = await createSingleDeviceCircuit('ideal-led');
led.devices.device.isOn();
```

用内置内核造单器件电路；`device` 是固定 id，器件类型保留在访问器类型里。没有内置内核的类型
会以 `Unsupported device` 编译错误拒绝。

### `createCircuitFromSchematic(schematic, options)`

```ts
const circuit = await createCircuitFromSchematic(schematic, {
  devices: symbolProvider,
  resolveDevice: (reference) => bindings.get(reference.deviceId),
  tolerance: 0.5,
});
```

把原理图折成网表：导线/junction/label 变成网，电源与地符号变成电平轨。`resolveDevice` 必须为每个
组件符号返回 `{ type, description, config? }`；缺失时抛 `CircuitError('unresolved-device')`。
器件 id 取位号（非法字符会规范化并去重）。`devices` 是画布同一份 `DeviceSymbolProvider`，
用于定位引脚几何。

### `compileSchematicToCircuit(document, provider, options?)`

```ts
const { input, rails, diagnostics } = await compileSchematicToCircuit(sheet, provider);
if (diagnostics.every((entry) => entry.severity !== 'error')) {
  const circuit = await Circuit.create(input, { electrical: { rails } });
}
```

从 `IDeviceProvider` 拿器件描述，把 `.sch` 编译成 `CircuitCompilationInput` 与电平轨，**不抛错**：

- 符号 → 器件：位号（或符号 id）规范化为器件 id，重复时追加 `_2`；`builtin:power`、
  `builtin:ground`、`builtin:label`、`builtin:text` 不参与实例化。
- 导线 → 连接：几何由器件描述的引脚 side 合成，网表的引脚两两相连；网里有电源/地符号时，
  所有引脚直接连到该轨。
- 电平轨：`builtin:power` 的 `net`（缺省 `3V3`）为高；`builtin:ground` 只接受 `GND`
  （缺省 `GND`）为低。其它地网名、把 `GND` 当作电源名都是错误诊断。
- 属性：器件描述的属性描述符 + 符号覆盖 → `config`，非法取值报 `invalid-property`。

没有 `resolveDevice` 时，器件描述来自器件包本身（引脚 + topic 端口），行为为空：包描述不携带
IR 逻辑。需要真实行为的器件用 `resolveDevice` 返回 `{ type, description?, config? }`。

### `compileBoardTopology(topology, devices)`

宿主的板级接线（`TopologyDefinition`：引脚、导线、器件触点）不在 `.sch` 里时，用这个前端把它折成
编译器输入的一部分：

```ts
const board = compileBoardTopology(boardFixture.topology, compilation.devices);
const input = {
  ...compilation.input,
  connections: [...compilation.input.connections, ...board.connections],
};
const circuit = await Circuit.create(input, {
  electrical: { rails: { ...compilation.rails, ...board.rails } },
});
```

- 电源引脚 → 以引脚名命名的电平轨（`board.VCC → 'VCC'` 高）；地引脚或 `globalGnd` → `'GND'` 低。
- 一条导线上的器件引脚连成同一个网；只有宿主引脚（如 `board.SENSE`）的导线不产生连接。
- `aliases` 把宿主引脚映射到同一条导线上的器件引脚（`board.SENSE → 'S1.B'`），供探针采样。

## 主题（Topic）

器件用 `description.ports` 声明逻辑端口；编译器把每个端口变成一个 IR 端点：

```ts
const sink: DeviceDescription = {
  pins: {},
  ports: { show: { direction: 'input', type: 'number' } },
  behaviors: {
    initialize: (api) => {
      api.topics.subscribe('show', (entry) => {
        entry.state<'f64'>('value').store(entry.args[0] as Value<'f64'>);
      });
    },
  },
};

const circuit = await Circuit.create({
  devices: [{ id: 'sink1', type: 'sink', description: sink }],
  connections: [],
});
circuit.deliverTopic('sink1', 'show', 42); // 同步执行入口
```

- 载荷编码固定：`boolean → bool`、`number → f64`、`vec2d/vec3d → f64 × n`、
  `string` 与 `bytes/bytes<*>` → `u32` 长度 + 4 字节一个 word（上限 32 字节）。
- 输出端口是 `bridge.send`：每 tick 调用 `api.topics.publish(port, [value])`，
  `circuit.onPublish(listener)` 同步收到 `DevicePublish`（`target.symbol` 是器件 id）。
- 输入端口是一个 IR 入口：`api.topics.subscribe(port, handler)` 生成入口函数体，一个端口只能有
  一个 handler；没有人订阅的端口会被编译成空入口，投递不会报错。
- `Circuit.topics` 列出全部端点；`deliverTopic` 对未知/输出端口抛 `topic-not-found`，
  对类型不符的载荷抛 `invalid-topic-payload`。

## DeviceSimExecutor 适配器

```ts
const executor = createCircuitExecutor({ devices: provider, resolveDevice });
await executor.loadSchematic(sheet);
executor.deliver({ symbol: 'S1', port: 'pressed' }, true);
const report = executor.advance(timePs(16_000_000)); // 16 个 tick
```

`createCircuitExecutor` 让新引擎实现旧的 `DeviceSimExecutor` 接口：每次 `loadSchematic` 编译一个
`Circuit`，`advance` 变成一次 `runBatch`，`deliver` 在下一个 `advance` 开始时投递，
`onPublish` 收到带符号 id 与皮秒时间戳的消息。

时间以 **1 tick = 1 µs**（`TICK_PS`）换算：`advance(delta)` 执行 `floor(delta / TICK_PS)` 个 tick，
并在 `AdvanceReport` 里报告实际到达的时间；小于一个 tick 的 `delta` 不执行任何 tick。
`scheduler` 与 `host` 属于调度器路径，适配器会忽略它们。

探针：`samplePin(symbol, pin)`、`samplePinVoltage(symbol, pin)` 与
`sampleConnection(symbol, connection)` 转发给 `Circuit`，`symbol`
既可以是原理图符号 id（探针表里存的那个），也可以是位号。可选 `topology` 选项把宿主板级接线
（见 `compileBoardTopology`）折进编译输入，于是 `board.SENSE` 这类宿主引脚也能采样到同一条导线上
的器件引脚电平。这些方法在 `DeviceSimExecutor` 上是可选的：只有自带电气模型的执行器实现它们。

---

## 错误

### `CircuitError`

```ts
class CircuitError extends Error {
  readonly code: CircuitErrorCode;
  readonly deviceId?: string;
  readonly pinName?: string;
  readonly stateName?: string;
}
```

`code` 取值包括 `invalid-options`、`invalid-count`、`pin-not-found`、`pin-not-writable`、
`state-not-found`、`invalid-state-value`、`register-not-found`、`invalid-register-value`、
`unresolved-device`、`invalid-topic-payload`、`topic-not-found`、`no-power-domains`、
`power-domain-not-found`、`electrical-conflict`、`disposed` 等。

### `UnifiedIRCompilerError`

编译期错误，`code` 为 `invalid-input`、`duplicate-device`、`unknown-device`、`pin-not-found`、
`state-not-found`、`invalid-connection`、`capacity-exceeded`、`unsupported-device`、
`driver-conflict`、`power-short`、`rail-conflict`、`invalid-ir`。

### 器件错误

`LedError` 和 `ButtonError` 各自带稳定的 `code`（`invalid-config`、
`layout-not-found`、`invalid-count` 等），构造函数会校验配置并在消息里给出可接受值。
