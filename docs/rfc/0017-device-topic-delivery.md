# 器件话题投递

- Start Date: 2026-10-25
- Reference Issues: —（设计讨论，无对应 issue）
- Implementation PR: —（尚未实现）

规定器件话题在运行期的投递：固定模拟步、生效边界、队列、背压与载荷语义。器件之间的通信由电气仿真承担（引脚、网络与解网），不在本文范围。

## 声明

### 投递语义

在[话题端口](./0010-topic-ports.md)的端口描述上增加一个可选字段：

| 字段       | 类型   | 约束                                               |
| ---------- | ------ | -------------------------------------------------- |
| `delivery` | string | 可选，`level` 或 `message`；省略时按下方默认表取值 |

本字段不改变 `0010` 的必填字段、载荷类型清单与校验规则。

| 载荷类型                                              | 默认 `delivery` |
| ----------------------------------------------------- | --------------- |
| `boolean`、`number`、`vec2d`、`vec3d`                 | `level`         |
| `string`、`bytes`、`bytes<rgb565>`、`bytes<segments>` | `message`       |

`level` 表示载荷是「当前值」，`message` 表示载荷是「一条消息」。两者与载荷类型正交：`bytes<rgb565>` 帧可以声明为 `level`（只显示最新一帧），`boolean` 按键可以声明为 `message`（每次按下都要送达）。

### 固定模拟步

宿主以固定步长 `dt` 推进仿真，`dt` 为整数皮秒，口径见[虚拟时间](./0001-virtual-time.md)。一个步覆盖该时长内的全部电路 tick。

步长由宿主决定，在同一实例存续期内固定；同一宿主内所有器件使用相同步长。

### 器件钩子

器件工厂返回的对象可以包含两个运行期钩子：

| 钩子               | 时机                 | 权限                             |
| ------------------ | -------------------- | -------------------------------- |
| `applyInputs(io)`  | 步首，任何 tick 之前 | 读取本步投递的输入；写入 IR 内存 |
| `flushOutputs(io)` | 步末，全部 tick 之后 | 读取 IR 内存；向宿主发布         |

两个钩子都可选；省略即该方向不参与通信。钩子在器件实例的作用域内运行。

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

| 方法                      | 语义                                                 |
| ------------------------- | ---------------------------------------------------- |
| `takeInput(port)`         | 取该端口本步投递的最后一条；无投递时返回 `undefined` |
| `takeInputs(port)`        | 取该端口本步投递的全部记录，按发布顺序               |
| `writeState(name, value)` | 写入 IR 标量状态                                     |
| `writeFifo(name, bytes)`  | 追加一条记录；容量不足返回 `false`                   |
| `report(code, detail?)`   | 上报业务诊断，不改变仿真状态                         |

`flushOutputs` 的 `io`：

| 方法                        | 语义                         |
| --------------------------- | ---------------------------- |
| `readState(name)`           | 读取 IR 标量状态             |
| `readBytes(name)`           | 读取 IR 字节内存的快照       |
| `readFifo(name)`            | 取走该 FIFO 的全部已提交记录 |
| `publish(port, payload)`    | 发布标量载荷                 |
| `publishBytes(port, bytes)` | 发布字节载荷                 |

`flushOutputs` 的 `io` 不得写入；`applyInputs` 的 `io` 不得发布。

## 运行时

### 步内顺序

```text
投递冻结 → applyInputs → 执行全部 tick → flushOutputs
```

1. 步开始时冻结本步待投递消息，按目标端点交给对应器件；
2. 依次执行每个器件的 `applyInputs`，其写入对该步后续 tick 立即可见；
3. 执行该步覆盖的全部电路 tick；
4. 依次执行每个器件的 `flushOutputs`，其发布进入后续步的投递集合。

### 生效边界

- 本步 `flushOutputs` 发布的消息最早在下一步被任何 `applyInputs` 看到；跨实例传播因此具有恰好一个固定步长的延迟。
- 同一端口在一个步内收到多条投递时的处理由 `delivery` 决定，见下节。
- 同一虚拟时刻的多次投递沿发布顺序处理。

### 载荷语义

`level` 端口：

- 同一步内收到多条投递时只保留最后一条；调用 `takeInput` 返回该条。
- 未收到投递时保持上一次生效值。
- 无投递与投递 `0`、`false`、空字符串、空字节序列具有各自独立的语义。

`message` 端口：

- 全部投递按发布顺序逐条交付，不合并、不丢弃；调用 `takeInputs` 返回全部记录。
- 队列容量不足时拒绝本次接纳并上报背压，不覆盖未消费记录、不无限排队。

出向 `level` 端口由器件在 `flushOutputs` 内自行判断是否发布，宿主不做变化检测。

### 时间

投递信封中的 `simTime` 由宿主填充，发布方不提供：

- `flushOutputs` 的发布使用该步结束时的仿真时间；
- `applyInputs` 收到的信封保留其发布时刻。

### 禁止事项

- 任一钩子内不得推进仿真时间，也不得请求执行其他器件的入口；
- `flushOutputs` 不得写入 IR 状态、字节内存或 FIFO；
- `applyInputs` 不得发布话题；
- 钩子抛出的异常必须被隔离并上报诊断，不得中断该步。

IR 与宿主之间的接触面只有上述两个钩子；执行电路 tick 期间不得回调宿主。

## 校验

| 对象       | 规则                                                                                  |
| ---------- | ------------------------------------------------------------------------------------- |
| `delivery` | 取 `level` 或 `message`；其他值返回 `schema/invalid-value`                            |
| 端口声明   | `delivery` 与 `type` 独立校验，不做组合限制                                           |
| 内存声明   | `state` / `bytes` / `fifo` 的名称在同一器件内唯一，容量为正整数                       |
| FIFO 容量  | `maxRecord × length` 必须能容纳所绑定端口载荷的最大编码长度                           |
| 名称引用   | `io` 方法引用的内存名称必须已声明；未声明时上报诊断                                   |
| 端口引用   | `publish` / `takeInput` / `takeInputs` 的端口必须已声明且方向匹配                     |
| 取法一致   | 同一端口不得同时使用 `takeInput` 与 `takeInputs`；违反时上报诊断                      |
| 实现覆盖   | 声明了 output 端口但从未发布、声明了 input 端口但从未读取，必须上报一次诊断后继续运行 |

静态部分在装载期完成；钩子内部调用只能在运行期检查，违规按诊断处理，不改变仿真状态。

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

IR 侧在整帧接收完成时原子提交 `gddram` 并递增 `rev`，因此步末读到的是完整帧；写入跨多个 tick 累积的器件必须这样做。

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

`string` 默认取 `message`，因此每步的多次发布都会送达，不被合并。

## 范围

- 本文不定义器件之间的通信：片间 UART、I²C、SPI、1-Wire 与 GPIO 连线由电气仿真承担。
- 本文不定义载荷的字节布局：`string` 的 UTF-8 编码、`bytes<rgb565>` 的像素头由[话题端口](./0010-topic-ports.md)规定。
- 本文不定义 Widget 侧的订阅与发布接口，见 [Widget JS API](./0015-widget-js-api.md)。
- 本文不定义宿主如何调度渲染帧；`dt` 与渲染帧率相互独立。

## 关联

- [RFC 0001](./0001-virtual-time.md)：`dt` 与 `simTime` 的单位与范围。
- [RFC 0003](./0003-device-ir.md)：IR 内存、入口与生命周期；本文的宿主通知由步边界采样表达，不使用 IR 指令。
- [RFC 0004](./0004-ir-pin-io.md)：电气通道的引脚读写，与本文的话题通道并列。
- [RFC 0009](./0009-device-properties.md)：属性是创建期只读快照，不参与投递。
- [RFC 0010](./0010-topic-ports.md)：端口描述与载荷类型；本文补充 `delivery` 字段。
- [RFC 0015](./0015-widget-js-api.md)：Widget 的 `publish` / `subscribe`；其投递时机、队列与背压由本文统一。
