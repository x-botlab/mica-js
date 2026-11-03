---
kind: simulation
---

# host-cleanup-errors-preserve-existing-primary

## 规范来源

[docs/spec/errors.rst](../../../docs/spec/errors.rst)

<!-- prettier-ignore -->
> 无清理错误时，``dispose`` 正常返回，即使板此前已经 ``faulted``。有清理错误时抛出汇总的 ``SimulationError``：已有首故障保留为主因，清理错误按发生顺序加入 ``related``；没有既有故障时，以首个清理错误为主因，后续清理错误归入 ``related``。已经交付的诊断对象保持只读，不为追加清理记录而修改旧事件对象。

[docs/spec/errors.rst](../../../docs/spec/errors.rst)

<!-- prettier-ignore -->
> 销毁时，运行时 MUST 先使全板所有 context 失效，再按实例创建顺序的逆序清理。每个实例先调用已经返回的适配对象的 ``dispose``，再按 SDK 资源注册顺序的逆序清理该实例所属资源；失败工厂没有返回适配对象时，直接清理其资源。初始化失败也使用同一顺序。

[docs/spec/javascript/host.rst](../../../docs/spec/javascript/host.rst)

<!-- prettier-ignore -->
> CHANNEL_OVERFLOW / REPORTED_ERROR / CLEANUP_FAILED - Overflow.error、有效 context 显式上报、释放步骤失败。

## 验收义务

前提：故障板已有 REPORTED_ERROR 主故障；A、B 两个实例的适配对象在清理时各自抛出错误。

操作：销毁故障板并捕获汇总的 SimulationError，随后再次销毁。

预期：主因保留原 REPORTED_ERROR 及其原因；related 按逆实例清理的发生顺序附加两个 CLEANUP_FAILED，B 先于 A；已发布的首故障诊断不被修改；板进入 disposed，重复销毁不重试。

## 模型

```ddl
device Cleanup {}
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
const model = await adapter.compileDDL(modelSource);
const causes = { a: new Error('cleanup A'), b: new Error('cleanup B') };
const released = [];
const contexts = [];
const library = adapter.createDeviceLibrary(
  ['a', 'b'].map((id) => ({
    id,
    model,
    create(ctx) {
      contexts.push(ctx);
      return {
        sync() {},
        dispose() {
          released.push(id);
          throw causes[id];
        },
      };
    },
  })),
);
const board = adapter.createBoard(library, description);
t.after(() => {
  if (board.status !== 'disposed') board.dispose();
});
const primary = new Error('primary');
const errors = [];
board.onDidError((error) => errors.push(error));
contexts[0].reportError(primary);
const originalRelated = [...errors[0].related];
```

## 断言

```typescript
assert.throws(
  () => board.dispose(),
  (error) => {
    assert.equal(error.code, 'REPORTED_ERROR');
    assert.equal(error.diagnostic.cause, primary);
    assert.deepEqual(
      error.related.map((item) => item.code),
      ['CLEANUP_FAILED', 'CLEANUP_FAILED'],
    );
    assert.deepEqual(
      error.related.map((item) => item.cause),
      [causes.b, causes.a],
    );
    return true;
  },
);
assert.deepEqual(errors[0].related, originalRelated);
assert.deepEqual(released, ['b', 'a']);
assert.equal(board.status, 'disposed');
assert.doesNotThrow(() => board.dispose());
assert.deepEqual(released, ['b', 'a']);
```
