---
kind: simulation
---

# 省略阈值时电平未知

## 规范来源

[docs/spec/electrical.rst](../../../../docs/spec/electrical.rst)

<!-- prettier-ignore -->
> 阈值省略时不选用隐含电压制式，该引脚仍提供电压与状态，``level`` 恒为 ``Logic.unknown``。

## 验收义务

前提：引脚 `signal` 同时省略 `low` 与 `high`，直接接入固定 3.3 V 网络。

操作：通过真实 adapter 编译模型并推进到 0；模型在采样电平为 `Logic.unknown` 时输出 1，否则输出 0。

预期：尽管电压为 3.3 V，采样电平仍为 `Logic.unknown`，唯一输出为 1。

## 模型

<!-- prettier-ignore -->
```ddl
device Probe {
  output channel out: number(capacity: 8);
  pin signal;
  process start {
    if signal.sample.level == Logic.unknown {
      out.send(1);
    } else {
      out.send(0);
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
      "id": "reference",
      "voltage": 3.3,
      "pins": [
        {
          "instance": "probe",
          "pin": "signal"
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
assert.deepEqual(values(batches), [1]);
```
