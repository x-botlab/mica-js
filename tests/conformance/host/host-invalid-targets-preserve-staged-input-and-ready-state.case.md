---
kind: simulation
---

# host-invalid-targets-preserve-staged-input-and-ready-state

## 规范来源

[docs/spec/javascript/host.rst](../../../docs/spec/javascript/host.rst)

## 验收义务

前提：ready 板暂存一个输入 7，尚未 sync。

操作：分别传入错误类型、非有限或非整数、负数、越界目标；合法推进后再传入早于当前时间的目标。

预期：按断言抛 TypeError 或 RangeError，被拒调用不推进、不故障、不消费暂存输入；首次合法推进仍输出 7。

## 模型

<!-- prettier-ignore -->
```ddl
device HostProbe {
  input channel incoming: number(capacity: 2);
  output channel out: number(capacity: 2);
  process start {
    let n = await incoming.receive();
    out.send(n);
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
const { device, values } = await importModule('./fixture.mjs');

const { board, context, batches } = await device(
  adapter,
  await adapter.compileDDL(modelSource),
  {},
  description,
);
t.after(board.dispose.bind(board));

const errors = [];
board.onDidError((error) => errors.push(error));
context.inputs.incoming.send(7);
for (const target of ['1', NaN, Infinity, 0.5]) {
  assert.throws(() => board.runUntil(target), TypeError);
}
for (const target of [-1, 7_200_000_000_000_001]) {
  assert.throws(() => board.runUntil(target), RangeError);
}
assert.equal(board.time, 0);
assert.equal(board.status, 'ready');
assert.equal(batches.length, 0);
assert.equal(errors.length, 0);
board.runUntil(2);
```

## 断言

```typescript
assert.deepEqual(values(batches), [7]);
assert.throws(() => board.runUntil(1), RangeError);
assert.equal(board.time, 2);
assert.equal(board.status, 'ready');
assert.equal(errors.length, 0);

board.dispose();
```
