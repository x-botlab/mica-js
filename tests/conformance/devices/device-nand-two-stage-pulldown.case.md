---
kind: comparison
---

# 两级 NAND 的下拉负载

通过共享器件模型与公开探针，对照各网络或各推进时刻的输出。器件源码保留在对应子目录；本文件保存装配、执行顺序及全部行为断言。

## 规范来源

[docs/spec/electrical.rst](../../../docs/spec/electrical.rst)

## 验收义务

前提：两级NAND带下拉负载，首级高、次级低。

操作：推进到1和2ps并读取两个探针。

预期：首级电压匹配3.3×500000/(500000+25)，次级为0，绝对容差1e-9V。

## 对照输入

```json
{
  "fixture": "nand",
  "description": {
    "instances": [
      {
        "id": "first",
        "type": "nand"
      },
      {
        "id": "second",
        "type": "nand"
      },
      {
        "id": "firstProbe",
        "type": "probe-first"
      },
      {
        "id": "secondProbe",
        "type": "probe-second"
      }
    ],
    "nets": [
      {
        "id": "supply",
        "pins": [
          {
            "instance": "first",
            "pin": "supply"
          },
          {
            "instance": "second",
            "pin": "supply"
          }
        ],
        "voltage": 3.3
      },
      {
        "id": "reference",
        "pins": [
          {
            "instance": "first",
            "pin": "reference"
          },
          {
            "instance": "second",
            "pin": "reference"
          }
        ],
        "voltage": 0
      },
      {
        "id": "cascade",
        "pins": [
          {
            "instance": "first",
            "pin": "y"
          },
          {
            "instance": "second",
            "pin": "a"
          },
          {
            "instance": "second",
            "pin": "b"
          },
          {
            "instance": "firstProbe",
            "pin": "measured"
          }
        ]
      },
      {
        "id": "output",
        "pins": [
          {
            "instance": "second",
            "pin": "y"
          },
          {
            "instance": "secondProbe",
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
const { passive, fixture, assemble, advance, reading, level } = await importModule('./support.mjs');
const model = await fixture(adapter, inputs.fixture);
const first = [],
  second = [];
const board = await assemble(
  adapter,
  [{ id: 'nand', model, create: passive }],
  inputs.description,
  { first, second },
);
t.after(() => board.dispose());
```

## 断言

```typescript
advance(board, 1);
level(first, true);
level(second, false);
const expected = (3.3 * 500000) / (500000 + 25);
assert.ok(Math.abs(reading(first).voltage - expected) < 1e-9);
assert.ok(Math.abs(reading(second).voltage) < 1e-9);
advance(board, 2);
level(first, true);
level(second, false);
```
