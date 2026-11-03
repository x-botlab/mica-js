---
format: mica-case/v1
id: atomic-pin-clear-initial
kind: simulation
---

# 空意图移除初始贡献

## 规范来源

[docs/spec/electrical.rst](../../../../docs/spec/electrical.rst)

<!-- prettier-ignore -->
> 每个引脚只有一份当前意图。赋值 MUST 完整替换原有意图；``[]`` 仅移除该引脚贡献的支路。

## 验收义务

前提：引脚 `signal` 的初始意图是经 1000 Ω 电阻上拉到 3.3 V；启动过程把意图赋为 `[]` 并等待 0 ps。

操作：通过真实 adapter 编译模型并推进到 0；模型在采样状态为 `SampleStatus.floating` 时输出 1，否则输出 0。

预期：新发布的采样为浮空，唯一输出为 1；初始上拉支路不再贡献。

## 模型

<!-- prettier-ignore -->
```ddl
device Probe {
  output channel out: number(capacity: 8);
  pin signal(low: 0.8, high: 2.0) = [resistor(to: supply, resistance: 1000)]; pin supply; pin reference;
  process start { signal.intent <- []; await ticks(0); if signal.sample.status == SampleStatus.floating { out.send(1); } else { out.send(0); } }
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
assert.deepEqual(values(batches), [1]);
```
