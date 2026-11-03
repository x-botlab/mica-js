---
format: mica-case/v1
id: host-topic-dispose-reentry-rejected
kind: simulation
---

# host-topic-dispose-reentry-rejected

## 规范来源

[docs/spec/javascript/lifecycle.rst](../../../docs/spec/javascript/lifecycle.rst)

<!-- prettier-ignore -->
> 整个话题及板事件分发栈内禁止推进或销毁同一板，以 ``INVALID_CALL_STATE`` 的 ``SimulationError`` 拒绝。封锁只限同板；板 A 的回调可以操作独立板 B，调用仍遵守 B 自身的守卫。守卫依次检查 context 或对象有效性、当前阶段与同板重入、所需板状态，最后检查参数；已销毁板的 ``dispose`` 优先无操作返回。宿主调用被拒绝本身不使板故障；该异常逸出器件回调时仍按器件故障处理，见 :doc:`host`。

## 验收义务

前提：ready 板的宿主话题监听器正在分发。

操作：监听器尝试销毁同板并捕获错误。

预期：以 INVALID_CALL_STATE 拒绝；适配对象尚未清理，板保持 ready。

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
let disposed = 0;
const reentry = [];
const { board } = await device(
  adapter,
  await adapter.compileDDL(modelSource),
  {
    dispose() {
      disposed++;
    },
  },
  description,
);
t.after(board.dispose.bind(board));
board.topics.onDidReceive(() => {
  try {
    board.dispose();
  } catch (error) {
    reentry.push(error.code);
  }
});
```

## 断言

```typescript
board.topics.publish('probe', null);
assert.deepEqual(reentry, ['INVALID_CALL_STATE']);
assert.equal(disposed, 0);
assert.equal(board.status, 'ready');
```
