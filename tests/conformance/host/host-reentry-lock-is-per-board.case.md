---
format: mica-case/v1
id: host-reentry-lock-is-per-board
kind: simulation
---

# host-reentry-lock-is-per-board

## 规范来源

[docs/spec/errors.rst](../../../docs/spec/errors.rst)

<!-- prettier-ignore -->
> 重入封锁按板隔离：板 A 的回调可以操作独立板 B，B 的调用仍须满足其自身守卫，不设全局锁。

## 验收义务

前提：使用同一模型创建相互独立的 A、B 两板，均 ready。

操作：在 A 的宿主话题回调中推进 B 到 3。

预期：B 成功交付一次 sync 且 time 为 3；A 不推进，两板均保持 ready；重入封锁仅限同板。

## 模型

```ddl
device HostProbe {}
```

## 装配

```json
{ "instances": [{ "id": "probe", "type": "probe" }], "nets": [] }
```

## 执行步骤

```typescript
const { device } = await importModule('./fixture.mjs');
const model = await adapter.compileDDL(modelSource);
const a = await device(adapter, model, {}, description);
t.after(a.board.dispose.bind(a.board));
const b = await device(adapter, model, {}, description);
t.after(b.board.dispose.bind(b.board));
a.board.topics.onDidReceive(() => b.board.runUntil(3));
```

## 断言

```typescript
a.board.topics.publish('advance', null);
assert.equal(b.board.time, 3);
assert.equal(b.batches.length, 1);
assert.equal(a.board.time, 0);
assert.equal(a.board.status, 'ready');
assert.equal(b.board.status, 'ready');
```
