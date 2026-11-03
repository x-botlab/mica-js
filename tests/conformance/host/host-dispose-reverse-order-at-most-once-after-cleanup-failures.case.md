---
format: mica-case/v1
id: host-dispose-reverse-order-at-most-once-after-cleanup-failures
kind: simulation
---

# host-dispose-reverse-order-at-most-once-after-cleanup-failures

## 规范来源

[docs/spec/javascript/lifecycle.rst](../../../docs/spec/javascript/lifecycle.rst)

[docs/spec/errors.rst](../../../docs/spec/errors.rst)

## 验收义务

前提：两个适配对象的 dispose 均尝试所有输入端点并抛出清理异常。

操作：销毁板，捕获汇总异常，重复销毁并尝试非法目标推进。

预期：适配对象按 B、A 各清理一次，所有输入操作都已失效；板 disposed 且时间可读，重复销毁不重试，推进报 OBJECT_DISPOSED。本例不测 SDK 资源底层释放次数。

## 模型

<!-- prettier-ignore -->
```ddl
device Cleanup { input notification wake; }
```

## 装配

```json
{
  "instances": [
    {
      "id": "a",
      "type": "a"
    },
    {
      "id": "b",
      "type": "b"
    }
  ],
  "nets": []
}
```

## 执行步骤

```typescript
const { diagnostic } = await importModule('./fixture.mjs');

const model = await adapter.compileDDL(modelSource);
const contexts = [];
const released = [];
const blocked = [];
const library = adapter.createDeviceLibrary(
  ['a', 'b'].map((id) => ({
    id,
    model,
    create(ctx) {
      contexts.push(ctx);
      return {
        sync() {},
        dispose() {
          released.push(id);
          for (const context of contexts) {
            try {
              context.inputs.wake.notify();
            } catch (error) {
              blocked.push(error.code);
            }
          }
          throw new Error(`cleanup ${id}`);
        },
      };
    },
  })),
);
const board = adapter.createBoard(library, description);
t.after(board.dispose.bind(board));
```

## 断言

```typescript
assert.throws(() => board.dispose(), diagnostic('CLEANUP_FAILED'));
assert.deepEqual(released, ['b', 'a']);
assert.deepEqual(blocked, Array(4).fill('OBJECT_DISPOSED'));
assert.equal(board.status, 'disposed');
assert.equal(board.time, 0);
assert.doesNotThrow(() => board.dispose());
assert.deepEqual(released, ['b', 'a']);
assert.throws(() => board.runUntil(NaN), diagnostic('OBJECT_DISPOSED'));

board.dispose();
```
