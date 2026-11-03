---
kind: simulation
---

# 同一网络按各自阈值解释电平

## 规范来源

[docs/spec/electrical.rst](../../../../docs/spec/electrical.rst)

<!-- prettier-ignore -->
> 同一网络的电压由共同求解得到；各引脚使用自己的阈值解释逻辑电平。一个引脚读取采样时，读取的是网络结果，也包括其他引脚支路的影响。

<!-- prettier-ignore -->
> 显式配置时按已发布电压比较：电压小于或等于 low 为 ``Logic.low``，大于或等于 high 为 ``Logic.high``，两者之间为 ``Logic.unknown``。

## 验收义务

前提：三个引脚经装配位于同一个固定 1 V 网络，阈值分别为 0.8/2.0、1.0/2.0 与 0.5/1.0。

操作：通过真实 adapter 编译模型并推进到 0，在同一启动过程中依次读取三个引脚的采样电压与电平。

预期：三个采样电压都是精确的 1 V；阈值比较得到 `unknown`、恰等于 low 的 `low` 与恰等于 high 的 `high`，同网电压不使逻辑结果趋同。

## 模型

<!-- prettier-ignore -->
```ddl
device Probe {
  output channel out: number(capacity: 8);
  pin strict(low: 0.8, high: 2.0);
  pin atLow(low: 1.0, high: 2.0);
  pin atHigh(low: 0.5, high: 1.0);
  process start {
    const a = strict.sample;
    const b = atLow.sample;
    const c = atHigh.sample;
    if a.voltage != none && b.voltage != none && c.voltage != none {
      out.send(a.voltage);
      out.send(b.voltage);
      out.send(c.voltage);
    } else {
      out.send(-1);
    }
    if a.level == Logic.unknown {
      out.send(0);
    } else {
      out.send(9);
    }
    if b.level == Logic.low {
      out.send(1);
    } else {
      out.send(9);
    }
    if c.level == Logic.high {
      out.send(2);
    } else {
      out.send(9);
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
      "id": "shared",
      "voltage": 1,
      "pins": [
        {
          "instance": "probe",
          "pin": "strict"
        },
        {
          "instance": "probe",
          "pin": "atLow"
        },
        {
          "instance": "probe",
          "pin": "atHigh"
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
t.after(board.dispose.bind(board));

board.runUntil(0);
```

## 断言

```typescript
assert.deepEqual(values(batches), [1, 1, 1, 0, 1, 2]);
assert.equal(board.status, 'ready');
```
