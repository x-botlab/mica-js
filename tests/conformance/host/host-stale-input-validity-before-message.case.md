---
format: mica-case/v1
id: host-stale-input-validity-before-message
kind: simulation
---

# host-stale-input-validity-before-message

## 规范来源

[docs/spec/javascript/host.rst](../../../docs/spec/javascript/host.rst)

<!-- prettier-ignore -->
> 运行时 MUST 在调用副作用发生前按以下顺序检查：对象或 context 有效性；当前调用阶段及同板重入；操作需要的板状态；参数类型、数值范围及资源绑定。已销毁板的 dispose 先按幂等规则正常返回，reportError 按下文的失效兜底规则处理，其余操作调用优先报告 OBJECT_DISPOSED。因此 disposedBoard.runUntil(NaN) 不报告时间类型错误，onDidError 回调内对同板 runUntil('x') 优先报告 INVALID_CALL_STATE。故障板在空闲阶段推进报告 BOARD_FAULTED。被拒绝调用本身不改变板状态；异常逸出器件回调时仍按该回调的未捕获异常处理。

[docs/spec/javascript/host.rst](../../../docs/spec/javascript/host.rst)

<!-- prettier-ignore -->
> 旧 context 的有效身份不会因为实例 ID 相同而指向新板。

## 验收义务

前提：旧板已销毁，新板复用相同实例 ID；保留旧输入端点。

操作：旧端点发送非法字符串；新端点发送 7 并推进新板。

预期：旧发送以 OBJECT_DISPOSED 拒绝，不进入消息类型校验；新板只交付 7 且保持 ready。

## 模型

```ddl
device HostProbe {
  input channel incoming: number(capacity: 2);
  output channel out: number(capacity: 2);
  process start { let n = await incoming.receive(); out.send(n); }
}
```

## 装配

```json
{ "instances": [{ "id": "probe", "type": "probe" }], "nets": [] }
```

## 执行步骤

```typescript
const { device, diagnostic, values } = await importModule('./fixture.mjs');
const model = await adapter.compileDDL(modelSource);
const old = await device(adapter, model, {}, description);
t.after(old.board.dispose.bind(old.board));
const endpoint = old.context.inputs.incoming;
old.board.dispose();
const fresh = await device(adapter, model, {}, description);
t.after(fresh.board.dispose.bind(fresh.board));
```

## 断言

```typescript
assert.throws(() => endpoint.send('invalid'), diagnostic('OBJECT_DISPOSED'));
fresh.context.inputs.incoming.send(7);
fresh.board.runUntil(0);
assert.deepEqual(values(fresh.batches), [7]);
assert.equal(fresh.board.status, 'ready');
```
