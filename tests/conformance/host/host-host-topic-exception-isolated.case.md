---
format: mica-case/v1
id: host-host-topic-exception-isolated
kind: simulation
---

# host-host-topic-exception-isolated

## 规范来源

[docs/spec/javascript/host.rst](../../../docs/spec/javascript/host.rst)

<!-- prettier-ignore -->
> 器件话题回调异常使板故障；宿主话题监听器异常只报告 ``HOST_LISTENER_FAILED`` 非致命诊断并继续其他监听器。

## 验收义务

前提：ready 板按注册顺序登记两个宿主话题监听器，第一个抛出既有 Error。

操作：发布一次合法话题。

预期：publish 正常返回且第二个监听器仍执行；只产生 HOST_LISTENER_FAILED 非致命诊断并保留原因，不产生 onDidError，板保持 ready。

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
const { board } = await device(adapter, await adapter.compileDDL(modelSource), {}, description);
t.after(board.dispose.bind(board));
const cause = new Error('host listener');
const log = [];
const diagnostics = [];
const errors = [];
board.onDidError((error) => errors.push(error));
board.onDidDiagnostic((error) => diagnostics.push(error));
board.topics.onDidReceive(() => {
  log.push('first');
  throw cause;
});
board.topics.onDidReceive(() => log.push('second'));
```

## 断言

```typescript
assert.doesNotThrow(() => board.topics.publish('probe', null));
assert.deepEqual(log, ['first', 'second']);
assert.equal(diagnostics.length, 1);
assert.equal(diagnostics[0].code, 'HOST_LISTENER_FAILED');
assert.equal(diagnostics[0].cause, cause);
assert.deepEqual(errors, []);
assert.equal(board.status, 'ready');
```
