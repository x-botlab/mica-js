---
format: mica-case/v1
id: atomic-pin-low-boundary
kind: simulation
---

# 固定电位阈值low-boundary

## 规范来源

[docs/spec/electrical.rst](../../../../docs/spec/electrical.rst)

<!-- prettier-ignore -->
> 显式配置时按已发布电压比较：电压小于或等于 low 为 ``Logic.low``，大于或等于 high 为 ``Logic.high``，两者之间为 ``Logic.unknown``。

## 验收义务

前提：引脚 `signal` 的阈值为 `low` 0.8、`high` 2.0，直接接入固定 0.8 V 网络。

操作：通过真实 adapter 编译模型并推进到 0；模型在采样电平为 `Logic.low` 时输出 1，否则输出 0。

预期：恰好等于 `low` 的 0.8 V 被解释为 `Logic.low`，唯一输出为 1。

## 模型

<!-- prettier-ignore -->
```ddl
device Probe {
  output channel out: number(capacity: 8);
  pin signal(low: 0.8, high: 2.0);
  process start { if signal.sample.level == Logic.low { out.send(1); } else { out.send(0); } }
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
      "voltage": 0.8,
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
