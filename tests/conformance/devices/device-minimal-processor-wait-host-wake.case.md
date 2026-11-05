---
kind: comparison
---

# 处理器 WAIT、改码与宿主异步唤醒

## 规范来源

[条件等待](../../../docs/spec/jit/interrupts.rst)、[代码存储](../../../docs/spec/jit/code-memory.rst)、[批次](../../../docs/spec/channels.rst)。

## 验收义务

处理器执行 WAIT 后，空闲话题回调修改代码不解除等待。宿主稍后的 Promise 回调发布 wake，只暂存通知；推进到同一目标处理普通模型通知，但不恢复 JIT。下一次更大目标才执行 ACK 和更新后的 LDI。异步发生在宿主，不向同步器件钩子返回 Promise。

## 对照输入

```json
{"replacement": 8}
```

## 执行步骤

```typescript
const { observedProcessor, processorFactory, processorCases } = await importModule('./processor-support.mjs');
const contexts = [], translations = [], disposed = [];
const library = adapter.createDeviceLibrary([{ id: 'processor', model: observedProcessor(adapter),
  create: processorFactory({ contexts, translations, disposed }) }]);
const board = adapter.createBoard(library, { instances: [{ id: 'cpu', type: 'processor',
  props: { firmware: processorCases.waitAndIrq } }], nets: [] });
t.after(() => board.dispose());
const evidence = contexts[0].memory.evidence;
board.runUntil(2);
assert.equal(evidence[0], 0);
assert.equal(evidence[1], 1);
board.topics.publish('processor/load', { bytes: new Uint8Array([inputs.replacement]), offset: 3 });
board.runUntil(10);
assert.equal(evidence[0], 0);
assert.deepEqual(translations.map(({ pc }) => pc), [0]);
await Promise.resolve().then(() => board.topics.publish('processor/wake', null));
assert.equal(evidence[5], 0);
board.runUntil(10);
assert.equal(evidence[5], 1);
assert.equal(evidence[0], 0);
assert.deepEqual(translations.map(({ pc }) => pc), [0]);
board.runUntil(11);
assert.equal(evidence[5], 0);
assert.equal(evidence[0], 0);
board.runUntil(12);
assert.equal(evidence[0], inputs.replacement);
board.runUntil(14);
```

## 断言

```typescript
assert.equal(evidence[0], inputs.replacement);
assert.equal(evidence[1], 5);
assert.deepEqual(translations.map(({ pc }) => pc), [0, 1, 4]);
assert.equal(board.status, 'ready');
board.dispose();
assert.equal(disposed.length, 1);
```
