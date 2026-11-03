---
format: mica-case/v1
id: semantics-initial-pin-intent-establishes-high-baseline-without-edge
kind: simulation
---

# semantics-initial-pin-intent-establishes-high-baseline-without-edge

## 规范来源

[docs/spec/electrical.rst](../../../../docs/spec/electrical.rst)

[docs/spec/execution/scheduling.rst](../../../../docs/spec/execution/scheduling.rst)

## 验收义务

前提：signal初始上拉到固定3.3V，捕获函数若执行则断言失败。

操作：首次推进到0，让start读取电平。

预期：输出[1]且板ready，验证该初始高基线不执行捕获。

## 模型

<!-- prettier-ignore -->
```ddl
device InitialPin {
        pin signal(low: 0.8, high: 2.0) = [resistor(to: supply, resistance: 1000)];
        pin supply;
        state allowed: bool = false;
        output channel out: number(capacity: 4);
        pure fn checked() -> number { assert allowed; return 99; }
        reaction observe on signal.sample.level as (old, current) capture saved = checked() {
          out.send(saved);
        }
        process start { if signal.sample.level == Logic.high { out.send(1); } else { out.send(0); } }
      }
```

## 装配

```json
{
  "instances": [
    {
      "id": "initial",
      "type": "initial"
    }
  ],
  "nets": [
    {
      "id": "supply",
      "voltage": 3.3,
      "pins": [
        {
          "instance": "initial",
          "pin": "supply"
        }
      ]
    }
  ]
}
```

## 执行步骤

```typescript
const model = await adapter.compileDDL(modelSource);
const outputs = [];
const library = adapter.createDeviceLibrary([
  {
    id: 'initial',
    model,
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
const board = adapter.createBoard(library, description);
t.after(board.dispose.bind(board));

board.runUntil(0);
```

## 断言

```typescript
assert.equal(board.status, 'ready');
assert.deepEqual(outputs, [1]);

board.dispose();
```
