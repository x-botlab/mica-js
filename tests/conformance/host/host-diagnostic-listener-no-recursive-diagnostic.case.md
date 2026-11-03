---
kind: simulation
---

# host-diagnostic-listener-no-recursive-diagnostic

## 规范来源

[docs/spec/javascript/host.rst](../../../docs/spec/javascript/host.rst)

<!-- prettier-ignore -->
> 器件话题回调异常使板故障；宿主话题监听器异常只报告 ``HOST_LISTENER_FAILED`` 非致命诊断并继续其他监听器。

[docs/spec/errors.rst](../../../docs/spec/errors.rst)

<!-- prettier-ignore -->
> 通过 ``console.error`` 兜底，继续其他监听器，不递归分发诊断。

## 验收义务

前提：宿主话题监听器抛错产生 HOST_LISTENER_FAILED 非致命诊断，首个 onDidDiagnostic 监听器也抛错。

操作：发布一次合法话题。

预期：诊断监听器异常只由 console.error 兜底；后续诊断监听器仍收到唯一的 HOST_LISTENER_FAILED，首个诊断监听器只执行一次，不产生递归诊断，板保持 ready。

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
const fallback = t.mock.method(console, 'error', () => {});
const { board } = await device(adapter, await adapter.compileDDL(modelSource), {}, description);
t.after(board.dispose.bind(board));
const cause = new Error('host topic');
let firstCalls = 0;
const diagnostics = [];
board.topics.onDidReceive(() => {
  throw cause;
});
board.onDidDiagnostic(() => {
  firstCalls++;
  throw new Error('diagnostic listener');
});
board.onDidDiagnostic((error) => diagnostics.push(error));
```

## 断言

```typescript
assert.doesNotThrow(() => board.topics.publish('probe', null));
assert.equal(firstCalls, 1);
assert.equal(diagnostics.length, 1);
assert.equal(diagnostics[0].code, 'HOST_LISTENER_FAILED');
assert.equal(diagnostics[0].cause, cause);
assert.ok(fallback.mock.callCount() > 0);
assert.equal(board.status, 'ready');
```
