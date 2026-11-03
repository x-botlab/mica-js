---
format: mica-case/v1
id: host-report-first-fault-before-event
kind: simulation
---

# host-report-first-fault-before-event

## 规范来源

[docs/spec/errors.rst](../../../docs/spec/errors.rst)

<!-- prettier-ignore -->
> 板处于 ``ready`` 时，当前有效 context 调用 ``reportError``，运行时 MUST 立即记录主故障、标记 ``faulted`` 并封锁副作用，然后同步分发 ``onDidError``；上报调用自身正常返回。

[docs/spec/javascript/host.rst](../../../docs/spec/javascript/host.rst)

<!-- prettier-ignore -->
> RuntimeDiagnostic 与 D2 的 IR Diagnostic 分开，复用 InputPath 与 SourceInfo。phase 是 library、assembly、initialize、execute、translate、sync、topic、dispose、host 或 report；time 是发生时已到达的仿真时间，在板时间尚未建立时为 null。instanceId、resource、path、source 在可确定时携带，diagnostic.cause 保留原异常引用，SimulationError 的规范访问位置为 error.diagnostic.cause，不要求 Error.cause 别名；只读合同不冻结原异常对象。related 依发生顺序保存附加诊断。

[docs/spec/javascript/host.rst](../../../docs/spec/javascript/host.rst)

<!-- prettier-ignore -->
> CHANNEL_OVERFLOW / REPORTED_ERROR / CLEANUP_FAILED - Overflow.error、有效 context 显式上报、释放步骤失败。

[docs/spec/javascript/host.rst](../../../docs/spec/javascript/host.rst)

<!-- prettier-ignore -->
> INVALID_CALL_STATE / OBJECT_DISPOSED / BOARD_FAULTED / INVALID_BINDING - 非法阶段或重入、失效对象、故障板调用、资源绑定错误。

## 验收义务

前提：ready 板有合法输入通知端点与首故障监听器。

操作：有效 context 在推进之外上报 Error；监听器尝试 notify。

预期：上报正常返回；onDidError 在 faulted 状态同步收到 REPORTED_ERROR、phase 为 report 及原原因；通知因故障被拒绝为 BOARD_FAULTED。

## 模型

```ddl
device HostProbe { input notification wake; }
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
const cause = new Error('external failure');
const observed = [];
const blocked = [];
board.onDidError((error) => {
  observed.push([board.status, error.code, error.phase, error.cause]);
  try {
    context.inputs.wake.notify();
  } catch (error) {
    blocked.push(error.code);
  }
});
```

## 断言

```typescript
assert.doesNotThrow(() => context.reportError(cause));
assert.deepEqual(observed, [['faulted', 'REPORTED_ERROR', 'report', cause]]);
assert.deepEqual(blocked, ['BOARD_FAULTED']);
```
