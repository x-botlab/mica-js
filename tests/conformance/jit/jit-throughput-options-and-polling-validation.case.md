---
kind: comparison
---

# jit-throughput-options-and-polling-validation

## 规范来源

[吞吐执行与轮询声明](../../../docs/spec/jit/throughput.rst)

[宿主合同](../../../docs/spec/javascript/host.rst)

## 验收义务

板默认使用吞吐模式，精确模式忽略轮询快进声明。时间量子为 1 到 10000000 的整数皮秒，省略取默认值，显式非法值与未知字段拒绝。轮询声明绑定本实例无参 bool 纯函数，PC 有限且互异，配置按值捕获。

## 对照输入

```json
{
  "model": "device Probe {\n  public memory code[2];\n  state pc: number = 0;\n  output channel out: number(capacity: 8);\n  pure fn awake(): bool { return false; }\n  pure fn value(): number { return 1; }\n  pure fn needs(argument: number): bool { return argument > 0; }\n  fn impure(): bool { pc = 1; return true; }\n  fn emit() { out.send(1); }\n}",
  "description": { "instances": [{ "id": "jit", "type": "jit" }], "nets": [] }
}
```

## 执行步骤

```typescript
const { setup } = await importModule('./fixture.mjs');
const model = await adapter.compileDDL(inputs.model);
const translate = (input, builder) => {
  builder.instruction({ pc: input.pc, nextPc: input.pc + 1 }, (body) => {
    body.call('emit'); body.stop();
  });
  return builder.finish();
};
const base = { entry: 'cpu', code: 'code', pc: 'pc', translate };
for (const options of [
  { execution: undefined }, { execution: null }, { execution: 'fast' },
  { cpuQuantum: undefined }, { cpuQuantum: null }, { cpuQuantum: 0 },
  { cpuQuantum: -1 }, { cpuQuantum: 0.5 }, { cpuQuantum: 10000001 },
  { cpuQuantum: Infinity }, { cpuQuantum: NaN }, { cpuQuantum: '10' },
  { execution: 'precise', cpuQuantum: 0 }, { unexpected: true },
]) {
  await assert.rejects(() => setup(adapter, model, () => {}, inputs.description, options));
}
for (const polling of [
  undefined, null, {}, [null], [{ pc: Infinity, predicate: 'awake' }],
  [{ pc: NaN, predicate: 'awake' }], [{ pc: 0, predicate: 'missing' }],
  [{ pc: 0, predicate: 'value' }], [{ pc: 0, predicate: 'needs' }],
  [{ pc: 0, predicate: 'impure' }], [{ pc: 0, predicate: 'pc' }],
  [{ pc: 0, predicate: 'awake', extra: 1 }],
  [{ pc: 0, predicate: 'awake' }, { pc: -0, predicate: 'awake' }],
]) {
  await assert.rejects(() => setup(adapter, model,
    (ctx) => ctx.attachJit({ ...base, polling }), inputs.description));
}
const messages = [];
for (const options of [{}, { execution: 'throughput', cpuQuantum: 1 },
                       { execution: 'precise', cpuQuantum: 10000000 }]) {
  const polling = [{ pc: 0, predicate: 'awake' }];
  const { board, batches } = await setup(adapter, model,
    (ctx) => ctx.attachJit({ ...base, polling }), inputs.description, options);
  t.after(board.dispose.bind(board));
  polling[0].pc = 1;
  polling[0].predicate = 'missing';
  polling.push({ pc: 2, predicate: 'missing' });
  board.runUntil(100);
  messages.push(batches.flatMap((batch) => batch.outputs.out));
}
const hookModel = await adapter.compileDDL(inputs.model
  .replace('  state pc: number = 0;', '  state irq: bool = true;\n  state pc: number = 0;')
  .replace('  fn emit()', '  fn ack() { irq = false; out.send(77); }\n  fn emit()'));
const acknowledged = await setup(adapter, hookModel, (ctx) => ctx.attachJit({
  ...base,
  beforeInstruction: { when: 'irq', call: 'ack' },
  polling: [{ pc: 0, predicate: 'awake' }],
}), inputs.description);
t.after(acknowledged.board.dispose.bind(acknowledged.board));
acknowledged.board.runUntil(100);
```

## 断言

```typescript
assert.deepEqual(messages, [[], [], [{ time: 0, value: 1 }]]);
assert.deepEqual(acknowledged.batches.flatMap((batch) => batch.outputs.out), [
  { time: 0, value: 77 },
]);
```
