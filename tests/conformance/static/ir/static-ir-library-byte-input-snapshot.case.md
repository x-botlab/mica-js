---
kind: compile
---

# static-ir-library-byte-input-snapshot

## 规范来源

[docs/spec/ir/validation.rst](../../../../docs/spec/ir/validation.rst)

<!-- prettier-ignore -->
> 成功返回捕获的递归不可变快照；后续修改调用方的数组、节点、字节输入或来源对象不改变该结果。

## 验收义务

前提：手工 DeviceIR 的 start 向 bytes 输出通道发送常量 [1,2]；登记成功后调用方把该字节改成 99、把 send 的通道名改成不存在的名称、改写来源标签并清空 declarations 数组。

操作：随后装配并推进到 0，读取输出消息。

预期：已登记模型仍按原内容执行，只输出 [1,2]；板状态为 ready，调用方修改不进入可执行模型。

## 输入

```json
{
  "kind": "device",
  "name": "ByteSnapshot",
  "source": { "label": "original" },
  "declarations": [
    {
      "kind": "channel",
      "name": "out",
      "direction": "output",
      "type": { "kind": "bytes" },
      "capacity": {
        "type": { "kind": "number" },
        "body": {
          "operations": [
            {
              "kind": "constant",
              "result": 0,
              "type": { "kind": "number" },
              "constant": { "kind": "number", "value": 2 }
            },
            { "kind": "returnValue", "value": 0 }
          ]
        }
      },
      "maxLength": {
        "type": { "kind": "number" },
        "body": {
          "operations": [
            {
              "kind": "constant",
              "result": 0,
              "type": { "kind": "number" },
              "constant": { "kind": "number", "value": 2 }
            },
            { "kind": "returnValue", "value": 0 }
          ]
        }
      }
    },
    {
      "kind": "start",
      "body": {
        "operations": [
          {
            "kind": "constant",
            "result": 0,
            "type": { "kind": "bytes" },
            "constant": { "kind": "bytes", "value": [1, 2] }
          },
          { "kind": "send", "channel": "out", "value": 0 }
        ]
      }
    }
  ]
}
```

## 执行步骤

```typescript
const observed = [];
const library = adapter.createDeviceLibrary([
  {
    id: 'snapshot',
    model: input,
    create() {
      return {
        sync(batch) {
          observed.push(...batch.outputs.out.map((m) => [...m.value]));
        },
        dispose() {},
      };
    },
  },
]);
input.declarations[1].body.operations[0].constant.value[0] = 99;
input.declarations[1].body.operations[1].channel = 'missing';
input.source.label = 'changed';
input.declarations.length = 0;
const board = adapter.createBoard(library, {
  instances: [{ id: 'one', type: 'snapshot' }],
  nets: [],
});
t.after(board.dispose.bind(board));
board.runUntil(0);
```

## 断言

```typescript
assert.deepEqual(observed, [[1, 2]]);
assert.equal(board.status, 'ready');
```
