---
format: mica-case/v1
id: host-error-event-phase-before-state-and-target
kind: simulation
---

# host-error-event-phase-before-state-and-target

## 规范来源

[docs/spec/errors.rst](../../../docs/spec/errors.rst)

<!-- prettier-ignore -->
> 已创建对象的调用守卫 MUST 依次检查 context 或对象有效性、当前阶段与同板重入、操作所需的板状态，最后才校验参数。因而 ``disposedBoard.runUntil(NaN)`` 报 ``OBJECT_DISPOSED``，``onDidError`` 回调中同板 ``runUntil('x')`` 报 ``INVALID_CALL_STATE``，均不进入参数校验。

[docs/spec/conformance.rst](../../../docs/spec/conformance.rst)

<!-- prettier-ignore -->
> 对象失效优先 OBJECT_DISPOSED；其次阶段或同板重入优先 INVALID_CALL_STATE，再按所需状态报 BOARD_FAULTED，合法状态下才检查参数；重复 dispose 仍无操作，无重复故障事件。

## 验收义务

前提：板已因首故障进入 faulted，onDidError 监听器正在同步分发。

操作：监听器对同板调用 runUntil('x') 并捕获错误。

预期：调用以 INVALID_CALL_STATE 拒绝，优先于 BOARD_FAULTED 与目标类型校验；原首故障原因不被替换。

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
const observations = [];
const reentry = [];
const cause = new Error('first report');
board.onDidError((error) => {
  observations.push([board.status, error.cause]);
  try {
    board.runUntil('x');
  } catch (error) {
    reentry.push(error.code);
  }
});
```

## 断言

```typescript
context.reportError(cause);
assert.deepEqual(observations, [['faulted', cause]]);
assert.deepEqual(reentry, ['INVALID_CALL_STATE']);
```
