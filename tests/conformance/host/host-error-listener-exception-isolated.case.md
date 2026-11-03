---
format: mica-case/v1
id: host-error-listener-exception-isolated
kind: simulation
---

# host-error-listener-exception-isolated

## 规范来源

[docs/spec/javascript/host.rst](../../../docs/spec/javascript/host.rst)

<!-- prettier-ignore -->
> 单个 onDidError 或宿主话题监听器抛错，不覆盖主因、不阻止其他宿主监听器与清理，通过 onDidDiagnostic 报告。onDidDiagnostic 监听器自身抛错仅用 console.error 兜底，不递归发布。

[docs/spec/errors.rst](../../../docs/spec/errors.rst)

<!-- prettier-ignore -->
> 运行时 MUST 包装需要隔离的宿主监听器：单个 ``onDidError`` 监听器异常转为非致命 ``onDidDiagnostic``，继续其余监听器；诊断监听器异常只交给 ``console.error``，不再递归产生诊断。

[docs/spec/javascript/host.rst](../../../docs/spec/javascript/host.rst)

<!-- prettier-ignore -->
> RuntimeDiagnostic 与 D2 的 IR Diagnostic 分开，复用 InputPath 与 SourceInfo。phase 是 library、assembly、initialize、execute、translate、sync、topic、dispose、host 或 report；time 是发生时已到达的仿真时间，在板时间尚未建立时为 null。instanceId、resource、path、source 在可确定时携带，diagnostic.cause 保留原异常引用，SimulationError 的规范访问位置为 error.diagnostic.cause，不要求 Error.cause 别名；只读合同不冻结原异常对象。related 依发生顺序保存附加诊断。

[docs/spec/javascript/host.rst](../../../docs/spec/javascript/host.rst)

<!-- prettier-ignore -->
> CHANNEL_OVERFLOW / REPORTED_ERROR / CLEANUP_FAILED - Overflow.error、有效 context 显式上报、释放步骤失败。

[docs/spec/javascript/host.rst](../../../docs/spec/javascript/host.rst)

<!-- prettier-ignore -->
> STALE_REPORT / HOST_LISTENER_FAILED - 销毁 context 的晚到上报或宿主监听器异常。

## 验收义务

前提：首个 onDidError 监听器抛错，另一个 onDidError 监听器与 onDidDiagnostic 监听器记录收到的诊断。

操作：有效 context 上报主故障。

预期：上报正常返回；后续 onDidError 监听器收到 REPORTED_ERROR 与原原因；监听器异常不覆盖主因，只作为 HOST_LISTENER_FAILED 非致命诊断交付并保留原异常引用，板保持 faulted。

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
const { board, context } = await device(
  adapter,
  await adapter.compileDDL(modelSource),
  {},
  description,
);
t.after(board.dispose.bind(board));
const primary = new Error('primary');
const listener = new Error('listener');
const errors = [];
const diagnostics = [];
board.onDidDiagnostic((error) => diagnostics.push(error));
board.onDidError(() => {
  throw listener;
});
board.onDidError((error) => errors.push(error));
```

## 断言

```typescript
assert.doesNotThrow(() => context.reportError(primary));
assert.equal(errors.length, 1);
assert.equal(errors[0].code, 'REPORTED_ERROR');
assert.equal(errors[0].cause, primary);
assert.equal(diagnostics.length, 1);
assert.equal(diagnostics[0].code, 'HOST_LISTENER_FAILED');
assert.equal(diagnostics[0].cause, listener);
assert.equal(board.status, 'faulted');
```
