---
format: mica-case/v1
id: host-factory-report-prevents-ready-board
kind: simulation
---

# host-factory-report-prevents-ready-board

## 规范来源

[docs/spec/errors.rst](../../../docs/spec/errors.rst)

<!-- prettier-ignore -->
> 工厂通过 ``reportError`` 或错误返回 thenable 造成的初始化故障，同样使装配失败。初始化期间已经广播的话题保留为既成副作用。

[docs/spec/errors.rst](../../../docs/spec/errors.rst)

<!-- prettier-ignore -->
> 销毁时，运行时 MUST 先使全板所有 context 失效，再按实例创建顺序的逆序清理。每个实例先调用已经返回的适配对象的 ``dispose``，再按 SDK 资源注册顺序的逆序清理该实例所属资源；失败工厂没有返回适配对象时，直接清理其资源。初始化失败也使用同一顺序。

[docs/spec/javascript/host.rst](../../../docs/spec/javascript/host.rst)

<!-- prettier-ignore -->
> CHANNEL_OVERFLOW / REPORTED_ERROR / CLEANUP_FAILED - Overflow.error、有效 context 显式上报、释放步骤失败。

## 验收义务

前提：A 工厂成功；B 工厂在返回适配对象前调用 reportError；C 尚未初始化。

操作：同步创建板并记录工厂进入与适配对象清理顺序。

预期：不交付 ready 板；创建以 REPORTED_ERROR 失败并保留原原因；只进入 A、B 工厂，已返回的适配对象按 B、A 逆序各清理一次。

## 模型

```ddl
device HostProbe {}
```

## 装配

```json
{
  "instances": [
    { "id": "a", "type": "a" },
    { "id": "b", "type": "b" },
    { "id": "c", "type": "c" }
  ],
  "nets": []
}
```

## 执行步骤

```typescript
const model = await adapter.compileDDL(modelSource);
const cause = new Error('initialization report');
const created = [];
const released = [];
let returned = false;
const library = adapter.createDeviceLibrary(
  ['a', 'b', 'c'].map((id) => ({
    id,
    model,
    create(ctx) {
      created.push(id);
      if (id === 'b') {
        ctx.reportError(cause);
        returned = true;
      }
      return {
        sync() {},
        dispose() {
          released.push(id);
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
    assert.equal(error.code, 'REPORTED_ERROR');
    assert.equal(error.diagnostic.cause, cause);
    return true;
  },
);
assert.equal(returned, true);
assert.deepEqual(created, ['a', 'b']);
assert.deepEqual(released, ['b', 'a']);
```
