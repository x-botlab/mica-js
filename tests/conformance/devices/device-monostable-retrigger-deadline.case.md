---
format: mica-case/v1
id: device-monostable-retrigger-deadline
kind: comparison
---

# 单稳态重触发与期限

通过共享器件模型与公开探针，对照各网络或各推进时刻的输出。器件源码保留在对应子目录；本文件保存装配、执行顺序及全部行为断言。

## 规范来源

[docs/spec/execution/scheduling.rst](../../../docs/spec/execution/scheduling.rst)

## 验收义务

前提：脉宽10ps，2ps触发后8ps重触发。

操作：在原12ps期限及18ps新期限附近推进并读取q。

预期：只在2ps变高、18ps变低，原期限没有低毛刺。

## 对照输入

```json
{
  "fixture": "retriggerable-monostable",
  "description": {
    "instances": [
      {
        "id": "driver",
        "type": "driver"
      },
      {
        "id": "dut",
        "type": "monostable",
        "props": {
          "pulseWidth": 10
        }
      },
      {
        "id": "q",
        "type": "probe-q"
      }
    ],
    "nets": [
      {
        "id": "supply",
        "pins": [
          {
            "instance": "driver",
            "pin": "supply"
          },
          {
            "instance": "dut",
            "pin": "supply"
          }
        ],
        "voltage": 3.3
      },
      {
        "id": "reference",
        "pins": [
          {
            "instance": "driver",
            "pin": "reference"
          },
          {
            "instance": "dut",
            "pin": "reference"
          }
        ],
        "voltage": 0
      },
      {
        "id": "trigger",
        "pins": [
          {
            "instance": "driver",
            "pin": "a"
          },
          {
            "instance": "dut",
            "pin": "trigger"
          }
        ]
      },
      {
        "id": "q",
        "pins": [
          {
            "instance": "dut",
            "pin": "q"
          },
          {
            "instance": "q",
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
const { passive, fixture, assemble, advance, level, driverSource, drive } =
  await importModule('./support.mjs');
const model = await fixture(adapter, inputs.fixture);
const driver = await adapter.compileDDL(
  driverSource(`
        await ticks(2); ${drive('a', true)}
        await ticks(1); ${drive('a', false)}
        await ticks(5); ${drive('a', true)}
        await ticks(1); ${drive('a', false)}
      `),
);
const q = [];
const board = await assemble(
  adapter,
  [
    { id: 'monostable', model, create: passive },
    { id: 'driver', model: driver, create: passive },
  ],
  inputs.description,
  { q },
);
t.after(() => board.dispose());
```

## 断言

```typescript
for (const [time, high] of [
  [1, false],
  [2, true],
  [3, true],
  [8, true],
  [12, true],
  [17, true],
  [18, false],
  [19, false],
]) {
  advance(board, time);
  level(q, high);
}
assert.deepEqual(
  q.filter((message) => message.time > 0).map(({ time, value }) => [time, value.high]),
  [
    [2, true],
    [18, false],
  ],
);
```
