# 实体引脚与公共电气模型

> **来源**：[#24](https://github.com/x-botlab/mica-js/issues/24) · **同步**：2026-10-25
> **实现**：[`packages/core/src/electrical/`](../../packages/core/src/electrical/)
> **依赖**：引脚声明 [#12](https://github.com/x-botlab/mica-js/issues/12) · 电源域 [#13](https://github.com/x-botlab/mica-js/issues/13) · 拓扑 [#14](https://github.com/x-botlab/mica-js/issues/14) · 虚拟时间 [#23](https://github.com/x-botlab/mica-js/issues/23) · IR 核心 [#26](https://github.com/x-botlab/mica-js/issues/26)

统一数字与模拟引脚的驱动、弱偏置、网络解析与采样回退规则。输入取实际网络电压或已确认的浮空回退值，输出表达器件意图，两者状态独立。

**范围内**：理想驱动 + 弱偏置的贡献解析。**范围外**：电阻、阻抗、负载与连续电路求解，需另行提案。

## 主动驱动

主动贡献由输出模式、`outputEnabled`、对应意图 readiness、供电状态与器件连接共同决定。

| 模式         | 数字意图 | 主动贡献 |
| ------------ | -------- | -------- |
| `push-pull`  | `0`      | 拉低     |
| `push-pull`  | `1`      | 拉高     |
| `open-drain` | `0`      | 拉低     |
| `open-drain` | `1`      | 释放     |
| `high-z`     | 任意     | 释放     |

- `analog` 模式依据当前配置选择就绪的电压意图，物理行为由绑定电气模型解释。
- `high-z`、输出使能关闭、意图等待、供电门控关闭时释放主动贡献；释放保留已保存意图，恢复时按当前完整状态重新计算。
- 实际高低电压与驱动特性由引脚、电源与器件电气模型提供。输出意图与实际网络电压分开保存。

## 内部弱上下拉

`up` / `down` / `none` 表示内部弱上拉、内部弱下拉与偏置释放。

- 上下拉归属实体引脚，独立于输出模式、`outputEnabled` 与意图 readiness；纯输入引脚、主动驱动释放的引脚、等待意图的引脚都可提供偏置。
- 功能切换、输出使能关闭、输入观察关闭都保留所选偏置。
- 供电就绪时偏置参与解析，门控关闭时释放物理贡献，恢复后按保存选择与 [#13](https://github.com/x-botlab/mica-js/issues/13) 的电气参考恢复。
- `none` 只释放本引脚内部偏置，其他贡献继续独立参与解析。
- 有效主动驱动可对抗相反弱偏置；开漏 + 弱上拉表达准双向口静态行为。器件特有的短暂强上拉属于该器件自己的时序模型。

## 公共网络与电压

电压单位 V，参考为 [#13](https://github.com/x-botlab/mica-js/issues/13) 的全局 GND，取值必须是有限数值。

解析规则：

1. 优先选取全部生效强驱动；存在强驱动时弱偏置被覆盖。
2. 相容判据为 `max(voltage) - min(voltage) <= 0.001` V；相容时取集合中的**最低**电压。
3. 仅有弱偏置时使用相同的 0.001 V 容差与最低电压规则。
4. 最高优先级贡献超出容差即判定不相容，立即报告模型异常并**暂停整个仿真**，保存相关网络、贡献来源、故障现场与此前已提交的效果。
5. 全部贡献释放时网络浮空。

| 生效贡献                           | 网络结果                       |
| ---------------------------------- | ------------------------------ |
| 全部释放                           | 浮空                           |
| 单个强驱动                         | 该驱动电压                     |
| 多个强驱动，`max - min <= 0.001 V` | 最低强驱动电压（弱偏置被覆盖） |
| 多个强驱动，`max - min > 0.001 V`  | 模型异常                       |
| 仅有弱偏置，`max - min <= 0.001 V` | 最低偏置电压                   |
| 仅有弱偏置，`max - min > 0.001 V`  | 模型异常                       |

`high-z` 与开漏输出 `1` 属于释放，不计入生效贡献集合。推挽、开漏拉低与模拟输出使用同一相容判据，多个同压非零强输出同样允许。浮空同时作为内部物理状态与诊断原因保存；确定模拟电压与确定数字逻辑分别判定，门限区间内的电压仍可作为模拟样本。

## 浮空输入

浮空数字输入默认返回低电平 `0`；物理网络保持浮空。

浮空模拟输入在所属模拟电源域 `[0, VDD]` 内生成固定初始电压 `V0`，再叠加随虚拟时间变化的 `[-0.1, +0.1)` V 扰动并限幅到当前供电范围。算法版本标识 `mica-floating-v2`。

1. 每实例引脚维护 u32 浮空次数，初值 0；进入新的物理浮空阶段时先 +1。门控切换沿用当前阶段，门控期间的物理浮空转换继续计数；确定驱动恢复后再次浮空建立新阶段。
2. `JSON.stringify(["mica-floating-v2", seed, instanceId, pinName, floatingCount])` 按 UTF-8 编码；`seed` 为 u32。
3. FNV-1a 计算 u32 阶段种子，初值 `0x811c9dc5`，每字节 `Math.imul(hash ^ byte, 0x01000193) >>> 0`；哈希为 0 时取 1。
4. 阶段种子执行一次 xorshift32（左移 13 → 逻辑右移 17 → 左移 5），归一化为 u32 后除以 `0x100000000`，乘以阶段建立时的已知 VDD 得 `V0`。阶段建立时门控关闭或供电待定的，`V0` 延至该阶段首次采样就绪时按当时 VDD 初始化。
5. 时间拆为 `low = timePs >>> 0`、`high = Math.floor(timePs / 0x100000000)`；`randomAtTime = mix32(mix32(episodeSeed ^ low) ^ high) / 0x100000000`。
6. `noise = (randomAtTime * 2 - 1) * 0.1`；返回 `clamp(V0 + noise, 0, currentVDD)`。
7. 同一引脚、阶段、时间、供电与门控条件下，主动读取与观察捕获取相同数值；读取次数与观察者数量不影响阶段种子与 `V0`。
8. 算法只在取值时计算，自身不产生调度事件；内核在实际进入浮空时调用 `beginFloating`，就绪时传入供电电压。

参考实现（固定 v2 位级行为，不是生产 API 或 IR 数据字段）：

```ts
function hash32(text: string): number {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(text)) {
    hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
  }
  return hash;
}

function xorshift32(state: number): number {
  state ^= state << 13;
  state ^= state >>> 17;
  state ^= state << 5;
  return state >>> 0;
}

function mix32(value: number): number {
  value = Math.imul(value ^ (value >>> 16), 0x7feb352d);
  value = Math.imul(value ^ (value >>> 15), 0x846ca68b);
  return (value ^ (value >>> 16)) >>> 0;
}

function createFloatingAnalogInput(seed: number, instanceId: string, pinName: string) {
  let floatingCount = 0;
  let episodeSeed = 0;
  let initialVoltage: number | undefined;
  let hasEpisode = false;

  function beginFloating(supplyVoltage?: number): void {
    floatingCount = (floatingCount + 1) >>> 0;
    episodeSeed =
      hash32(JSON.stringify(['mica-floating-v2', seed, instanceId, pinName, floatingCount])) || 1;
    initialVoltage =
      supplyVoltage === undefined
        ? undefined
        : (xorshift32(episodeSeed) / 0x100000000) * supplyVoltage;
    hasEpisode = true;
  }

  function sample(supplyVoltage: number, timePs: number, enabled = true): number {
    if (!enabled) return 0;
    if (!hasEpisode) throw new Error('Call beginFloating before sampling');
    initialVoltage ??= (xorshift32(episodeSeed) / 0x100000000) * supplyVoltage;

    const low = timePs >>> 0;
    const high = Math.floor(timePs / 0x100000000);
    const randomAtTime = mix32(mix32(episodeSeed ^ low) ^ high) / 0x100000000;
    const noise = (randomAtTime * 2 - 1) * 0.1;
    return Math.min(supplyVoltage, Math.max(0, initialVoltage + noise));
  }

  return { beginFloating, sample };
}
```

对照向量（seed `12345`、实例 `device-1`、引脚 `AIN`、供电 3.3 V，四舍五入到 6 位小数）：

| 虚拟时间 / ps    | 第一次浮空 / V | 第二次浮空 / V |
| ---------------- | -------------: | -------------: |
| 0                |       0.312080 |       1.155351 |
| 100              |       0.313270 |       1.046522 |
| 101              |       0.271498 |       1.067295 |
| 4294967296       |       0.224210 |       1.087303 |
| 7200000000000000 |       0.177746 |       1.055952 |

同一已初始化阶段同一时间可重复求值，结果逐位一致；插入额外读取、观察捕获或门控关闭读取，不改变后续指定时间的值。算法要求供电电压有限且非负。

## 输入解释与供电

本模型只提供实际网络电压、物理状态与浮空回退值。数字输入的二态／三态选择、比例门限与逻辑记忆属于 [#13](https://github.com/x-botlab/mica-js/issues/13)，实际电压独立保存。物理解析以实体引脚身份为单位：同一实体出现在多个静态组时仍是同一份物理状态。

## 解析预算

同一虚拟时刻的网络解析默认最多 1,000,000 轮传播，上限可配置。超限按 [#26](https://github.com/x-botlab/mica-js/issues/26) 的预算诊断与暂停边界处理，保留当前虚拟时间与可诊断的传播来源。

## 验证向量

| 场景                        | 预期物理结果                                               |
| --------------------------- | ---------------------------------------------------------- |
| 初始状态                    | `high-z`、输出使能关闭、偏置释放、两类意图等待，无主动贡献 |
| 保存数字 `1`、输出使能关闭  | 意图就绪并保存，主动贡献保持释放                           |
| 就绪开漏写 `1` + 内部弱上拉 | 主动贡献释放，网络可由弱上拉达到高门限                     |
| 同上，外部有效驱动拉低      | 输入得到有效 `0`，数字意图仍为 `1`                         |
| 就绪开漏写 `0` + 内部弱上拉 | 主动拉低，弱上拉作为独立贡献并存                           |
| `high-z` + 有效弱下拉       | 主动贡献释放，采样由弱下拉与其余贡献决定                   |
| 模拟意图为零且网络确定      | 输入返回实际 `0 V`                                         |
| 数字输入浮空                | 采样返回 `0`，网络保留浮空诊断                             |
| 模拟输入浮空                | 采样围绕固定 `V0` 扰动并按当前供电限幅                     |
| 仅时间高 32 位变化          | 高位参与扰动混合                                           |
| 门控关闭期间多次浮空转换    | 阶段按实际物理转换递增，`V0` 在采样恢复就绪时初始化        |
| 多源电压差在容差内          | 强驱动优先，最高优先级集合取最低电压                       |
| 相反弱偏置超出容差          | 当次解析立即异常                                           |
| 网络解析判定不相容          | 立即报告模型异常并暂停仿真，保留故障现场                   |
