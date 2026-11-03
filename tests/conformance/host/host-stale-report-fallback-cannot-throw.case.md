---
format: mica-case/v1
id: host-stale-report-fallback-cannot-throw
kind: simulation
---

# host-stale-report-fallback-cannot-throw

## 规范来源

[docs/spec/javascript/host.rst](../../../docs/spec/javascript/host.rst)

<!-- prettier-ignore -->
> 销毁后的事件源不再分发；旧 context 的 reportError 用过期诊断兜底，正常返回，不改变任何新板。兜底输出失败也不能使 reportError 或清理流程再次抛错。

## 验收义务

前提：旧板已销毁且事件分发停止，新板复用相同实例 ID；console.error 在记录后抛错。

操作：旧 context 晚到上报 Error。

预期：reportError 正常返回，兜底输出错误不逸出；旧板事件不再分发，新板无诊断、保持 ready 且可正常推进。

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
const old = await device(adapter, model, {}, description);
t.after(old.board.dispose.bind(old.board));
const oldEvents = [];
old.board.onDidError((error) => oldEvents.push(error));
old.board.onDidDiagnostic((error) => oldEvents.push(error));
old.board.dispose();
const fresh = await device(adapter, model, {}, description);
t.after(fresh.board.dispose.bind(fresh.board));
const freshEvents = [];
fresh.board.onDidError((error) => freshEvents.push(error));
fresh.board.onDidDiagnostic((error) => freshEvents.push(error));
const fallback = t.mock.method(console, 'error', () => {
  throw new Error('console failure');
});
```

## 断言

```typescript
assert.doesNotThrow(() => old.context.reportError(new Error('late')));
assert.ok(fallback.mock.callCount() > 0);
assert.deepEqual(oldEvents, []);
assert.deepEqual(freshEvents, []);
assert.equal(fresh.board.status, 'ready');
assert.doesNotThrow(() => fresh.board.runUntil(1));
assert.equal(old.board.status, 'disposed');
```
