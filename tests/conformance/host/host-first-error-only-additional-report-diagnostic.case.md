---
format: mica-case/v1
id: host-first-error-only-additional-report-diagnostic
kind: simulation
---

# host-first-error-only-additional-report-diagnostic

## 规范来源

[docs/spec/errors.rst](../../../docs/spec/errors.rst)

<!-- prettier-ignore -->
> 板处于 ``ready`` 时，当前有效 context 调用 ``reportError``，运行时 MUST 立即记录主故障、标记 ``faulted`` 并封锁副作用，然后同步分发 ``onDidError``；上报调用自身正常返回。已故障但尚未销毁的 context 后续上报只产生附加 ``onDidDiagnostic``，不得再次分发 ``onDidError`` 或替换首故障。

[docs/spec/javascript/host.rst](../../../docs/spec/javascript/host.rst)

<!-- prettier-ignore -->
> CHANNEL_OVERFLOW / REPORTED_ERROR / CLEANUP_FAILED - Overflow.error、有效 context 显式上报、释放步骤失败。

## 验收义务

前提：已订阅 onDidError 与 onDidDiagnostic，板为 ready。

操作：依次由有效 context 上报两个不同错误。

预期：首个错误只经 onDidError 发布一次 REPORTED_ERROR 并保留原原因；第二个错误只作为附加 onDidDiagnostic 发布，不替换首故障，首诊断的 related 不变。

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
const { device, diagnostic } = await importModule('./fixture.mjs');
const { board, context } = await device(
  adapter,
  await adapter.compileDDL(modelSource),
  {},
  description,
);
t.after(board.dispose.bind(board));
const errors = [];
const diagnostics = [];
board.onDidError((error) => errors.push(error));
board.onDidDiagnostic((error) => diagnostics.push(error));
const first = new Error('first');
const second = new Error('second');
context.reportError(first);
const originalRelated = [...errors[0].related];
```

## 断言

```typescript
assert.doesNotThrow(() => context.reportError(second));
assert.throws(() => board.runUntil(1), diagnostic('BOARD_FAULTED'));
assert.equal(errors.length, 1);
assert.equal(errors[0].code, 'REPORTED_ERROR');
assert.equal(errors[0].cause, first);
assert.deepEqual(errors[0].related, originalRelated);
assert.equal(diagnostics.length, 1);
assert.equal(diagnostics[0].code, 'REPORTED_ERROR');
assert.equal(diagnostics[0].cause, second);
```
