---
kind: simulation
---

# 两个参考网经电阻相连仍保持电位

## 规范来源

[docs/spec/electrical.rst](../../../../docs/spec/electrical.rst)

<!-- prettier-ignore -->
> 多个不同电位的参考网可以经电阻相连，各自保持固定值。同一网络上的固定电位约束必须一致；矛盾约束在任何工厂调用前拒绝。

<!-- prettier-ignore -->
> 全为固定电位的分量直接取得已知值；固定节点之间的电阻不改变这些电位。求解接纳只检查未知节点电压；sample 未公开的支路电流不参与接纳条件。

## 验收义务

前提：`highSide` 接入固定 3.3 V 网，`lowSide` 接入固定 0 V 网；启动过程在两个引脚之间构造一条 10 Ω 支路。

操作：通过真实 adapter 编译模型并推进到 0，读取两个引脚的采样电压与状态。

预期：两个参考电位都精确保持所配置值，板保持 `ready`；不经数值求解拒绝，也不报告电源短路。

## 模型

<!-- prettier-ignore -->
```ddl
device Probe {
  output channel out: number(capacity: 8);
  pin highSide(low: 0.8, high: 2.0);
  pin lowSide(low: 0.8, high: 2.0);
  process start {
    highSide.intent <- [resistor(to: lowSide, resistance: 10)];
    await ticks(0);
    const high = highSide.sample;
    const low = lowSide.sample;
    if high.voltage != none && low.voltage != none {
      out.send(high.voltage);
      out.send(low.voltage);
    } else {
      out.send(-1);
    }
    if high.status == SampleStatus.valid && low.status == SampleStatus.valid {
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
      "id": "supply",
      "voltage": 3.3,
      "pins": [
        {
          "instance": "probe",
          "pin": "highSide"
        }
      ]
    },
    {
      "id": "reference",
      "voltage": 0,
      "pins": [
        {
          "instance": "probe",
          "pin": "lowSide"
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
assert.deepEqual(values(batches), [3.3, 0, 1]);
assert.equal(board.status, 'ready');
```
