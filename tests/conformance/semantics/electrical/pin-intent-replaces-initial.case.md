---
kind: simulation
---

# 运行意图完整替换初始支路

## 规范来源

[docs/spec/electrical.rst](../../../../docs/spec/electrical.rst)

<!-- prettier-ignore -->
> 每个引脚只有一份当前意图。赋值 MUST 完整替换原有意图；``[]`` 仅移除该引脚贡献的支路。

## 验收义务

前提：引脚 `signal` 的初始意图是经 1000 Ω 电阻上拉到 3.3 V；启动过程用同阻值电阻把意图完整替换为接到 0 V，并等待 0 ps。

操作：通过真实 adapter 编译模型并推进到 0；模型把新采样电压转发到输出通道。

预期：唯一输出在 1e-9 V 绝对容差内为 0 V，不残留初始上拉与接地支路同时参与的分压。

## 模型

<!-- prettier-ignore -->
```ddl
device Probe {
  output channel out: number(capacity: 8);
  pin signal(low: 0.8, high: 2.0) = [resistor(to: supply, resistance: 1000)];
  pin supply;
  pin reference;
  process start {
    signal.intent <- [resistor(to: reference, resistance: 1000)];
    await ticks(0);
    let v = signal.sample.voltage;
    if v != none {
      out.send(v);
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
      "id": "ground",
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
const { device, values } = await importModule('../fixture.mjs');
const { board, batches } = await device(
  adapter,
  await adapter.compileDDL(modelSource),
  {},
  description,
);
t.after(() => board.dispose());
board.runUntil(0);
```

## 断言

```typescript
assert.equal(values(batches).length, 1);
assert.ok(Math.abs(values(batches)[0]) <= 1e-9, 'absolute voltage tolerance 1 nV');
```
