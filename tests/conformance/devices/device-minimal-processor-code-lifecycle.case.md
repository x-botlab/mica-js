---
kind: comparison
---

# 处理器实际指令、改码与销毁

## 规范来源

[JIT 指令](../../../docs/spec/jit/execution.rst)、[代码存储](../../../docs/spec/jit/code-memory.rst)、[生命周期](../../../docs/spec/javascript/lifecycle.rst)。

## 验收义务

用真实 Builder/TypeFactory 构造已有 minimal-processor，通过既有配对适配器装载 firmware 并执行真实译码器。仅增加写入公开 evidence 存储的观察 reaction，不替代处理器执行。覆盖算术、8 位溢出、暂停期间失效旧后缀、自修改代码、同值代码写入、地址回绕、HALT 不被装载重启，以及旧 context 失效和独立重建。

## 对照输入

```json
{"arithmetic": [16, 250, 17, 10, 255]}
```

## 执行步骤

```typescript
const { observedProcessor, processorFactory, processorCases } = await importModule('./processor-support.mjs');
const model = observedProcessor(adapter);
function setup(firmware) {
  const contexts = [], translations = [], disposed = [];
  const library = adapter.createDeviceLibrary([{ id: 'processor', model,
    create: processorFactory({ contexts, translations, disposed }) }]);
  const board = adapter.createBoard(library, { instances: [{ id: 'cpu', type: 'processor',
    props: { firmware } }], nets: [] });
  t.after(() => board.dispose());
  const context = contexts[0];
  return { board, context, translations, disposed, evidence: context.memory.evidence };
}
const arithmetic = setup(new Uint8Array(inputs.arithmetic));
arithmetic.board.runUntil(1);
assert.equal(arithmetic.evidence[0], 250);
arithmetic.board.runUntil(3);
assert.equal(arithmetic.evidence[0], 4);
arithmetic.board.runUntil(6);
assert.equal(arithmetic.evidence[1], 5);
const translationCount = arithmetic.translations.length;
arithmetic.board.topics.publish('processor/load', { bytes: new Uint8Array([16, 99]), offset: 5 });
arithmetic.board.runUntil(20);
assert.equal(arithmetic.evidence[0], 4);
assert.equal(arithmetic.translations.length, translationCount);

const invalidated = setup(processorCases.invalidateSuffix);
invalidated.board.runUntil(1);
assert.equal(invalidated.evidence[0], 1);
invalidated.board.topics.publish('processor/load', { bytes: new Uint8Array([255]), offset: 2 });
invalidated.board.runUntil(2);
assert.equal(invalidated.evidence[0], 1);
invalidated.board.runUntil(3);
assert.equal(invalidated.evidence[0], 1);
assert.equal(invalidated.evidence[1], 3);
assert.deepEqual(invalidated.translations.map(({ pc }) => pc), [0, 2]);

const selfModify = setup(processorCases.selfModify);
selfModify.board.runUntil(3);
assert.equal(selfModify.evidence[1], 4);
const sameByte = setup(processorCases.sameByteWrite);
sameByte.board.runUntil(4);
assert.equal(sameByte.evidence[1], 5);

const wrapped = setup(processorCases.wrapFetch);
wrapped.board.topics.publish('processor/load', { bytes: new Uint8Array([16]), offset: 255 });
wrapped.board.runUntil(1);
wrapped.board.topics.publish('processor/load', { bytes: new Uint8Array([42, 255]), offset: 0 });
wrapped.board.runUntil(5);
```

## 断言

```typescript
assert.equal(wrapped.evidence[0], 42);
assert.equal(wrapped.evidence[1], 2);
assert.deepEqual(wrapped.translations.map(({ pc }) => pc), [0, 255]);
const retained = arithmetic.evidence.slice();
arithmetic.board.dispose();
arithmetic.board.dispose();
assert.equal(arithmetic.disposed.length, 1);
assert.throws(() => arithmetic.evidence[0], (error) => error.code === 'OBJECT_DISPOSED');
assert.throws(() => arithmetic.context.inputs.wake.notify(),
  (error) => error.code === 'OBJECT_DISPOSED');
const recreated = setup(new Uint8Array([16, 7, 255]));
recreated.board.runUntil(3);
assert.equal(recreated.evidence[0], 7);
assert.equal(retained[0], 4);
assert.equal(recreated.board.status, 'ready');
```
