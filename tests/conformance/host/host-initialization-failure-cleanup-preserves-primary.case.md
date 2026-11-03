---
kind: simulation
---

# host-initialization-failure-cleanup-preserves-primary

## 规范来源

[docs/spec/errors.rst](../../../docs/spec/errors.rst)

<!-- prettier-ignore -->
> 工厂尚未返回适配对象就失败时，运行时 MUST 清理该实例通过 context 获得的 SDK 资源，包括已经建立的订阅与 JIT 注册，并清理此前成功创建的适配对象。此清理不依赖失败工厂成功返回对象。

[docs/spec/errors.rst](../../../docs/spec/errors.rst)

<!-- prettier-ignore -->
> 本次装配不得返回可运行的半成品。清理本身失败时，继续执行下述尽力清理规则，并保留初始化的首个故障主因。

[docs/spec/javascript/host.rst](../../../docs/spec/javascript/host.rst)

<!-- prettier-ignore -->
> RuntimeDiagnostic 与 D2 的 IR Diagnostic 分开，复用 InputPath 与 SourceInfo。phase 是 library、assembly、initialize、execute、translate、sync、topic、dispose、host 或 report；time 是发生时已到达的仿真时间，在板时间尚未建立时为 null。instanceId、resource、path、source 在可确定时携带，diagnostic.cause 保留原异常引用，SimulationError 的规范访问位置为 error.diagnostic.cause，不要求 Error.cause 别名；只读合同不冻结原异常对象。related 依发生顺序保存附加诊断。

[docs/spec/javascript/host.rst](../../../docs/spec/javascript/host.rst)

<!-- prettier-ignore -->
> DEVICE_CALLBACK_FAILED / ASYNC_HOOK_RESULT - 器件同步回调抛错或返回 thenable。

[docs/spec/javascript/host.rst](../../../docs/spec/javascript/host.rst)

<!-- prettier-ignore -->
> CHANNEL_OVERFLOW / REPORTED_ERROR / CLEANUP_FAILED - Overflow.error、有效 context 显式上报、释放步骤失败。

## 验收义务

前提：A 工厂成功返回适配对象，B 工厂在返回前抛出原始 Error；A 的 dispose 记录释放后也抛错。

操作：同步创建板并捕获失败。

预期：不交付板；清理此前适配对象与失败实例的 SDK 资源；主诊断为 DEVICE_CALLBACK_FAILED、phase 为 initialize 并保留 B 的原因；A 的清理错误作为 CLEANUP_FAILED 附加到 related，不覆盖主因；两个 context 均失效。

## 模型

```ddl
device Cleanup {
  input notification wake;
}
```

## 装配

```json
{
  "instances": [
    { "id": "a", "type": "a" },
    { "id": "b", "type": "b" }
  ],
  "nets": []
}
```

## 执行步骤

```typescript
const { diagnostic } = await importModule('./fixture.mjs');
const model = await adapter.compileDDL(modelSource);
const primary = new Error('factory B');
const cleanup = new Error('cleanup A');
const contexts = [];
const released = [];
const library = adapter.createDeviceLibrary(
  ['a', 'b'].map((id) => ({
    id,
    model,
    create(ctx) {
      contexts.push(ctx);
      ctx.topics.onDidReceive(() => {});
      if (id === 'b') throw primary;
      return {
        sync() {},
        dispose() {
          released.push(id);
          throw cleanup;
        },
      };
    },
  })),
);
```

## 断言

```typescript
assert.throws(
  () => {
    const board = adapter.createBoard(library, description);
    t.after(board.dispose.bind(board));
  },
  (error) => {
    assert.equal(error.code, 'DEVICE_CALLBACK_FAILED');
    assert.equal(error.diagnostic.phase, 'initialize');
    assert.equal(error.diagnostic.cause, primary);
    assert.deepEqual(
      error.related.map((item) => item.code),
      ['CLEANUP_FAILED'],
    );
    assert.deepEqual(
      error.related.map((item) => item.cause),
      [cleanup],
    );
    return true;
  },
);
assert.deepEqual(released, ['a']);
assert.equal(contexts.length, 2);
for (const ctx of contexts) {
  assert.throws(() => ctx.inputs.wake.notify(), diagnostic('OBJECT_DISPOSED'));
}
```
