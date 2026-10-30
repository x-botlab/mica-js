# 实体引脚与公共电气模型

- Start Date: 2026-10-19
- Reference Issues: [#24](https://github.com/x-botlab/mica-js/issues/24)
- Implementation PR: [#80](https://github.com/x-botlab/mica-js/pull/80)

规定无储能线性电阻网络的驱动、偏置、电压、电流、故障与采样回退。输入取实际网络电压或已确认的浮空回退值，输出意图独立保存。

本次修订将贡献优先级解析改为线性电阻电气语义，以支持负载、分压和有限输出电阻；沿用原编号及浮空算法版本，与 [RFC 0004](./0004-ir-pin-io.md)、[RFC 0006](./0006-device-pins.md)、[RFC 0008](./0008-device-topology.md) 同步。

## 声明

- 电压采用有限 `f64`，单位 V，相对全局 `GND = 0 V`；电阻单位 Ω，电流单位 A。
- 有限电阻满足 `R > 0`；理想导通采用导线或理想触点，断路采用显式释放状态。
- 独立电压源相对全局 GND，源电压显式声明；主动引脚采用电压源与有限输出电阻，内部上下拉分别采用有限电阻。
- 引脚能力与初值由 [RFC 0006](./0006-device-pins.md) 声明；电阻与触点端点由 [RFC 0005](./0005-device-definition.md)、[RFC 0008](./0008-device-topology.md) 声明。
- 电容、二极管、限流电源、浮置双端源与非线性模型不属于本合同。

## 运行时

### 主动驱动

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

### 内部上下拉

`up` / `down` / `none` 表示内部弱上拉、内部弱下拉与偏置释放。

- 上下拉归属实体引脚，独立于输出模式、`outputEnabled` 与意图 readiness；纯输入引脚、主动驱动释放的引脚、等待意图的引脚都可提供偏置。
- 功能切换、输出使能关闭、输入观察关闭都保留所选偏置。
- 供电就绪时偏置参与解析，门控关闭时释放物理贡献，恢复后按保存选择与 [#13](https://github.com/x-botlab/mica-js/issues/13) 的电气参考恢复。
- `none` 只释放本引脚内部偏置，其他贡献继续独立参与解析。
- 主动驱动与偏置按各自电阻共同参与解析；相反偏置形成负载，不按优先级忽略。开漏与上拉表达准双向口静态行为；短暂强上拉属于器件时序模型。

### 网络电压与支路电流

- 导线与闭合理想触点合并等电位节点；有限电阻连接节点，但不合并两端。
- 每个节点满足电流守恒；电阻电流为 `I = (Va - Vb) / R`。相反有限驱动按电阻共同决定电压和电流，不构成理想源冲突。
- 未连接任何生效参考源的被动分量保持物理浮空；采样回退不反向参与物理解算，也不作为泄漏电阻。
- 电阻与触点电流正方向为第一端至第二端；电压源、主动引脚及内部偏置贡献以向网络流出为正。
- 无源被动分量的公共电势虽浮空，有限电阻电流仍唯一为零；断开的支路电流为零。
- 理想触点电流仅在可唯一确定时返回数值；理想环路与两侧冗余理想源造成的自由电流标记为 `indeterminate`。物理未定值不包含伪造数值。
- 同一等电位节点上的生效理想源要求电压相同；不同电压触发 `electrical/source-conflict`，相同电压允许并存，但不可唯一分配的源电流标记为未定。
- 电压、电流与物理状态作为完整快照发布；参数非法、源冲突或数值失败时暂停，保留上一份完整发布快照，复位恢复初值。
- `maxAbsCurrent` 只用于过流诊断，不钳位电流。超过绝对值上限产生资源级活动诊断，连续超限保留一项，成功解析后恢复至上限以内即解除；过流继续执行。

### 浮空输入

浮空数字输入默认返回低电平 `0`；物理网络保持浮空。

浮空模拟输入在所属模拟电源域 `[0, VDD]` 内生成固定初始电压 `V0`，再叠加随虚拟时间变化的 `[-0.1, +0.1)` V 扰动并限幅到当前供电范围。算法版本标识 `mica-floating-v2`。

1. 每实例引脚维护 u32 浮空次数，初值 0；进入新的物理浮空阶段时先 +1。门控切换沿用当前阶段，门控期间的物理浮空转换继续计数；确定驱动恢复后再次浮空建立新阶段。
2. `JSON.stringify(["mica-floating-v2", seed, instanceId, pinName, floatingCount])` 按 UTF-8 编码；`seed` 为仿真级 u32，缺省为 0；`instanceId` 为稳定器件实例标识。
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

### 输入解释与供电

本模型只提供实际网络电压、物理状态与浮空回退值。数字输入的二态／三态选择、比例门限与逻辑记忆属于 [#13](https://github.com/x-botlab/mica-js/issues/13)，实际电压独立保存。物理解析以实体引脚身份为单位：同一实体出现在多个静态组时仍是同一份物理状态。

## 校验

- 非有限电压、非正电阻或非法资源参数报告 `electrical/invalid-parameter`，校验失败的补丁整体不提交。
- 理想源约束冲突报告 `electrical/source-conflict`；无法形成有限、有效解报告 `electrical/numerical-failure`。
- 超过 `maxAbsCurrent` 报告 `electrical/overcurrent`，诊断携带资源身份、带方向电流与绝对值上限。
- 过流诊断采用最近成功快照；求解故障不发布部分电气结果，故障状态保持至复位。

## 示例

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
| 5 V 经 3300 Ω / 1100 Ω 分压 | 中点 1.25 V，电流由真实负载决定                            |
| 相反有限驱动或上下拉        | 各支路共同参与电流守恒，不按强弱优先级覆盖                 |
| 同节点异压理想源            | 暂停并保留上一份完整电气快照                               |
| 闭合理想触点形成环路        | 环路支路电流未定，节点电压仍可确定                         |
| 支路过流后恢复              | 活动诊断仅一项，恢复后解除，执行继续                       |

## 范围

- 属性与 JSON/JS 配对由 [RFC 0005](./0005-device-definition.md) 规定。
- IR I/O 与原子提交由 [RFC 0004](./0004-ir-pin-io.md)、[RFC 0008](./0008-device-topology.md) 规定。
- 引脚能力与电气参考由 [RFC 0006](./0006-device-pins.md) 规定。
- 电源域生命周期与数字门限解释由 [RFC 0007](./0007-device-power-domains.md) 规定。
