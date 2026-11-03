---
format: mica-case/v1
id: semantics-earlier-start-triggers-later-instance-reaction-before-its-start
kind: comparison
---

# semantics-earlier-start-triggers-later-instance-reaction-before-its-start

## 规范来源

[docs/spec/execution/scheduling.rst](../../../../docs/spec/execution/scheduling.rst)

## 验收义务

前提：驱动实例排在接收实例前，接收反应将高电平锁存到存储。

操作：推进到0，收集接收实例start输出。

预期：输出[1]表明这条装配路径中的反应先于接收实例start。

## 对照输入

```json
{
  "models": {
    "driver": "device Driver {\n        pin supply; pin signal;\n        process start { signal.intent <- [resistor(to: supply, resistance: 1000)]; }\n      }",
    "receiver": "device Receiver {\n        pin signal(low: 0.8, high: 2.0);\n        memory saved[1]; output channel out: number(capacity: 4);\n        reaction latch on signal.sample.level as (old, current) {\n          if current == Logic.high { store8(saved, 0, 1); }\n        }\n        process start { out.send(load8(saved, 0)); }\n      }"
  },
  "description": {
    "instances": [
      {
        "id": "driver",
        "type": "driver"
      },
      {
        "id": "receiver",
        "type": "receiver"
      }
    ],
    "nets": [
      {
        "id": "supply",
        "voltage": 3.3,
        "pins": [
          {
            "instance": "driver",
            "pin": "supply"
          }
        ]
      },
      {
        "id": "signal",
        "pins": [
          {
            "instance": "driver",
            "pin": "signal"
          },
          {
            "instance": "receiver",
            "pin": "signal"
          }
        ]
      }
    ]
  }
}
```

## 执行步骤

```typescript
const driver = await adapter.compileDDL(inputs.models.driver);
const receiver = await adapter.compileDDL(inputs.models.receiver);
const outputs = [];
const library = adapter.createDeviceLibrary([
  {
    id: 'driver',
    model: driver,
    create() {
      return { sync() {}, dispose() {} };
    },
  },
  {
    id: 'receiver',
    model: receiver,
    create() {
      return {
        sync(batch) {
          outputs.push(...batch.outputs.out.map((message) => message.value));
        },
        dispose() {},
      };
    },
  },
]);
const board = adapter.createBoard(library, inputs.description);
t.after(board.dispose.bind(board));

board.runUntil(0);
```

## 断言

```typescript
assert.deepEqual(outputs, [1]);

board.dispose();
```
