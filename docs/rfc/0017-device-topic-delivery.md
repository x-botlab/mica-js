# 器件话题投递

- Start Date: 2026-10-25
- Reference Issues: —（设计讨论，无对应 issue）
- Implementation PR: [#226](https://github.com/x-botlab/mica-js/pull/226)（部分实现；增加步首入口调用以直接更新电气资源）

规定器件话题在运行期的投递：步长与生效边界、队列、背压与载荷语义。器件之间的通信由电气仿真承担（引脚、网络与解网），见 [RFC 0004](./0004-ir-pin-io.md)。

## 声明

### 投递语义

在[话题端口](./0010-topic-ports.md)的端口描述上增加一个可选字段：

| 字段       | 类型   | 约束                                               |
| ---------- | ------ | -------------------------------------------------- |
| `delivery` | string | 可选，`level` 或 `message`；省略时按下方默认表取值 |

`0010` 的必填字段、载荷类型清单与校验规则原样适用，本文只在端口描述上追加这一个可选字段。

| 载荷类型                                              | 默认 `delivery` |
| ----------------------------------------------------- | --------------- |
| `boolean`、`number`、`vec2d`、`vec3d`                 | `level`         |
| `string`、`bytes`、`bytes<rgb565>`、`bytes<segments>` | `message`       |

`level` 表示载荷是「当前值」，`message` 表示载荷是「一条消息」。两者与载荷类型正交：`bytes<rgb565>` 帧可以声明为 `level`（只显示最新一帧），`boolean` 按键可以声明为 `message`（每次按下都要送达）。

### 步长

一次 `DeviceSimulationHost.tick(dt)` 推进一个步，步长由该次调用的 `dt` 给定，为整数皮秒，口径见[虚拟时间](./0001-virtual-time.md)。相邻两次调用的 `dt` 可以不同。

术语按层划分：

| 词       | 含义                                                                                                                 |
| -------- | -------------------------------------------------------------------------------------------------------------------- |
| 步       | 一次 `tick(dt)` 覆盖的一格，长度等于该次调用的 `dt`；推进入口见[画布运行时](./0018-canvas-runtime.md)                |
| 求值轮次 | 仿真器在一格内反复执行的一轮「驱动输出 → 解网 → 负载读取」。轮次数与 `dt` 的换算比率由实现决定，二者之间没有约定比例 |

一个步覆盖若干求值轮次，全部轮次跑完后才执行 `flushOutputs`。轮次在步内的调度属于[器件 IR](./0003-device-ir.md)。

`dt` 由调用方逐次给出，同一步内所有器件共用这一个 `dt`。

### 器件钩子

器件工厂返回的对象可以包含两个运行期钩子：

| 钩子               | 时机         | 权限                                         |
| ------------------ | ------------ | -------------------------------------------- |
| `applyInputs(io)`  | 步首，求值前 | 读取本步投递的输入；写入 IR 内存             |
| `flushOutputs(io)` | 步末，求值后 | 读取 IR 内存；向 `DeviceSimulationHost` 发布 |

两个钩子均为可选，按方向实现：只需接收的器件实现 `applyInputs`，只需发送的实现 `flushOutputs`，完全自洽的器件两个都可以省略。钩子在器件实例的作用域内运行。

### IR 内存声明

钩子读写的内存必须在工厂期声明，声明后容量固定：

```js
api.ir.state(name, type, initial);
api.ir.bytes(name, length);
api.ir.fifo(name, { maxRecord, length });
```

`fifo` 是变长记录队列：`maxRecord` 为单条记录的最大字节数，`length` 为记录条数容量。记录按字节序列存储，标量载荷按[话题端口](./0010-topic-ports.md)的编码写入。

### io 接口

`applyInputs` 的 `io`：

| 方法                      | 语义                                                                                   |
| ------------------------- | -------------------------------------------------------------------------------------- |
| `takeInput(port)`         | 取该端口本步投递的最后一条；本步该端口收到投递时返回该条，其余情况返回 `undefined`     |
| `takeInputs(port)`        | 取该端口本步投递的全部记录，按发布顺序                                                 |
| `writeState(name, value)` | 写入 IR 标量状态                                                                       |
| `call(entry, args)`       | 在本次步首处理内同步执行已声明的 IR 入口，使用本实例的当前虚拟时间；参数按入口签名校验 |
| `writeFifo(name, bytes)`  | 追加一条记录；队列达到容量上限时返回 `false`                                           |
| `report(code, detail?)`   | 上报业务诊断，仿真状态保持原样                                                         |

`flushOutputs` 的 `io`：

| 方法                        | 语义                         |
| --------------------------- | ---------------------------- |
| `readState(name)`           | 读取 IR 标量状态             |
| `readBytes(name)`           | 读取 IR 字节内存的快照       |
| `readFifo(name)`            | 取走该 FIFO 的全部已提交记录 |
| `publish(port, payload)`    | 发布标量载荷                 |
| `publishBytes(port, bytes)` | 发布字节载荷                 |

入口调用的签名为：

```ts
interface DeviceInputIo {
  call(entry: EntryRef, args: readonly RuntimeScalar[]): void;
}
```

`entry` 必须是本器件声明的普通入口。`io` 仅在当前钩子调用期间有效，钩子返回或抛出后关闭；后续访问按运行期违规处理。

两个 `io` 按方向分工：`applyInputs` 的 `io` 承担入向（读投递、写内存、调用入口），`flushOutputs` 的 `io` 承担出向（读内存、读 FIFO、发布），表中的方法即全部可用方法。

## 运行时

### 步内顺序

一步由 `WidgetHost` 驱动：它调用 `DeviceSimulationHost.tick(dt)` 完成器件侧，返回后在同一个步里执行 widget 的 `tick`。两者都结束才进入下一步，这就是步进屏障。

1. `WidgetHost` 在步首把上一步收集到的器件发布与外部输入交给 widget 实例；
2. `DeviceSimulationHost.tick(dt)` 冻结本步待投递集合：上一步的 widget 发布进入对应器件的收件箱；
3. 各器件执行 `applyInputs(io)`，其写入对该步后续求值轮次立即可见；
4. 执行本步的全部求值轮次，各轮次内器件的调度由实现安排；
5. 各器件执行 `flushOutputs(io)`，发布经 `onDidPublish` 交给 `WidgetHost`，进入下一步的投递集合；
6. `DeviceSimulationHost.tick(dt)` 返回后，`WidgetHost` 执行 widget 的 `tick(dt)`；widget 的发布经 `WidgetHost.deliver` 交给 `DeviceSimulationHost`，进入下一步的投递集合；
7. 两侧都完成，屏障放行。

第 2–5 步在 `DeviceSimulationHost.tick(dt)` 内完成，第 1、6 步由 `WidgetHost` 完成。本步产生的发布都要等屏障放行才被对方看到，因此收发时机与谁先跑完无关。

完整时序见[画布运行时](./0018-canvas-runtime.md)。

### 生效边界

- 本步产生的发布最早在下一步被看到：器件 `flushOutputs` 与 widget `tick` 中的发布都进下一步的投递集合。
- 四条路径的延迟相同，都是恰好一步：器件→器件、器件→widget、widget→器件、widget→widget。
- 同一端口在一个步内收到多条投递时的处理由 `delivery` 决定，见下节。
- 同一虚拟时刻的多次投递沿发布顺序处理。

### 载荷语义

`level` 端口：

- 同一步内收到多条投递时最后一条生效；调用 `takeInput` 返回该条。
- 生效值跨越多个步持续存在：本步该端口收到投递时更新，静默的步里沿用上一次的值。
- 「本步收到投递」这一事实与载荷取值相互独立：投递 `0`、`false`、空字符串、空字节序列都是有效投递。

`message` 端口：

- 全部投递按发布顺序逐条交付，一条记录对应一次投递；调用 `takeInputs` 返回全部记录。
- 队列深度受容量约束：队列达到容量上限时拒绝本次接纳并上报背压，已接纳的记录保持原样。

出向 `level` 端口由器件在 `flushOutputs` 内自行判断何时发布；`DeviceSimulationHost` 把每次 `publish` 都当作新值转发。

### 时间

投递信封中的 `simTime` 由 `DeviceSimulationHost` 填充：

- `flushOutputs` 的发布使用该步结束时的仿真时间；
- `applyInputs` 收到的信封保留其发布时刻。

### 钩子的执行条件

- 钩子运行在器件实例的作用域内，操作对象是本器件声明的内存与本步投递；
- 仿真时间由 `DeviceSimulationHost` 在步边界推进，钩子内的时间读取是只读快照；
- 钩子抛出的异常由 `DeviceSimulationHost` 隔离并以诊断上报，该步继续执行。

IR 与 `DeviceSimulationHost` 之间的接触面就是上述两个钩子：执行求值轮次期间，运行时做的是驱动、解网与负载读取。

## 校验

| 对象       | 规则                                                                                |
| ---------- | ----------------------------------------------------------------------------------- |
| `delivery` | 取 `level` 或 `message`；其他值返回 `schema/invalid-value`                          |
| 端口声明   | `delivery` 与 `type` 独立校验，任意组合都成立                                       |
| 内存声明   | `state` / `bytes` / `fifo` 的名称在同一器件内唯一，容量为正整数                     |
| FIFO 容量  | `maxRecord × length` 必须能容纳所绑定端口载荷的最大编码长度                         |
| 名称引用   | `io` 方法引用的内存名称必须在工厂期声明，声明表里查不到时上报诊断                   |
| 端口引用   | `publish` / `takeInput` / `takeInputs` 的端口必须已声明且方向匹配                   |
| 取法一致   | 同一端口的 `takeInput` 与 `takeInputs` 二选一；混用时上报诊断                       |
| 实现覆盖   | 声明了 output 端口却零次发布、声明了 input 端口却零次读取时，上报一次诊断后继续运行 |

静态部分在装载期完成；钩子内部的调用在运行期检查，违规按诊断处理，仿真状态保持原样。

## 示例

### 电平端口：舵机

```json
{
  "ports": {
    "position": { "direction": "output", "type": "number", "title": "关节角度" },
    "target": { "direction": "input", "type": "number", "title": "目标角度" }
  }
}
```

两个端口省略 `delivery`，按默认表取 `level`。

```js
export default function createServo(api) {
  api.ir.state('angle', 'f32', 90);
  api.ir.state('targetDeg', 'f32', 90);

  let published = -1;

  return {
    initialize: api.ir.lifecycle('initialize', []),
    tick: api.ir.lifecycle('tick', []),

    applyInputs(io) {
      const target = io.takeInput('target');
      if (target !== undefined) io.writeState('targetDeg', clamp(target, 0, 180));
    },

    flushOutputs(io) {
      const angle = io.readState('angle');
      if (angle === published) return;
      published = angle;
      io.publish('position', angle);
    },
  };
}
```

### 字节端口：OLED

```json
{
  "ports": {
    "frame": {
      "direction": "output",
      "type": "bytes<rgb565>",
      "delivery": "level",
      "title": "像素帧"
    }
  }
}
```

`bytes<rgb565>` 的默认值是 `message`，只显示最新一帧的场景必须显式声明 `level`。

```js
export default function createSsd1306(api) {
  api.ir.bytes('gddram', 1024);
  api.ir.bytes('gddramNext', 1024);
  api.ir.state('rev', 'u32', 0);

  let lastRev = -1;

  return {
    initialize: api.ir.lifecycle('initialize', []),
    tick: api.ir.lifecycle('tick', []),

    flushOutputs(io) {
      const rev = io.readState('rev');
      if (rev === lastRev) return;
      lastRev = rev;
      io.publishBytes('frame', toRgb565(io.readBytes('gddram'), 128, 64));
    },
  };
}
```

IR 侧在整帧接收完成时原子提交 `gddram` 并递增 `rev`，因此步末读到的是完整帧；写入跨多轮求值累积的器件必须这样做。

### 消息端口：串口调试口

```json
{
  "ports": {
    "tx": { "direction": "output", "type": "string", "title": "发送" },
    "rx": { "direction": "input", "type": "string", "title": "接收" }
  }
}
```

```js
export default function createUsart(api) {
  api.ir.fifo('tx', { maxRecord: 1, length: 256 });
  api.ir.fifo('rx', { maxRecord: 32, length: 16 });

  return {
    initialize: api.ir.lifecycle('initialize', []),
    tick: api.ir.lifecycle('tick', []),

    applyInputs(io) {
      for (const text of io.takeInputs('rx')) {
        if (!io.writeFifo('rx', encodeUtf8(text))) io.report('usart/overrun');
      }
    },

    flushOutputs(io) {
      const records = io.readFifo('tx');
      if (records.length === 0) return;
      io.publish('tx', decodeUtf8(concat(records)));
    },
  };
}
```

`string` 默认取 `message`，因此每步的多次发布各自送达。

## 范围

本文规定话题通道的投递语义，相关内容的归属如下：

- 器件之间的通信（片间 UART、I²C、SPI、1-Wire 与 GPIO 连线）由电气仿真承担，见 [RFC 0004](./0004-ir-pin-io.md)。
- 载荷的字节布局（`string` 的 UTF-8 编码、`bytes<rgb565>` 的像素头）由[话题端口](./0010-topic-ports.md)规定。
- Widget 侧的订阅与发布接口见 [Widget JS API](./0015-widget-js-api.md)。
- 渲染帧的调度、`WidgetHost` 装配、线程划分与资源寻址见[画布运行时](./0018-canvas-runtime.md)；`dt` 与渲染帧率相互独立。
- 沙箱的能力限制与位图回传由沙箱自身的合同维护。

## 关联

- [RFC 0001](./0001-virtual-time.md)：`dt` 与 `simTime` 的单位与范围。
- [RFC 0003](./0003-device-ir.md)：IR 内存、入口与生命周期；本文的器件通知由步边界采样表达。
- [RFC 0004](./0004-ir-pin-io.md)：电气通道的引脚读写，与本文的话题通道并列。
- [RFC 0009](./0009-device-properties.md)：属性是创建期只读快照，投递承载的是端口载荷。
- [RFC 0010](./0010-topic-ports.md)：端口描述与载荷类型；本文补充 `delivery` 字段。
- [RFC 0013](./0013-canvas-format.md)：`.cnv` 的实例、绑定与 `schematic` 引用。
- [RFC 0014](./0014-widget-definition.md)：widget 的端口声明。
- [RFC 0015](./0015-widget-js-api.md)：Widget 的 `publish` / `subscribe`；其投递时机、队列与背压由本文统一。
- [RFC 0018](./0018-canvas-runtime.md)：`WidgetHost` 装配、线程划分与资源寻址。
