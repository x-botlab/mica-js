---
format: mica-case/v1
id: device-d-flip-flop-published-edge-capture
kind: comparison
---

# D 触发器的发布边沿捕获

通过共享器件模型与公开探针，对照各网络或各推进时刻的输出。器件源码保留在对应子目录；本文件保存装配、执行顺序及全部行为断言。

## 规范来源

[docs/spec/execution/scheduling.rst](../../../docs/spec/execution/scheduling.rst)

[docs/spec/electrical.rst](../../../docs/spec/electrical.rst)

## 验收义务

前提：D触发器接到固定供电，驱动顺序包含同刻数据下降和末次clear。

操作：按用例列出的1至14ps时刻推进并读取q探针。

预期：非零时间变化精确为[2,true]、[6,false]、[10,true]、[14,false]；这是集成路径而非每条调度规则的独立证明。

## 对照输入

```json
{
  "fixture": "d-flip-flop",
  "description": {
    "instances": [
      {
        "id": "driver",
        "type": "driver"
      },
      {
        "id": "dut",
        "type": "dff"
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
        "id": "data",
        "pins": [
          {
            "instance": "driver",
            "pin": "a"
          },
          {
            "instance": "dut",
            "pin": "data"
          }
        ]
      },
      {
        "id": "clock",
        "pins": [
          {
            "instance": "driver",
            "pin": "b"
          },
          {
            "instance": "dut",
            "pin": "clock"
          }
        ]
      },
      {
        "id": "clear",
        "pins": [
          {
            "instance": "driver",
            "pin": "c"
          },
          {
            "instance": "dut",
            "pin": "clear"
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
        await ticks(2); ${drive('a', true)} ${drive('b', true)}
        await ticks(0); ${drive('a', false)}
        await ticks(2); ${drive('b', false)}
        await ticks(2); ${drive('b', true)}
        await ticks(2); ${drive('a', true)} ${drive('b', false)}
        await ticks(2); ${drive('b', true)}
        await ticks(2); ${drive('b', false)}
        await ticks(2); ${drive('b', true)} ${drive('c', true)}
      `),
);
const q = [];
const board = await assemble(
  adapter,
  [
    { id: 'dff', model, create: passive },
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
  [4, true],
  [6, false],
  [8, false],
  [10, true],
  [14, false],
]) {
  advance(board, time);
  level(q, high);
}
assert.deepEqual(
  q.filter((message) => message.time > 0).map(({ time, value }) => [time, value.high]),
  [
    [2, true],
    [6, false],
    [10, true],
    [14, false],
  ],
);
```
