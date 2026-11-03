---
format: mica-case/v1
id: host-sync-partial-delivery-stops-at-first-device-failure
kind: simulation
---

# host-sync-partial-delivery-stops-at-first-device-failure

## 规范来源

[docs/spec/javascript/host.rst](../../../docs/spec/javascript/host.rst)

[docs/spec/errors.rst](../../../docs/spec/errors.rst)

## 验收义务

前提：A、B、C 各生成输出 7，B 的 sync 在记录该输出后抛错。

操作：推进到 5，捕获失败，再尝试推进到 6。

预期：保留 A、B 的交付记录和时间 5，不调用 C；故障板再次推进被拒且不新增交付。本例不宣称验证跨新板的恢复或任意外部副作用。

## 模型

<!-- prettier-ignore -->
```ddl
device Delivery {
        output channel out: number(capacity: 2); process start { out.send(7); }
      }
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
    },
    {
      "id": "c",
      "type": "c"
    }
  ],
  "nets": []
}
```

## 执行步骤

```typescript
const { diagnostic } = await importModule('./fixture.mjs');

const model = await adapter.compileDDL(modelSource);
const deliveries = [];
const cause = new Error('B sync failed');
const library = adapter.createDeviceLibrary(
  ['a', 'b', 'c'].map((id) => ({
    id,
    model,
    create() {
      return {
        sync(batch) {
          deliveries.push([id, batch.outputs.out.map((message) => message.value)]);
          if (id === 'b') throw cause;
        },
        dispose() {},
      };
    },
  })),
);
const board = adapter.createBoard(library, description);
t.after(board.dispose.bind(board));
```

## 断言

```typescript
assert.throws(
  () => board.runUntil(5),
  (error) => {
    assert.equal(error.code, 'DEVICE_CALLBACK_FAILED');
    assert.equal(error.diagnostic.phase, 'sync');
    assert.equal(error.diagnostic.cause, cause);
    return true;
  },
);
assert.deepEqual(deliveries, [
  ['a', [7]],
  ['b', [7]],
]);
assert.equal(board.time, 5);
assert.equal(board.status, 'faulted');
assert.throws(() => board.runUntil(6), diagnostic('BOARD_FAULTED'));
assert.equal(deliveries.length, 2);

board.dispose();
```
