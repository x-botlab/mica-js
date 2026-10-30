# 迁移到线性电阻电气模型

`@mica-js/simulator` 的电气仿真改为线性电阻网络。旧版本用布尔电平、固定电轨和线或规则解析网络；当前版本统一由显式电压源、有限电阻、内部上下拉、真实电阻支路与双向理想触点求解节点电压和支路电流。

本指南面向从 `0.3.x` 升级的调用方与器件作者。DeviceSimulationHost 与 RPC 合同未变；变化集中在电路编译输入、器件描述和引脚驱动的写法。

## 变更对照

| 旧用法                                                    | 当前用法                                                                      |
| --------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `electrical: { rails: { PWR: true } }`                    | `electrical: { sources: { PWR: { voltage: 5 } } }`                            |
| 连接端点直接写 `VCC`、`VDD` 或其他布尔电轨                | 在 `sources` 中声明同名电压源；`GND` 固定为 `0 V`，无需声明                   |
| 省略数字输入解释模式                                      | 必须显式传入 `interpretation: 'two-state'` 或 `'retain-in-band'`              |
| 只有 `behaviors`、没有配对工厂的器件描述                  | 每个器件提供同步 `factory`，在工厂内初始化引脚能力与电阻支路                  |
| JSON 中的 `direction`、`role`、`electrical` 字段          | 引脚能力由工厂的 `initializePin` 提供；JSON 只保留 `kind` 与 `side`           |
| `Circuit.setPin` / `DeviceAccessor.writePin`（已移除）    | 器件状态 + 类型化 IR 操作；宿主用 `setState` 改变输入状态                     |
| `DeviceBehaviorApi.memory` / `DeviceKernelContext.memory` | `api.state()` 读写描述中声明的器件状态，或在 kernel 中声明自己的 IR 数组      |
| 多驱动网按线或、强驱动优先级或固定电轨解析                | 各驱动的有限输出电阻、上下拉、电阻支路与闭合触点共同参与电流守恒              |
| 布尔采样直接当作物理结果                                  | 数字采样按解释模式返回；物理电压与支路电流用 `getVoltage` / `getCurrent` 观察 |

## 1. 电路创建：显式参考源与解释模式

```ts
import { Circuit } from '@mica-js/simulator';

const circuit = await Circuit.create(input, {
  electrical: {
    sources: {
      VDD: { voltage: 5 },
      VCC: { voltage: 3.3 },
    },
    interpretation: 'two-state',
  },
});
```

- `sources` 的值是相对全局 GND 的有限电压，单位为 V。连接端点与 `reference.source` 都按源名匹配。
- 直接调用 `compileCircuit` 时，`sources` 与 `interpretation` 是编译选项的顶层字段。
- `GND` 是固定的 `0 V` 参考节点，不写入 `sources`。
- `interpretation` 没有默认值。`two-state` 把低于高门限的确定电压判为 `0`；`retain-in-band` 在门限区间保持上一次逻辑值。
- 通过原理图创建电路时，`builtin:power` 的网名默认为 `VCC`。要么把原理图网络改名为已声明的源名，要么在 `sources` 中声明 `VCC`。
- 省略 `sources` 时只能使用 `GND`；任何 `reference.source` 未绑定到已声明源都会在编译期报错。

## 2. 器件描述：JSON 声明资源，JS 工厂初始化

JSON 只声明引脚、属性、电阻支路和触点；电气能力必须由同名 JS 模块的默认同步工厂初始化。每个实例调用一次工厂，工厂返回或抛出后关闭初始化入口。

```json
{
  "properties": {
    "resistance": { "type": "number", "default": 1000, "exclusiveMin": 0, "unit": "ohm" }
  },
  "pins": {
    "A": { "kind": "signal", "side": "left" },
    "B": { "kind": "signal", "side": "right" }
  },
  "resistors": {
    "body": { "pins": ["A", "B"] }
  }
}
```

```js
export default function createResistor({ electrical, properties }) {
  electrical.initializeResistor('body', {
    resistance: properties.resistance,
    enabled: true,
  });
}
```

- `initializePin` 至少提供 `drive`、`bias`、`input` 中的一项；电阻值有限且大于零。
- 在 TypeScript 工厂中，`properties` 的值类型是 `PropertyValue`；先判定 `typeof value === 'number'` 与有限性，再传给 `initializeResistor`。
- `drive`、`bias` 与 `input` 都通过 `reference.source` 引用 `sources` 中的源名。
- `initializeResistor` 必须覆盖 JSON 声明的每条 `resistors` 支路；`enabled` 显式提供，零欧连接使用理想触点。
- `connections` 无需工厂初始化，初始状态由 JSON 的 `initial` 给出。
- 工厂可以返回 `initialize`、`tick`、`update` 行为；返回 `undefined` 表示器件没有运行期行为。工厂不能返回 Promise。
- 以配对工厂和电气资源绑定的 `kernel` 仍可作为器件实现；删除的只是没有工厂／电气绑定的旧执行路径。
- JSON 引脚声明中的 `direction`、`role`、`electrical` 会被拒绝；TypeScript 的 `DevicePinDescription` 也只保留 `kind` 与 `side`。这些语义由工厂初始化替代。

引脚能力示例：

```js
export default function createGpio({ electrical }) {
  electrical.initializePin('PA0', {
    drive: {
      reference: { source: 'VDD' },
      highResistance: 50,
      lowResistance: 50,
    },
    bias: {
      reference: { source: 'VDD' },
      upResistance: 30000,
      downResistance: 30000,
    },
    input: {
      reference: { source: 'VDD' },
      low: 0.3,
      high: 0.7,
    },
  });
  return {
    initialize(api) {
      const pin = api.pin('PA0');
      pin.configure(1);
      pin.setOutputEnabled(api.builder.const('bool', true));
    },
    tick(api) {
      api.pin('PA0').writeDigital(api.state('level').load());
    },
  };
}
```

上面的 `1` 对应 `PIN_MODE.pushPull`。`level` 是器件状态，需要在描述中声明：

```ts
const description = {
  ...definition,
  states: { level: { type: 'bool', initial: false } },
  factory,
};
```

其中 `definition` 是配对的 JSON 描述，`factory` 是该 JS 文件的默认导出。

## 3. 驱动：从宿主直写引脚改为器件状态与 IR 操作

`Circuit.setPin` 与 `DeviceAccessor.writePin` 已移除。宿主改变状态，器件 IR 在下一 tick 提交引脚意图：

```ts
circuit.devices.gpio1.setState('level', true);
circuit.step();
```

- 数字输出：`pin.writeDigital(level)`。
- 模拟输出：`pin.writeVoltage(voltage)`，引脚需要有 `analogResistance`。
- 模式、使能与上下拉：`pin.configure(mode)`、`pin.setOutputEnabled(enabled)`、`pin.setPull(pull)`。
- 电阻与触点：`setResistance` / `setEnabled`、`applyResistors`、`applyConnections`。
- 只有驱动能力的引脚才能写输出意图；纯被动或纯输入引脚写意图会在构建期报错。

`sampleDigital` 读取本次解析后的数字输入，`readDrivenDigital` 读取器件自己保存的数字输出意图，两者语义不同。

## 4. 多驱动与布尔语义

旧版本的线或、强驱动覆盖与固定电轨不再存在。相反的两个有限驱动不会互相覆盖，而是按各自输出电阻形成负载；开漏释放与上拉共同决定网络电压；不同电压的理想源接在同一等电位节点时报告 `electrical/source-conflict` 并暂停求解。

需要“线与”或“准双向”行为时，用开漏输出加有限上拉表达；需要更大电流能力时，降低有限输出电阻，而不是依赖优先级。

## 5. 电压与电流采样

- `pin.sampleVoltage()` 对确定网络返回实际电压；对浮空模拟输入返回 `mica-floating-v2` 的确定性伪噪声，用于保持可重复性，不代表物理驱动。
- `resistor(name).sampleCurrent()` 返回本次解析后的支路电流，单位 A，正方向为第一端到第二端；断开的支路返回 `0`。被动负载应优先使用电流乘自身电阻计算压降，避免把浮空输入的伪噪声当作物理电压。
- `Circuit.getVoltage('device.pin')` 返回物理电压观察：`determinate` 带数值，`floating` 表示未连接有效参考的被动分量。浮空观察不回填采样合成的电压。
- `Circuit.getCurrent(target)` 接受 `'device.resistor'`、`{ kind: 'contact', device, name }`、`{ kind: 'source', name }` 以及 `{ kind: 'drive' | 'pull-up' | 'pull-down', device, pin }`。电阻与触点电流按端点顺序为正；源与引脚贡献以流出网络为正；自由电流无法唯一确定时返回 `indeterminate`。
- `Circuit.getDiagnostics()` 返回当前活动诊断。超过 `maxAbsCurrent` 产生 `electrical/overcurrent` 警告，不钳位电流；求解故障保留最近一次成功快照，直到复位。

## 6. 诊断与校验

| 诊断码                         | 触发条件                                                       |
| ------------------------------ | -------------------------------------------------------------- |
| `electrical/invalid-parameter` | 非有限电压、非正电阻、非法门限或无效电流阈值                   |
| `electrical/source-conflict`   | 同一等电位节点上的理想源电压不同                               |
| `electrical/numerical-failure` | 网络无法形成有限、有效解                                       |
| `electrical/overcurrent`       | 支路或驱动电流绝对值超过声明的 `maxAbsCurrent`，按活动警告处理 |

求解错误诊断还携带 `target?`、`resources` 与 `pins`。`target` 在可识别失败操作、支路或源时给出；`resources` 表示受影响的关联网络，不表示全部资源都有责任；`pins` 以 `device.pin` 列出相关引脚。数值求解故障无法归因到单一操作、支路或源时不给出 `target`。`electrical/overcurrent` 保持资源身份、带方向电流与 `maxAbsCurrent`。

工厂初始化错误另有 `electrical/invalid-definition`、`electrical/unknown-resource`、`electrical/duplicate-initialization`、`electrical/missing-initialization` 与 `electrical/factory-closed`；它们发生在电路创建期，整体拒绝该次装载。

## 7. 迁移检查

- 搜索 `rails`、`DEFAULT_RAILS`、`setPin(`、`writePin(` 与 `.memory`，逐一改为 `sources`、`interpretation`、器件状态和类型化 IR 操作。
- 确认每个运行期器件的描述都带同步 `factory`，并且每条 `resistors` 支路都被初始化。
- 确认原理图中的电源符号网名与 `sources` 键一致；`GND` 不需要声明。
- 确认测试中的浮空模拟电压断言按 `mica-floating-v2` 的确定性伪噪声处理，不按 `0 V` 或物理驱动处理。
- Playground 的 `demo:ideal-led`、`demo:potentiometer`、`demo:debounced-button` 与 `demo:resistor` 提供了配对 JSON/JS 示例；`potentiometer-led` 与 `pullup-button-led` 示例演示有限负载、亮度平滑与按键接地。

## 关联

- [RFC 0002](../rfc/0002-electrical-model.md)：线性电阻网络、浮空回退、电流方向与诊断。
- [RFC 0004](../rfc/0004-ir-pin-io.md)：引脚 I/O、采样、门控与观察。
- [RFC 0005](../rfc/0005-device-definition.md)：器件定义与 JSON/JS 配对。
- [RFC 0006](../rfc/0006-device-pins.md)：引脚能力与工厂电气初始化。
- [RFC 0007](../rfc/0007-device-power-domains.md)：电源域、门限与数字输入解释模式。
- [RFC 0008](../rfc/0008-device-topology.md)：电阻支路、触点、电流采样与拓扑更新。
