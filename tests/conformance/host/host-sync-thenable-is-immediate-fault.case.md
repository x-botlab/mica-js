---
kind: simulation
---

# host-sync-thenable-is-immediate-fault

## 规范来源

[docs/spec/errors.rst](../../../docs/spec/errors.rst)

<!-- prettier-ignore -->
> 同步钩子返回 Promise 或其他 thenable 时，框架立即报告接口错误，不等待其完成。

[docs/spec/errors.rst](../../../docs/spec/errors.rst)

<!-- prettier-ignore -->
> 工厂、``sync`` 或器件话题回调返回 thenable - 同步接口违约，按整板故障处理。

[docs/spec/javascript/host.rst](../../../docs/spec/javascript/host.rst)

<!-- prettier-ignore -->
> DEVICE_CALLBACK_FAILED / ASYNC_HOOK_RESULT - 器件同步回调抛错或返回 thenable。

[docs/spec/javascript/host.rst](../../../docs/spec/javascript/host.rst)

<!-- prettier-ignore -->
> RuntimeDiagnostic 与 D2 的 IR Diagnostic 分开，复用 InputPath 与 SourceInfo。phase 是 library、assembly、initialize、execute、translate、sync、topic、dispose、host 或 report；time 是发生时已到达的仿真时间，在板时间尚未建立时为 null。instanceId、resource、path、source 在可确定时携带，diagnostic.cause 保留原异常引用，SimulationError 的规范访问位置为 error.diagnostic.cause，不要求 Error.cause 别名；只读合同不冻结原异常对象。related 依发生顺序保存附加诊断。

[docs/spec/errors.rst](../../../docs/spec/errors.rst)

<!-- prettier-ignore -->
> 正在执行的 ``runUntil`` MUST 报告失败；已经故障的板再次调用 ``runUntil`` MUST 立即失败。若故障是在仿真到达目标时间后的 ``sync`` 中发生，时间保持在该目标位置，但本次推进仍然失败。

## 验收义务

前提：器件 sync 返回一个永不完成的 thenable。

操作：同步推进到 2。

预期：立即以 ASYNC_HOOK_RESULT 失败（phase 为 sync），不等待其完成；唯一首故障事件同码，板停在时间 2 且 faulted。

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
const { diagnostic } = await importModule('./fixture.mjs');
const model = await adapter.compileDDL(modelSource);
const library = adapter.createDeviceLibrary([
  {
    id: 'probe',
    model,
    create() {
      return {
        sync() {
          return { then() {} };
        },
        dispose() {},
      };
    },
  },
]);
const board = adapter.createBoard(library, description);
t.after(board.dispose.bind(board));
const errors = [];
board.onDidError((error) => errors.push(error));
```

## 断言

```typescript
assert.throws(() => board.runUntil(2), diagnostic('ASYNC_HOOK_RESULT', 'sync'));
assert.equal(errors.length, 1);
assert.equal(errors[0].code, 'ASYNC_HOOK_RESULT');
assert.equal(board.time, 2);
assert.equal(board.status, 'faulted');
```
