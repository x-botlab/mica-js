---
format: mica-case/v1
id: atomic-pin-sample-local-snapshot
kind: simulation
---

# 跨边界局部采样保留原电压

## 规范来源

[docs/spec/electrical.rst](../../../../docs/spec/electrical.rst)

<!-- prettier-ignore -->
> 保存的采样在后续求解后仍保留原内容。

## 验收义务

前提：引脚 `signal` 的初始意图是上拉到 3.3 V；启动过程先把当前采样保存到局部变量，再把意图替换为接到 0 V，并等待 0 ps。

操作：通过真实 adapter 编译模型并推进到 0；模型依次输出保存采样的电压和新采样的电压。

预期：保存的电压在 1e-9 V 绝对容差内仍为 3.3 V，新采样在同样容差内为 0 V。

## 模型

<!-- prettier-ignore -->
```ddl
device Probe {
  output channel out: number(capacity: 8);
  pin signal(low: 0.8, high: 2.0) = [resistor(to: supply, resistance: 1000)]; pin supply; pin reference;
  process start { let saved = signal.sample; signal.intent <- [resistor(to: reference, resistance: 1000)]; await ticks(0); let old = saved.voltage; if old != none { out.send(old); } let current = signal.sample.voltage; if current != none { out.send(current); } }
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
assert.equal(values(batches).length, 2);
assert.ok(Math.abs(values(batches)[0] - 3.3) <= 1e-9);
assert.ok(Math.abs(values(batches)[1]) <= 1e-9);
```
