---
kind: simulation
---

# 两条同端点支路独立参与求解

## 规范来源

[docs/spec/electrical.rst](../../../../docs/spec/electrical.rst)

<!-- prettier-ignore -->
> 每条贡献都是独立电阻；两端引脚各贡献一条电阻时，两条都参与求解，不按端点自动去重。目标与起点经装配处于同网时，合法支路的净节点贡献为零，可以跳过数值计算，参数构造检查仍执行。

<!-- prettier-ignore -->
> 每个引脚只有一份当前意图。赋值 MUST 完整替换原有意图；``[]`` 仅移除该引脚贡献的支路。

## 验收义务

前提：两个引脚都在 3.3 V 供电网，第三个引脚在 0 V 参考网；三者各自通过 10 Ω 贡献到未接参考的 `signal` 网。

操作：通过真实 adapter 编译模型并推进到 0，先读取两路供电支路并联后的采样，再清空其中一个引脚意图并跨边界读取。

预期：并联的供电侧为 5 Ω，采样为 3.3×10/15 = 2.2 V 且为高电平；`[]` 只移除该引脚的支路，采样回到 3.3×10/20 = 1.65 V 且电平未知。

## 模型

<!-- prettier-ignore -->
```ddl
device Probe {
  output channel out: number(capacity: 8);
  pin signal(low: 0.8, high: 2.0);
  pin topA;
  pin topB;
  pin bottom;
  pin supply;
  pin reference;
  process start {
    topA.intent <- [resistor(to: signal, resistance: 10)];
    topB.intent <- [resistor(to: signal, resistance: 10)];
    bottom.intent <- [resistor(to: signal, resistance: 10)];
    await ticks(0);
    const parallel = signal.sample;
    topB.intent <- [];
    await ticks(0);
    const single = signal.sample;
    if parallel.voltage != none {
      out.send(parallel.voltage);
    } else {
      out.send(-1);
    }
    if parallel.level == Logic.high {
      out.send(2);
    } else {
      out.send(9);
    }
    if single.voltage != none {
      out.send(single.voltage);
    } else {
      out.send(-1);
    }
    if single.level == Logic.unknown {
      out.send(0);
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
      "id": "supply",
      "voltage": 3.3,
      "pins": [
        {
          "instance": "probe",
          "pin": "supply"
        },
        {
          "instance": "probe",
          "pin": "topA"
        },
        {
          "instance": "probe",
          "pin": "topB"
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
        },
        {
          "instance": "probe",
          "pin": "bottom"
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
  [0, 0, 0, 0],
);
assert.ok(Math.abs(delivered[0].value - 2.2) <= 1e-9);
assert.equal(delivered[1].value, 2);
assert.ok(Math.abs(delivered[2].value - 1.65) <= 1e-9);
assert.equal(delivered[3].value, 0);
assert.equal(board.status, 'ready');
```
