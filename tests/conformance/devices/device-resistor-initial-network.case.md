---
kind: comparison
---

# 初始电阻网络与分压

通过共享器件模型与公开探针，对照各网络或各推进时刻的输出。器件源码保留在对应子目录；本文件保存装配、执行顺序及全部行为断言。

## 规范来源

[docs/spec/electrical.rst](../../../docs/spec/electrical.rst)

## 验收义务

前提：等阻分压及无负载上拉在创建期接入固定电源。

操作：首次推进到1并读取探针。

预期：电压以1e-9V绝对容差分别匹配1.65和3.3；各只有时间0的一条读数。

## 对照输入

```json
{
  "fixture": "resistor",
  "description": {
    "instances": [
      {
        "id": "top",
        "type": "resistor"
      },
      {
        "id": "bottom",
        "type": "resistor"
      },
      {
        "id": "single",
        "type": "resistor"
      },
      {
        "id": "divider",
        "type": "probe-divider"
      },
      {
        "id": "unloaded",
        "type": "probe-unloaded"
      }
    ],
    "nets": [
      {
        "id": "supply",
        "pins": [
          {
            "instance": "top",
            "pin": "b"
          },
          {
            "instance": "single",
            "pin": "b"
          }
        ],
        "voltage": 3.3
      },
      {
        "id": "ground",
        "pins": [
          {
            "instance": "bottom",
            "pin": "b"
          }
        ],
        "voltage": 0
      },
      {
        "id": "divider",
        "pins": [
          {
            "instance": "top",
            "pin": "a"
          },
          {
            "instance": "bottom",
            "pin": "a"
          },
          {
            "instance": "divider",
            "pin": "measured"
          }
        ]
      },
      {
        "id": "unloaded",
        "pins": [
          {
            "instance": "single",
            "pin": "a"
          },
          {
            "instance": "unloaded",
            "pin": "measured"
          }
        ]
      }
    ]
  }
}
```

## 执行步骤

```typescript
const { passive, fixture, assemble, advance, reading } = await importModule('./support.mjs');
const model = await fixture(adapter, inputs.fixture);
const divider = [],
  unloaded = [];
const board = await assemble(
  adapter,
  [{ id: 'resistor', model, create: passive }],
  inputs.description,
  { divider, unloaded },
);
t.after(() => board.dispose());
```

## 断言

```typescript
advance(board, 1);
assert.ok(Math.abs(reading(divider).voltage - 1.65) < 1e-9);
assert.ok(Math.abs(reading(unloaded).voltage - 3.3) < 1e-9);
assert.equal(divider[0].time, 0);
assert.equal(unloaded[0].time, 0);
assert.equal(divider.length, 1, 'initial solve establishes baseline without a change reaction');
assert.equal(unloaded.length, 1);
```
