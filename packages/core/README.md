# @mica/core

当前实现公共电气网络的纯求值与 `mica-floating-v2` 浮空模拟取值。公共合同经 [#49 逐项批准](https://github.com/x-botlab/mica-js/issues/49#issuecomment-6322043409)，依据 [#12 引脚状态](https://github.com/x-botlab/mica-js/issues/12)、[#24 电气模型](https://github.com/x-botlab/mica-js/issues/24) 和 [#23 整数皮秒时间](https://github.com/x-botlab/mica-js/issues/23)。既有 `MICA_CORE_VERSION` 保留。

## 网络求值

`resolveElectricalNetwork(input: ElectricalNetworkInput): ElectricalNetworkResult` 接收拓扑层已经连接到同一网络的完整引脚快照，不读取原理图、创建连接或维护拓扑。断开的引脚由调用方从 `pins` 移除。

```typescript
import { resolveElectricalNetwork, type ElectricalPinInput } from '@mica/core';

const output: ElectricalPinInput = {
  instanceId: 'device-1',
  pinName: 'P0',
  powerReady: true,
  mode: 'open-drain',
  outputEnabled: true,
  pull: 'up',
  digitalIntent: true,
  model: {
    kind: 'ideal-voltage',
    minVoltage: 0,
    maxVoltage: 3.3,
    lowVoltage: 0,
    highVoltage: 3.3,
  },
};

const result = resolveElectricalNetwork({ networkId: 'data', pins: [output] });
// result.state === 'driven', result.voltage === 3.3, result.strength === 'weak'
```

根入口导出 `ElectricalPinInput`、`ElectricalNetworkInput`、`ElectricalContribution`、`ElectricalNetworkResult`、`ElectricalConflictError` 及求值函数。输入状态为：

| 字段                     | 语义                                                       |
| ------------------------ | ---------------------------------------------------------- |
| `networkId`              | 非空原始字符串，仅作为诊断身份                             |
| `pins`                   | 同一网络的实体引脚快照数组，可以为空                       |
| `instanceId` / `pinName` | 非空原始字符串；同网络中的二元身份必须唯一                 |
| `powerReady`             | 调用方提供的供电就绪布尔值；false 释放主动及偏置贡献       |
| `mode`                   | `high-z`、`push-pull`、`open-drain`、`analog`              |
| `outputEnabled`          | 主动输出使能；不影响内部偏置                               |
| `pull`                   | `none`、`up`、`down`；独立于模式、使能及输出意图 readiness |
| `digitalIntent?`         | boolean；缺省表示数字意图未就绪，false/true 对应 0/1       |
| `voltageIntent?`         | number；缺省表示电压意图未就绪，零也是就绪电压             |
| `model`                  | 显式 `ideal-voltage` 模型，包含 min/max/low/high 电压      |

`high-z`、使能关闭或当前模式所需意图未就绪时主动释放。推挽 false/true 取 low/high；开漏 false 取 low，true 释放；analog 取已就绪 voltageIntent。供电就绪时上下拉独立取 high/low。函数不改变配置或意图，也不保存其引用；模式/门控变化后的完整快照由调用方提交。

### 相容性与结果

电压单位为 V，参考公共地。全部强贡献优先于弱偏置；最高优先级电压满足 `max - min <= 0.001` 时相容，取最低值。强贡献存在时相反弱偏置不会造成冲突。只有弱贡献时采用同一规则。边界直接采用 f64 运算，不添加 epsilon，也不舍入；例如 `3.301 - 3.3 > 0.001`，因此这组电压冲突。

- `state: 'driven'`：包含 `voltage`、`strength: 'strong' | 'weak'`、`contributions`。不在此处按 #13 门限生成数字逻辑。
- `state: 'floating'`：包含 `digitalFallback: false` 和空 `contributions`，**没有物理电压**。false 仅代表 #24 规定的浮空数字默认值，不隐藏冲突或未完成的求值。
- `contributions`：每条包含 `instanceId`、`pinName`、`kind: 'drive' | 'pull'`、`strength`、`voltage`，保留所有实际生效贡献，包括被强贡献覆盖的弱偏置。

结果及贡献递归冻结，并与调用方输入分离。贡献按原始 instanceId、pinName 的 UTF-16 字典序排列，同实体 drive 在 pull 前。身份不 trim 或 Unicode normalize；输入数组顺序不影响合法结果或冲突现场。网络之间没有共享可变状态。

### 校验与冲突

完整快照先校验，门控关闭或模式未选中也不能隐藏非法保存意图：

- 模型仅接受 `kind: 'ideal-voltage'`。min/max 必须有限且 min <= max，允许负电压；low/high 必须在此范围内且 low <= high；就绪 voltageIntent 必须有限且在范围内。
- 未知字段/模型（包括电阻、阻抗字段）、枚举或类型错误、非有限数值抛 `TypeError`。显式 undefined 意图不等同于缺省字段。
- 合法数值超范围或范围倒置抛 `RangeError`。校验消息包含字段路径、值和约束。
- 驱动或偏置不相容时当次同步抛 `ElectricalConflictError`，无新增错误码。其 `network` 保存冻结完整输入现场，`contributions` 保存冻结贡献；构造签名为 `(network: ElectricalNetworkInput, contributions: readonly ElectricalContribution[])`。

**冲突不是浮空。** 本模块没有仿真循环，不能自行暂停整个仿真或提交效果。后续 #50 集成必须捕获冲突、暂停整个仿真并保留此前已提交效果；此处不宣称该接线已经完成。

## 浮空模拟取值

`createFloatingInput(seed: number, instanceId: string, pinName: string): FloatingInput` 为一个实体引脚建立独立状态，根入口同时导出 `FloatingInput` 与 `FloatingInputSample`。

```typescript
import { createFloatingInput } from '@mica/core';

const floating = createFloatingInput(12345, 'device-1', 'AIN');
floating.beginFloating(3.3);
const value = floating.sample(3.3, 100);
// { state: 'ready', voltage: ... }，物理网络仍然是 floating。
```

- `beginFloating(supplyVoltage?: number): void`：每次**实际进入新的物理浮空阶段**时调用，u32 阶段计数加一并回绕。供电已知且采样就绪时传入供电，立即初始化 V0；其余情况省略。
- `sample(supplyVoltage: number, timePs: number, enabled?: boolean): FloatingInputSample`：enabled 默认 true。启用时返回 `{ state: 'ready', voltage }`；false 时不校验供电/时间、不初始化/推进状态，返回 `{ state: 'disabled' }`，没有零电压占位。
- seed 为 u32。实例及引脚身份必须是非空原始字符串。供电为有限非负数。timePs 接受 number，严格校验为 [0, 7_200_000_000_000_000] 内的整数皮秒；不导入调度器类型或推进时间。非有限/非整数/类型错误抛 TypeError，越界抛 RangeError。未登记阶段就启用采样抛普通 Error。

严格采用 #24 的 `mica-floating-v2`：JSON + UTF-8 身份编码，FNV-1a 阶段种子（零替换为 1），xorshift32 初始电压，完整整数皮秒的 low/high 位经 mix32 决定 [-0.1, +0.1) V 噪声，最终限幅到当前 [0, VDD]。同阶段的 V0 固定；供电变化仅改变限幅，不重新缩放 V0。重复取值、观察者数量、其他引脚取值及事件执行序号不改变结果。networkId 不参与随机，拓扑合并/拆分不能将网络 ID 代替实体引脚身份。

**接线责任：** 调用方持续跟踪确定/浮空转换，即使采样门控关闭也逐次调用 beginFloating；不能按读取次数重建阶段。未初始化阶段恢复就绪时，必须在恢复的解析点调用 sample 完成 V0 初始化，不能推迟到首次业务读取。此对象不自动检测网络转换，也不产生事件。后续 #50 负责拓扑/供电生命周期接线。

## 支持边界与验证

此实现只支持理想强电压与弱偏置的贡献解析，不支持连续电路求解、电阻、阻抗、负载或积分。不实现拓扑提交、电源生命周期、调度器、IR 领域指令接线、协议解码或 JIT；不依赖 #48 尚未批准/合并的新 API。

在仓库根目录运行：

```powershell
pnpm --filter @mica/core test
pnpm --filter @mica/core typecheck
pnpm --filter @mica/core build
```

Vitest 覆盖公共组合矩阵、释放/门控/readiness、冲突/浮空、f64 电压边界、冻结故障现场、顺序/网络隔离、v2 重放向量、独立 BigInt 算法对照、时间高位、供电限幅、门控阶段与恢复初始化；TypeScript 检查根入口合同。测试直接调用生产求值函数，不用构建或子进程冒充单元测试。
