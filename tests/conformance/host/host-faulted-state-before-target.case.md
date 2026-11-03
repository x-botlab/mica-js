---
format: mica-case/v1
id: host-faulted-state-before-target
kind: simulation
---

# host-faulted-state-before-target

## 规范来源

[docs/spec/javascript/host.rst](../../../docs/spec/javascript/host.rst)

<!-- prettier-ignore -->
> 运行时 MUST 在调用副作用发生前按以下顺序检查：对象或 context 有效性；当前调用阶段及同板重入；操作需要的板状态；参数类型、数值范围及资源绑定。已销毁板的 dispose 先按幂等规则正常返回，reportError 按下文的失效兜底规则处理，其余操作调用优先报告 OBJECT_DISPOSED。因此 disposedBoard.runUntil(NaN) 不报告时间类型错误，onDidError 回调内对同板 runUntil('x') 优先报告 INVALID_CALL_STATE。故障板在空闲阶段推进报告 BOARD_FAULTED。被拒绝调用本身不改变板状态；异常逸出器件回调时仍按该回调的未捕获异常处理。

## 验收义务

前提：有效 context 已上报错误，诊断分发已返回，板处于 faulted。

操作：空闲阶段调用 runUntil(NaN)。

预期：以 BOARD_FAULTED 拒绝，优先于目标类型校验；板保持 faulted，未产生 sync 交付。

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
const { board, context, batches } = await device(
  adapter,
  await adapter.compileDDL(modelSource),
  {},
  description,
);
t.after(board.dispose.bind(board));
context.reportError(new Error('fault'));
```

## 断言

```typescript
assert.throws(() => board.runUntil(NaN), diagnostic('BOARD_FAULTED'));
assert.equal(board.status, 'faulted');
assert.equal(batches.length, 0);
```
