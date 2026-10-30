# 器件引脚声明与运行时配置

- Start Date: 2026-10-16
- Reference Issues: [#12](https://github.com/x-botlab/mica-js/issues/12)
- Implementation PR: [#114](https://github.com/x-botlab/mica-js/pull/114)

器件通过静态声明提供实体引脚与固定成员顺序的引脚组；每个实例独立保存配置与输出意图。器件内部功能通过这些共享状态表达有效控制。本文只规定引脚资源的声明与状态，不定义访问指令或物理解析算法。

## 静态声明

| 字段        | 类型   | 默认值 | 语义                     |
| ----------- | ------ | ------ | ------------------------ |
| `pins`      | object | `{}`   | 引脚 ID 到引脚描述的映射 |
| `pinGroups` | object | `{}`   | 引脚组 ID 到组描述的映射 |

标识在当前器件内稳定、唯一、长度至少为 1，按大小写精确匹配。空对象表达空声明集合。

### 引脚字段

| 字段   | 类型   | 默认值   | 语义                                               |
| ------ | ------ | -------- | -------------------------------------------------- |
| `kind` | string | 必须提供 | `power`、`gnd` 或 `signal`，表达物理引脚类别       |
| `side` | string | `left`   | 符号上引脚所在侧：`left`、`right`、`top`、`bottom` |

- `kind` 表达物理类别；运行时输出模式与上下拉是独立配置，不由类别推断。实体引脚身份在实例内保持稳定。
- `side` 只表达呈现位置，不携带电气语义，也不推断 `kind`。原理图符号的几何（本体尺寸与引脚坐标）由引脚声明生成，同一侧内按声明顺序排列；缺省显示在左侧。

### 引脚组

`pinGroups.<group-id>` 含一个 `pins` 数组，成员引用当前器件内的实体引脚。数组长度至少为 1，成员唯一，顺序固定；组宽由成员数量确定，数组顺序在实例期固定。

一个实体引脚可以参与多个静态组，各组共享该引脚的同一份配置与意图。

### 工厂电气初始化

实体引脚的电气能力由配对 JS 工厂显式提供，初始参数可以来自实例属性或器件固定常量。`direction`、`role`、`passive` 不作为引脚 JSON 字段；`kind` 和 `side` 保持物理类别和呈现含义。引脚的驱动、数字采样与偏置能力分别由以下参数提供。

```ts
interface ElectricalReference {
  readonly source: string;
}

interface PinElectricalDescription {
  readonly drive?: {
    readonly reference: ElectricalReference;
    readonly highResistance: number;
    readonly lowResistance: number;
    readonly analogResistance?: number;
    readonly maxAbsCurrent?: number;
  };
  readonly bias?: {
    readonly reference: ElectricalReference;
    readonly upResistance: number;
    readonly downResistance: number;
  };
  readonly input?: {
    readonly reference: ElectricalReference;
    readonly low: number;
    readonly high: number;
  };
}

interface DeviceElectricalInitialization {
  initializePin(id: string, initial: PinElectricalDescription): void;
}
```

- `id` 引用当前实例已声明的引脚，资源引用按大小写精确匹配。
- 每次初始化至少提供 `drive`、`bias`、`input` 中的一项；单个引脚每实例初始化一次。
- 所有电阻以 Ω 为单位，要求有限且大于零；可选电流阈值以 A 为单位，要求有限且大于零。
- `reference.source` 为非空源 ID，链接时必须绑定当前电路显式声明的参考源。
- `drive` 表达主动输出能力，高低电阻分别适用于高、低数字意图，模拟输出使用 `analogResistance`。
- `bias` 表达弱上拉和弱下拉的电阻，选择状态由运行期引脚配置控制。
- `input` 的比例满足有限的 `0 <= low < high <= 1`，采样解释由 [RFC 0007](./0007-device-power-domains.md) 维护。
- 输入解释模式归属整次仿真，`input` 不重复声明 `interpretation`。
- 未初始化电气能力的端子可作为电阻或触点端点；生成主动输出或数字采样指令时必须具有对应能力。
- 初始化不设置输出模式、输出使能、输出意图或上下拉选择；这些仍是独立运行状态。
- 非法数值报告 `electrical/invalid-parameter`；未知引脚、重复初始化和关闭后的调用按 [RFC 0005](./0005-device-definition.md) 处理。

```js
ctx.electrical.initializePin('PA0', {
  drive: {
    reference: { source: 'VDD' },
    highResistance: 30,
    lowResistance: 25,
    maxAbsCurrent: 0.02,
  },
  input: { reference: { source: 'VDD' }, low: 0.3, high: 0.7 },
});
```

该初始化合同属于线性电阻模型扩展，运行期物理解算由 [RFC 0002](./0002-electrical-model.md) 的电气合同承接；初始化 API 与完整求解器接入分别验证。

## 运行时状态

| 状态         | 新实例初始值 | 语义                         |
| ------------ | ------------ | ---------------------------- |
| 输出模式     | `high-z`     | 选择主动驱动解释方式         |
| 输出使能     | `false`      | 由器件 IR 计算的主动输出控制 |
| 内部上下拉   | `none`       | 独立的内部偏置选择           |
| 数字输出意图 | 等待首次提交 | 保存数字值及其就绪状态       |
| 电压输出意图 | 等待首次提交 | 保存电压值及其就绪状态       |

枚举取值：

| 类别       | 取值                                          |
| ---------- | --------------------------------------------- |
| 输出模式   | `high-z`、`push-pull`、`open-drain`、`analog` |
| 内部上下拉 | `none`、`up`、`down`                          |

模式、输出使能、偏置与输出意图分别维护：模式与使能更新保留已提交意图；意图写入保留模式、使能与偏置。数字意图与电压意图各自保留独立的 readiness，器件既可以先配置再提交意图，也可以先准备意图再改变使能。

模式、使能与偏置属于实体引脚资源，器件内部的多个功能通过 IR 计算该资源的有效控制；内部优先级、共享外设、寄存器、芯片模拟模式与复位时的配置选择由器件模型表达。

## 状态保存与生命周期

配置与意图跨器件内部功能选择保存。资源当前是否参与外部作用，与其保存的配置和意图分别维护；参与条件变化本身不改变这些状态。寄存器的保持、复位或重建由器件生命周期处理决定。

## 声明示例

```json
{
  "pins": {
    "VCC": { "kind": "power", "side": "top" },
    "GND": { "kind": "gnd", "side": "bottom" },
    "D0": { "kind": "signal", "side": "left" },
    "D1": { "kind": "signal", "side": "left" },
    "AOUT": { "kind": "signal", "side": "right" }
  },
  "pinGroups": {
    "data": { "pins": ["D0", "D1"] }
  }
}
```

## 校验

静态校验覆盖标识、字段类型、引脚类别、显示侧取值、实体引用、组非空与成员唯一性。实例期保持成员顺序与共享实体身份。

## 状态对照

| 场景                       | 预期                                                       |
| -------------------------- | ---------------------------------------------------------- |
| 新实例                     | 输出模式 `high-z`、使能 `false`、偏置 `none`、两类意图等待 |
| 改模式与使能               | 已提交意图保持                                             |
| 写意图                     | 模式、使能、偏置保持                                       |
| 多组共享同一实体           | 各组看到同一份配置与意图                                   |
| 生命周期保持 / 复位 / 重建 | 按器件模型指定的策略处理配置与意图                         |
