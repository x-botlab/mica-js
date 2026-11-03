---
kind: comparison
---

# consistency-real-device-builder-and-ddl-share-host-execution-contract

## 规范来源

[docs/spec/assembly.rst](../../../docs/spec/assembly.rst)

[docs/spec/javascript/host.rst](../../../docs/spec/javascript/host.rst)

## 验收义务

前提：同一过程的 DDL 模型与仅由 Builder 构造的 DeviceIR 具有等价等待与公开 memory 行为。

操作：分别以两个不同登记 ID 装配真实 Builder 模型，并与 DDL 过程在同目标推进下比较等待和公开 memory。

预期：两个登记均可装配；等待和公开 memory 结果与 DDL 等价过程相同；无需额外源码字段。

## 对照输入

```json
{
  "models": {
    "equivalent": "device Equivalent {\n  public memory data[2];\n  process start {\n    store8(data, 0, 7);\n    await ticks(3);\n    store8(data, 1, 9);\n  }\n}"
  },
  "description": {
    "instances": [
      {
        "id": "built-left",
        "type": "built-left"
      },
      {
        "id": "built-right",
        "type": "built-right"
      },
      {
        "id": "compiled",
        "type": "compiled"
      }
    ],
    "nets": []
  }
}
```

## 执行步骤

```typescript
const builder = adapter.createDeviceBuilder();
builder.memory({ name: 'data', public: true, length: 2 });
builder.start((body) => {
  body.store8('data', 0, 7);
  body.wait(3);
  body.store8('data', 1, 9);
});
const built = builder.finish();
const compiled = await adapter.compileDDL(inputs.models.equivalent);
const contexts = [];
const observed = [];
const library = adapter.createDeviceLibrary(
  [
    ['built-left', built],
    ['built-right', built],
    ['compiled', compiled],
  ].map(([id, model]) => ({
    id,
    model,
    create(ctx) {
      contexts.push(ctx);
      return {
        sync() {
          observed.push([id, [...ctx.memory.data]]);
        },
        dispose() {},
      };
    },
  })),
);
const board = adapter.createBoard(library, inputs.description);
t.after(board.dispose.bind(board));

assert.equal(contexts.length, 3);
assert.deepEqual(
  contexts.map((ctx) => [...ctx.memory.data]),
  [
    [0, 0],
    [0, 0],
    [0, 0],
  ],
);
board.runUntil(2);
assert.deepEqual(observed, [
  ['built-left', [7, 0]],
  ['built-right', [7, 0]],
  ['compiled', [7, 0]],
]);
board.runUntil(3);
```

## 断言

```typescript
assert.deepEqual(observed.slice(3), [
  ['built-left', [7, 9]],
  ['built-right', [7, 9]],
  ['compiled', [7, 9]],
]);

board.dispose();
```
