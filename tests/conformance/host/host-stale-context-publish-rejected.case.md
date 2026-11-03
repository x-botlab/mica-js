---
kind: simulation
---

# 销毁后的旧 context 发布被拒且不污染新板

## 规范来源

[docs/spec/javascript/host.rst](../../../docs/spec/javascript/host.rst)

<!-- prettier-ignore -->
> 运行时 MUST 在调用副作用发生前按以下顺序检查：对象或 context 有效性；当前调用阶段及同板重入；操作需要的板状态；参数类型、数值范围及资源绑定。已销毁板的 dispose 先按幂等规则正常返回，reportError 按下文的失效兜底规则处理，其余操作调用优先报告 OBJECT_DISPOSED。

<!-- prettier-ignore -->
> 已销毁、已故障、重入、非法阶段或绑定错误用带固定 code 的 ``SimulationError``。

<!-- prettier-ignore -->
> INVALID_CALL_STATE / OBJECT_DISPOSED / BOARD_FAULTED / INVALID_BINDING | 非法阶段或重入、失效对象、故障板调用、资源绑定错误。

[docs/spec/errors.rst](../../../docs/spec/errors.rst)

<!-- prettier-ignore -->
> 失效 context 的其他副作用调用仍被拒绝。

[docs/spec/conformance.rst](../../../docs/spec/conformance.rst)

<!-- prettier-ignore -->
> 旧板销毁后，旧 context 发送、发布、装载或 reportError；新板使用相同实例 ID 正常运行。 | 旧副作用拒绝，reportError 正常返回且仅过期诊断；新板时间、状态、种子、订阅和缓存均不被污染。

## 验收义务

前提：旧板已销毁，新板以相同实例 ID 与相同模型重新创建，并在宿主侧登记一个话题监听器。

操作：旧 context 发布话题，随后在新板上发布话题、推进到 3 并读取输出。

预期：publish 属于所属板失效时被拒绝的副作用调用，按守卫顺序先检查 context 有效性，因此以带固定 code 的 `SimulationError` 报告失效对象——该类别在固定码表中只有 OBJECT_DISPOSED。断言主诊断码与抛出的 `code` 一致；新板只收到自己的发布负载，交付 [7]、时间为 3，状态保持 `ready`，订阅不被旧板操作影响。

## 模型

<!-- prettier-ignore -->
```ddl
device HostProbe {
  output channel out: number(capacity: 2);
  process start {
    out.send(7);
  }
}
```

## 装配

```json
{
  "instances": [
    {
      "id": "probe",
      "type": "probe"
    }
  ],
  "nets": []
}
```

## 执行步骤

```typescript
const { device, diagnostic, values } = await importModule('./fixture.mjs');
const model = await adapter.compileDDL(modelSource);
const old = await device(adapter, model, {}, description);
t.after(old.board.dispose.bind(old.board));
old.board.dispose();

const fresh = await device(adapter, model, {}, description);
t.after(fresh.board.dispose.bind(fresh.board));
const received = [];
fresh.board.topics.onDidReceive((message) => received.push(message.payload));
```

## 断言

```typescript
assert.throws(
  () => old.context.topics.publish('topic', 1),
  (error) => {
    assert.ok(diagnostic('OBJECT_DISPOSED')(error));
    assert.equal(error.diagnostic.code, 'OBJECT_DISPOSED');
    return true;
  },
);

fresh.board.topics.publish('topic', 2);
assert.deepEqual(received, [2]);
fresh.board.runUntil(3);
assert.deepEqual(values(fresh.batches), [7]);
assert.equal(fresh.board.time, 3);
assert.equal(fresh.board.status, 'ready');
```
