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

调度器路径的 API（`createDeviceSimExecutor`、`createCircuitHost`）见
[README](../README.md) 与 [DEPRECATIONS.md](./DEPRECATIONS.md)。

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
| `electrical` | —                   | `{ allowMultiDriver?, rails? }`                 |
| `instanceId` | `'unified-circuit'` | 报告给引擎的实例 id                             |

### 实例成员

| 成员              | 说明                                                                    |
| ----------------- | ----------------------------------------------------------------------- |
| `devices`         | 按器件 id 索引的类型化访问器（只读、冻结）                              |
| `step()`          | 推进一个 tick（调试路径；一次引擎调用）                                 |
| `runBatch(count)` | 推进 `count` 个 tick（吞吐路径；整批一次引擎调用，`count` 为 u32）      |
| `reset()`         | 恢复所有内存的声明初值，重跑 `initialize`，`tickCount` 归零             |
| `getPin(name)`    | 读 `<器件>.<引脚>` 的电平：有感知的引脚读解算值，纯驱动引脚读实际驱动值 |
| `setPin(name, v)` | 从宿主强制引脚：驱动引脚写输出锁存，感知引脚覆盖解算值直到下一 tick     |
| `tickCount`       | 已完成 tick 数（`bigint`）                                              |
| `jit`             | 底层 `IRInterpreter`，用于诊断或调用自定义入口                          |
| `disposed`        | 是否已释放                                                              |
| `dispose()`       | 幂等释放；之后所有调用（含已取出的访问器）抛 `CircuitError('disposed')` |

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

| 数组         | 类型   | 长度                       | 含义                                      |
| ------------ | ------ | -------------------------- | ----------------------------------------- |
| `pin_mode`   | `u8`   | `UNIFIED_PIN_CAPACITY=256` | `0` 高阻 / `1` 推挽 / `2` 开漏 / `3` 模拟 |
| `pin_output` | `bool` | 256                        | 器件写入的输出锁存                        |
| `pin_input`  | `bool` | 256                        | 解算后负载看到的电平                      |

每器件最多 `DEVICE_PIN_STRIDE=32` 个引脚；整块电路最多 256 个引脚。

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

`code` 取值见 [MIGRATION.md](./MIGRATION.md#错误处理)。

### `UnifiedIRCompilerError`

编译期错误，`code` 为 `invalid-input`、`duplicate-device`、`unknown-device`、`pin-not-found`、
`state-not-found`、`invalid-connection`、`capacity-exceeded`、`unsupported-device`、
`driver-conflict`、`power-short`、`rail-conflict`、`invalid-ir`。

### 器件错误

`LedError` 和 `ButtonError` 各自带稳定的 `code`（`invalid-config`、
`layout-not-found`、`invalid-count` 等），构造函数会校验配置并在消息里给出可接受值。
