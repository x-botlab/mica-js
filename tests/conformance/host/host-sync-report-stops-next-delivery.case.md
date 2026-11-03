---
format: mica-case/v1
id: host-sync-report-stops-next-delivery
kind: simulation
---

# host-sync-report-stops-next-delivery

## 规范来源

[docs/spec/errors.rst](../../../docs/spec/errors.rst)

<!-- prettier-ignore -->
> 若 ``sync`` 中调用 ``reportError`` 后返回，当前推进失败，后续 ``sync`` 不执行。

[docs/spec/errors.rst](../../../docs/spec/errors.rst)

<!-- prettier-ignore -->
> 正在执行的 ``runUntil`` MUST 报告失败；已经故障的板再次调用 ``runUntil`` MUST 立即失败。若故障是在仿真到达目标时间后的 ``sync`` 中发生，时间保持在该目标位置，但本次推进仍然失败。

[docs/spec/javascript/host.rst](../../../docs/spec/javascript/host.rst)

<!-- prettier-ignore -->
> CHANNEL_OVERFLOW / REPORTED_ERROR / CLEANUP_FAILED - Overflow.error、有效 context 显式上报、释放步骤失败。

## 验收义务

前提：三个实例各输出 7，按 A、B、C 顺序交付；B 的 sync 记录输出后调用 reportError 并正常返回。

操作：推进到 5，再尝试推进故障板。

预期：当前推进以 REPORTED_ERROR 失败并保留时间 5；A、B 的交付记录保留，C 不再 sync；再次推进立即失败且不新增交付。

## 模型

```ddl
device Delivery {
  output channel out: number(capacity: 2);
  process start { out.send(7); }
}
```

## 装配

```json
{
  "instances": [
    { "id": "a", "type": "a" },
    { "id": "b", "type": "b" },
    { "id": "c", "type": "c" }
  ],
  "nets": []
}
```

## 执行步骤

```typescript
const { diagnostic } = await importModule('./fixture.mjs');
const model = await adapter.compileDDL(modelSource);
const cause = new Error('B report');
const deliveries = [];
let returned = false;
const library = adapter.createDeviceLibrary(
  ['a', 'b', 'c'].map((id) => ({
    id,
    model,
    create(ctx) {
      return {
        sync(batch) {
          deliveries.push([id, batch.outputs.out.map((message) => message.value)]);
          if (id === 'b') {
            ctx.reportError(cause);
            returned = true;
          }
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
    assert.equal(error.code, 'REPORTED_ERROR');
    assert.equal(error.diagnostic.cause, cause);
    return true;
  },
);
assert.equal(returned, true);
assert.deepEqual(deliveries, [
  ['a', [7]],
  ['b', [7]],
]);
assert.equal(board.time, 5);
assert.equal(board.status, 'faulted');
assert.throws(() => board.runUntil(6), diagnostic('BOARD_FAULTED'));
assert.equal(deliveries.length, 2);
```
