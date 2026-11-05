---
kind: simulation
---

# 跨器件电气传播的全板捕获失败屏障

## 规范来源

[调度与捕获屏障](../../../../docs/spec/execution/scheduling.rst)、[故障](../../../../docs/spec/errors.rst)。

## 验收义务

发送器更新共享网络，同时触发两个接收器。较早接收器的捕获成功，较后接收器的捕获断言失败；两个接收器的反应体都不能执行，公开证据存储保持初值，板进入故障且不调用 sync。

## 模型

```ddl
device CaptureReceiver {
  pin input(low: 1, high: 2);
  state allowed: bool = false;
  public memory evidence[1];
  pure fn checked() -> number {
    assert allowed;
    return 7;
  }
  reaction receive on input.sample as (previous, current) capture saved = checked() {
    store8(evidence, 0, saved);
  }
}
```

## 装配

```json
{
  "instances": [
    {"id": "sender", "type": "sender"},
    {"id": "first", "type": "allowed"},
    {"id": "second", "type": "failing"}
  ],
  "nets": [
    {"id": "supply", "voltage": 3, "pins": [{"instance": "sender", "pin": "supply"}]},
    {"id": "ground", "voltage": 0, "pins": [{"instance": "sender", "pin": "ground"}]},
    {"id": "line", "pins": [
      {"instance": "sender", "pin": "output"},
      {"instance": "first", "pin": "input"},
      {"instance": "second", "pin": "input"}
    ]}
  ]
}
```

## 执行步骤

```typescript
const { fault } = await importModule('../fixture.mjs');
const contexts = new Map();
let syncs = 0;
const sender = await adapter.compileDDL(`device Sender {
  pin supply;
  pin ground;
  pin output = [resistor(to: ground, resistance: 1000)];
  process start { output.intent <- [resistor(to: supply, resistance: 1000)]; }
}`);
const failing = await adapter.compileDDL(modelSource);
const allowed = await adapter.compileDDL(modelSource.replace('state allowed: bool = false', 'state allowed: bool = true'));
const library = adapter.createDeviceLibrary([
  {id: 'sender', model: sender},
  {id: 'allowed', model: allowed},
  {id: 'failing', model: failing},
].map(({id, model}) => ({id, model, create(context) {
  contexts.set(id, context);
  return {sync() { syncs++; }, dispose() {}};
}})));
const board = adapter.createBoard(library, description);
t.after(() => board.dispose());
fault(board, () => board.runUntil(0));
```

## 断言

```typescript
assert.deepEqual([...contexts.get('allowed').memory.evidence], [0]);
assert.deepEqual([...contexts.get('failing').memory.evidence], [0]);
assert.equal(syncs, 0);
assert.equal(board.status, 'faulted');
```
