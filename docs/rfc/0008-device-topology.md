# 器件内部可控连接与运行时拓扑切换

- Start Date: 2026-10-16
- Reference Issues: [#14](https://github.com/x-botlab/mica-js/issues/14)
- Implementation PR: [#90](https://github.com/x-botlab/mica-js/pull/90)

器件用静态字段 `connections` 声明内部可控的双向连接，实现方在运行时提交连接状态，宿主据此更新电气拓扑并重新解析网络。适用于按钮、拨动开关、继电器等具有通断触点的器件：触点只表达理想导通或断开，控制来源与切换时序由器件模型定义。

## 静态声明

| 字段路径                              | 类型            | 必填 | 默认值 | 说明                            |
| ------------------------------------- | --------------- | ---- | ------ | ------------------------------- |
| `connections`                         | object          | 可选 | `{}`   | 连接 ID 到内部连接描述的映射    |
| `connections.<connection-id>`         | object          | 必填 | —      | 一个可控触点的描述              |
| `connections.<connection-id>.pins`    | array of string | 必填 | —      | 恰好两个互异的实体引脚 ID       |
| `connections.<connection-id>.initial` | string          | 可选 | `open` | 初始状态，取 `open` 或 `closed` |

连接 ID 在器件内稳定、唯一、长度至少为 1、大小写敏感（如 `contact`、`normally-open`）。引脚引用按大小写精确匹配，数组两个位置采用对称语义。

| 状态     | 含义                                         |
| -------- | -------------------------------------------- |
| `open`   | 两端保持断开，连通性由其余连线与闭合触点决定 |
| `closed` | 两端建立理想双向导通边，归入同一电气网络     |

每条连接作为独立拓扑边维护；多个触点可以共享端点，多条闭合路径可以连接同一组网络。断开一条边后，宿主依据剩余路径重新计算连通分量。端点可以引用 `signal`、`power` 或 `gnd` 引脚，引脚类别与域归属保持各自声明；触点只承担导通关系，电压与驱动状态由网络中的驱动源提供，解析结果与不相容判定由[电气模型](./0002-electrical-model.md)负责。

## 电阻支路声明与初始化

线性电阻支路由 `resistors` 对象声明，键为当前器件内非空、大小写敏感的支路 ID。

| 字段                  | 类型            | 约束                              |
| --------------------- | --------------- | --------------------------------- |
| `resistors`           | object          | 可选，省略为空对象                |
| `resistors.<id>.pins` | array of string | 恰好两个互异、已声明的实体引脚 ID |

端点顺序决定支路电流的正方向，由第一个端点流向第二个端点。电阻连接不合并两端为等电位节点；理想闭合触点仍遵守本文原有连接合同。

JSON 不在支路中保存初始阻值、`adjustable` 或 `initialEnabled`。JS 工厂使用属性或常量初始化数值：

```ts
interface ResistorInitialState {
  readonly resistance: number;
  readonly enabled: boolean;
  readonly maxAbsCurrent?: number;
}

interface DeviceElectricalInitialization {
  initializeResistor(id: string, initial: ResistorInitialState): void;
}
```

- `id` 引用当前实例已声明的电阻支路。
- `resistance` 单位 Ω，要求有限且大于零；零欧连接使用理想触点，断开使用 `enabled: false`。
- `enabled` 显式提供，表示初始支路是否参与求解。
- `maxAbsCurrent` 为可选诊断阈值，单位 A，要求有限且大于零；超限不改变支路电阻、不自动限流。
- 所有已声明电阻在工厂结束前恰好初始化一次。
- 运行期调阻能力不采用 `adjustable` 标志区分，资源修改仍须通过当前实例的静态引用及写授权。
- 工厂初始化保存独立的实例初值；运行期调阻不修改属性快照，重置恢复工厂配置的初值。
- 缺少、重复或未知资源初始化按 [RFC 0005](./0005-device-definition.md) 报告；非法阻值或电流阈值报告 `electrical/invalid-parameter`。

```json
{
  "pins": { "A": { "kind": "signal" }, "B": { "kind": "signal" } },
  "resistors": { "body": { "pins": ["A", "B"] } }
}
```

```js
ctx.electrical.initializeResistor('body', { resistance: 1000, enabled: true });
```

## 运行时状态与更新

宿主为每个「实例 + 连接 ID」保存当前 `open` / `closed` 状态，初值来自 `initial`。

初始化顺序：

1. 创建器件引脚、外部连线与内部连接。
2. 装载全部连接的初始状态，把闭合触点加入拓扑。
3. 计算网络连通分量、电压与全局 GND 连通性。
4. 更新电源域与接口条件，器件完成初始化后开放执行。

器件模型在交互、控制输入或内部事件发生时提交更新；当前连接状态由宿主维护，不提供作者侧查询入口。

### 更新形式

一次更新包含目标实例与「连接 ID → 目标状态」补丁；补丁中未列出的连接保持当前状态：

```json
{ "normally-closed": "open", "normally-open": "closed" }
```

宿主先校验全部条目，再原子应用整批变化。重复提交当前状态视为幂等更新。更新只作用于已声明的内部连接；静态 `pins` 与端点集合在运行期稳定，拓扑变化只通过通断状态表达。同一器件的更新按确定的仿真时间与提交顺序执行；需要共同生效的触点必须放在同一补丁中。

### 生效与传播

宿主在下一可用仿真调度点应用更新，带时序的控制由器件模型在目标时间发起：

1. 校验器件、连接 ID、目标状态与整批更新。
2. 原子更新连接状态，形成新的完整拓扑快照。
3. 重新计算受影响网络的合并与拆分，以及与显式全局 GND 节点的连通性。
4. 按新拓扑解析电压、浮空与驱动不相容。
5. 依据接地与供电结果更新电源域，应用引脚门控与受影响事务处理。
6. 网络与门控结果完成本轮解析后，更新数字输入、模拟输入、协议采样与边沿观察者。

门控引起的驱动释放进入同一仿真时刻的后续解析阶段，输入观察使用该轮传播稳定后的结果；反馈产生的新连接更新排入后续调度阶段，保持确定的因果顺序。多触点原子更新以更新前与整批更新后的拓扑为观察边界，切换过程中的中间状态通过多次更新及其时间间隔表达。

## 与电气及协议模型的协作

- **双向信号传播**：闭合触点连接电气网络，模拟电压、数字驱动、开漏释放与上拉都经由共同网络解析；触点闭合后的电压变化可以产生输入电平跃迁，边沿与协议事件按当前判定模式产生，断开后各网络按剩余驱动与电条件分别求值。
- **接地与电源域**：`ground` 引脚经闭合触点接入全局 GND 网络时，域的 `groundReady` 依据连通结果更新；断开后宿主检查剩余导通路径并重算域状态；域状态变化按[电源域](./0007-device-power-domains.md)合同处理输出释放、输入门控、事务中止与恢复。器件实现可以在供电变化时提交所需触点状态（如继电器失电恢复常闭）。
- **在途通信**：拓扑变化先作用于网络与引脚条件，执行中的协议依据新的电平、有效路由与供电状态处理后续通信。例如断开 SDA 触点后，从设备的应答驱动作用于断开后的局部网络，主设备按自身网络电平判断应答；供电失效时按电源域合同中止受影响事务，超时与恢复行为由具体协议负责。

## IR 接入

```ir
connection.apply [connection.contact], [%pressed]
```

`connection.contact` 是当前实例已声明的静态连接引用，`%pressed` 是 bool SSA 值：`true` 闭合，`false` 断开。它只修改连接状态，不向端点写数字电平或电压。

| 项目         | 合同                                               |
| ------------ | -------------------------------------------------- |
| 静态操作数   | 一项或多项静态连接引用，固定有序、同实例、无重复   |
| 运行期操作数 | 与静态列表逐项对应的 bool 值，数量相同             |
| 返回值       | 无                                                 |
| 效果         | 提交一份完整连接更新补丁，在合法拓扑提交点整体应用 |

两个列表是可读 IR 的操作数组织方式，不是客体数组、动态资源引用或新增核心聚合类型；连接列表与长度在建图／链接时固定，bool 值在执行到该指令时按值捕获。

### 理想按钮

```ir
connection.apply [connection.contact], [%pressed]
```

`%pressed = true` 接通 A/B，`false` 断开。重复设置当前状态幂等；A/B 仍是对称被动触点，按键不提供电压源。

### SPDT 继电器

```ir
%released = bool.not %energized
connection.apply [connection.normallyOpen, connection.normallyClosed],
                 [%energized, %released]
```

`%energized = true` 时 NO 闭合、NC 断开，`false` 时相反。两项作为同一补丁生效，不会因逐项写入暴露只更新一个触点的中间拓扑。

### 校验与提交

链接／校验器必须检查连接存在、资源类别、实例归属、更新权限、引用无重复、列表非空、数量匹配、SSA 类型与合法性；执行时按完整指令捕获目标值，不允许动态构造连接引用。以下写法必须拒绝，而不是只应用首项：

```ir
connection.apply [connection.normallyOpen, connection.normallyClosed], [%energized]
```

校验失败不提交本次补丁，也不部分切换；提交前的其他合法效果仍遵守核心不回滚规则。拓扑提交后若电气解析判定不相容，按[电气模型](./0002-electrical-model.md)报告并停止，这不撤销已经完整应用的补丁。

指令执行表示提交更新，不承诺返回时新拓扑已解析：内核在下一合法调度点整体应用，再处理相应网络、电源就绪、门控与观察传播，因此同一入口中的后续指令不能假定新拓扑已生效。该操作不隐式推进虚拟时间、不同步重入其他器件入口、不调用运行期 JS；可以在同一虚拟时刻按既有调度阶段提交，多份补丁沿用稳定顺序，优化不得丢掉可观察的拓扑变化。机械延时与抖动由器件 IR 另行安排。

### 作者层接口

构建期资源操作生成本文的 IR 语义；它们不引入每 tick 的 JS 服务或不同的事务、可见性、故障规则。

```ts
interface DeviceResistorHandle {
  setResistance(resistance: Value<'f64'>): void;
  setEnabled(enabled: Value<'bool'>): void;
  /** 本次解析后的支路电流，单位 A，正方向为第一端到第二端。 */
  sampleCurrent(): Value<'f64'>;
}
interface DeviceBehaviorApi {
  resistor(name: string): DeviceResistorHandle;
  applyResistors(names: readonly string[], resistances: readonly Value<'f64'>[]): void;
  applyConnections(names: readonly string[], closed: readonly Value<'bool'>[]): void;
}
```

- 名称静态绑定当前实例的电阻或触点；patch 非空、无重复，所有列表等长。
- `setResistance` 与 `applyResistors` 要求有限正阻值；patch 中任一无效值使整个 patch 失败，之前已提交的其他操作不回滚。
- `applyResistors` 原子提交阻值，保留各支路使能状态；`setEnabled` 单独更新支路使能。
- `sampleCurrent` 返回本次解析后第一端到第二端的支路电流，单位 A；断开的电阻支路返回 `0`。
- `applyConnections` 按本文的下一个合法拓扑边界生效规则提交，调用者不得依赖同一入口内立即拓扑可见。

## 器件示例

### 常开按钮

```json
{
  "pins": { "A": { "kind": "signal" }, "B": { "kind": "signal" } },
  "connections": { "contact": { "pins": ["A", "B"], "initial": "open" } }
}
```

| 操作 | 连接状态补丁            |
| ---- | ----------------------- |
| 按下 | `{"contact": "closed"}` |
| 松开 | `{"contact": "open"}`   |

A 接带上拉的数字输入、B 接全局 GND 时，闭合后输入被拉低，断开后由上拉形成高电平；器件可用按时间排列的多次更新模拟抖动。

### 单刀双掷继电器的触点部分

```json
{
  "pins": {
    "COM": { "kind": "signal" },
    "NC": { "kind": "signal" },
    "NO": { "kind": "signal" }
  },
  "connections": {
    "normally-closed": { "pins": ["COM", "NC"], "initial": "closed" },
    "normally-open": { "pins": ["COM", "NO"], "initial": "open" }
  }
}
```

理想吸合时一次原子提交把 `normally-closed` 设为 `open`、`normally-open` 设为 `closed`；释放时相反。需要表达先断后合与切换延迟时：

| 阶段     | 状态更新                                               |
| -------- | ------------------------------------------------------ |
| 开始切换 | `{"normally-closed": "open", "normally-open": "open"}` |
| 延迟结束 | `{"normally-open": "closed"}`                          |

两阶段之间两条触点路径均断开；切换延迟、抖动与线圈响应由器件模型确定。

## 校验

静态校验：

1. `connections` 及其条目为对象，连接 ID 唯一且长度至少为 1。
2. `pins` 为长度恰好 2 的字符串数组，两个引脚 ID 互异且已声明。
3. `initial` 取 `open` 或 `closed`，省略为 `open`。
4. 引脚引用按大小写精确匹配。
5. 连接图允许环路与并行导通路径，网络解析依据实际连通性。

运行时校验：

1. 更新目标属于当前实例，补丁中的连接 ID 均已声明。
2. 各目标状态为 `open` 或 `closed`。
3. 整批校验成功后连接状态与拓扑变化一次生效。
4. 网络拆分与合并以全部剩余连线与闭合触点为依据。
5. 网络、电源域、输入采样与协议观察按确定的调度顺序更新。
