---
kind: simulation
---

# 电阻闭区间端点在运行期接受

## 规范来源

[docs/spec/electrical.rst](../../../../docs/spec/electrical.rst)

<!-- prettier-ignore -->
> 电阻使用 ``number``，单位为欧姆，MUST 为有限值且属于闭区间 ``[0.001, 1_000_000_000]``，即 1 mΩ 至 1 GΩ。实际执行 ``resistor`` 构造操作时检查，超界不截断、不转换为短路或开路；非法构造即使没有赋给引脚也失败。

## 验收义务

前提：引脚 `signal` 没有初始意图，启动过程先构造 0.001 Ω 到 0 V 参考的支路，再构造 1 GΩ 到 3.3 V 供电的支路，两次都在运行期执行。

操作：通过真实 adapter 编译模型并推进到 0，在两次 `ticks(0)` 边界后分别读取采样电压。

预期：两个端点值都被接受而不截断；1 mΩ 支路使采样恰为 0 V，替换后唯一的 1 GΩ 上拉支路使采样恰为 3.3 V，板保持 `ready`。

## 模型

<!-- prettier-ignore -->
```ddl
device Probe {
  output channel out: number(capacity: 8);
  pin signal(low: 0.8, high: 2.0);
  pin supply;
  pin reference;
  process start {
    signal.intent <- [resistor(to: reference, resistance: 0.001)];
    await ticks(0);
    const atFloor = signal.sample;
    signal.intent <- [resistor(to: supply, resistance: 1_000_000_000)];
    await ticks(0);
    const atCeiling = signal.sample;
    if atFloor.voltage != none {
      out.send(atFloor.voltage);
    } else {
      out.send(-1);
    }
    if atCeiling.voltage != none {
      out.send(atCeiling.voltage);
    } else {
      out.send(-1);
    }
  }
}
```

## 装配

```json
{
  "instances": [
    {
      "id": "probe",
      "type": "probe"
    }
  ],
  "nets": [
    {
      "id": "supply",
      "voltage": 3.3,
      "pins": [
        {
          "instance": "probe",
          "pin": "supply"
        }
      ]
    },
    {
      "id": "reference",
      "voltage": 0,
      "pins": [
        {
          "instance": "probe",
          "pin": "reference"
        }
      ]
    }
  ]
}
```

## 执行步骤

```typescript
const { device, messages } = await importModule('../fixture.mjs');
const { board, batches } = await device(
  adapter,
  await adapter.compileDDL(modelSource),
  {},
  description,
);
t.after(board.dispose.bind(board));

board.runUntil(0);
```

## 断言

```typescript
const delivered = messages(batches);
assert.deepEqual(
  delivered.map((message) => message.time),
  [0, 0],
);
assert.ok(Math.abs(delivered[0].value) <= 1e-9);
assert.ok(Math.abs(delivered[1].value - 3.3) <= 1e-9);
assert.equal(board.status, 'ready');
assert.equal(board.time, 0);
```
