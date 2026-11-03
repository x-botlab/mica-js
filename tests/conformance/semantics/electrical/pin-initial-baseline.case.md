---
kind: simulation
---

# 初始高电平不产生边沿

## 规范来源

[docs/spec/electrical.rst](../../../../docs/spec/electrical.rst)

<!-- prettier-ignore -->
> 全板初始支路先于任何工厂建立，首次推进才求解并建立观察基线，建立本身不伪造变化事件。初始意图就是该 pin 的当前贡献，之后赋值完整替换它，MUST NOT 作为永久并联支路保留。

## 验收义务

前提：引脚 `signal` 声明初始上拉到 3.3 V；同步边界反应订阅 `signal.sample.level` 的变化并对每次触发输出 9；启动过程在采样电平为 `Logic.high` 时输出 1。

操作：通过真实 adapter 编译模型并首次推进到 0，收集全部输出。

预期：只交付启动过程的 1，没有反应体输出的 9；建立初始高电平基线本身不产生变化事件。

## 模型

<!-- prettier-ignore -->
```ddl
device Probe {
  output channel out: number(capacity: 8);
  pin signal(low: 0.8, high: 2.0) = [resistor(to: supply, resistance: 1000)];
  pin supply;
  pin reference;
  reaction changed on signal.sample.level as (old, current) {
    out.send(9);
  }
  process start {
    if signal.sample.level == Logic.high {
      out.send(1);
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
assert.deepEqual(values(batches), [1]);
```
