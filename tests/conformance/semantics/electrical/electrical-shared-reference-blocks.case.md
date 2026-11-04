---
kind: simulation
---

# 共享理想参考的独立支路、耦合与浮空

## 规范来源

[电气求解](../../../../docs/spec/electrical.rst)、[边界发布](../../../../docs/spec/execution/scheduling.rst)。

## 验收义务

两个分压器共享 4V/0V 理想参考，独立时为 1V/3V。接入 1kΩ 桥后必须真实耦合为 1.6V/2.4V；拆桥恢复原值。依次移除参考路径后，保留电阻连接的两节点必须同时浮空；恢复后重新得到 1V/3V。只读公开输出，独立闭式预期不依赖求解器实现。另有 7 条共享参考的固定分压支路，使接桥前后都覆盖较大物理分量的计算块合并与拆分；初始即浮空的另外一对节点始终保持浮空。

## 模型

```ddl
device SharedReference {
  pin supply;
  pin reference;
  pin a = [resistor(to: supply, resistance: 3000), resistor(to: reference, resistance: 1000)];
  pin b = [resistor(to: supply, resistance: 1000), resistor(to: reference, resistance: 3000)];
  pin e0 = [resistor(to: supply, resistance: 1000), resistor(to: reference, resistance: 1000), resistor(to: e1, resistance: 1000)];
  pin e1 = [resistor(to: supply, resistance: 1000), resistor(to: reference, resistance: 1000)];
  pin e2 = [resistor(to: supply, resistance: 1000), resistor(to: reference, resistance: 1000)];
  pin e3 = [resistor(to: supply, resistance: 1000), resistor(to: reference, resistance: 1000)];
  pin e4 = [resistor(to: supply, resistance: 1000), resistor(to: reference, resistance: 1000)];
  pin e5 = [resistor(to: supply, resistance: 1000), resistor(to: reference, resistance: 1000)];
  pin e6 = [resistor(to: supply, resistance: 1000), resistor(to: reference, resistance: 1000)];
  pin c = [resistor(to: d, resistance: 1000)];
  pin d;
  input channel command: number(capacity: 1);
  record Reading { index: number; voltage: number; known: bool; }
  output channel readings: Reading(capacity: 64);
  fn emit(index: number, raw: sample) {
    const voltage = raw.voltage;
    let value = 0;
    if voltage != none { value = voltage; }
    readings.send({ index: index, voltage: value, known: voltage != none });
  }
  process start {
    emit(0, a.sample); emit(1, b.sample); emit(2, c.sample); emit(3, d.sample);
    loop {
      const mode = await command.receive();
      if mode == 1 {
        a.intent <- [resistor(to: supply, resistance: 3000), resistor(to: reference, resistance: 1000), resistor(to: b, resistance: 1000)];
      } else if mode == 2 {
        a.intent <- [resistor(to: supply, resistance: 3000), resistor(to: reference, resistance: 1000)];
      } else if mode == 3 {
        a.intent <- [resistor(to: b, resistance: 1000)];
      } else if mode == 4 {
        b.intent <- [];
      } else {
        a.intent <- [resistor(to: supply, resistance: 3000), resistor(to: reference, resistance: 1000)];
        b.intent <- [resistor(to: supply, resistance: 1000), resistor(to: reference, resistance: 3000)];
      }
    }
  }
  reaction changedA on a.sample as (previous, current) { emit(0, current); }
  reaction changedB on b.sample as (previous, current) { emit(1, current); }
  reaction changedC on c.sample as (previous, current) { emit(2, current); }
  reaction changedD on d.sample as (previous, current) { emit(3, current); }
}
```

## 装配

```json
{"instances":[{"id":"dut","type":"dut"}],"nets":[
  {"id":"supply","voltage":4,"pins":[{"instance":"dut","pin":"supply"}]},
  {"id":"reference","voltage":0,"pins":[{"instance":"dut","pin":"reference"}]}
]}
```

## 执行步骤

```typescript
let context;
const latest = new Map();
const library = adapter.createDeviceLibrary([{
  id: 'dut', model: await adapter.compileDDL(modelSource),
  create(ctx) {
    context = ctx;
    return { sync(batch) {
      for (const message of batch.outputs.readings) latest.set(message.value.index, message.value);
    }, dispose() {} };
  },
}]);
const board = adapter.createBoard(library, description);
t.after(() => board.dispose());
function check(expected) {
  for (const [index, value] of expected.entries()) {
    const actual = latest.get(index);
    assert.ok(actual);
    assert.equal(actual.known, value !== null);
    if (value !== null) assert.ok(Math.abs(actual.voltage - value) <= 1e-12);
  }
  for (const index of [2, 3]) assert.equal(latest.get(index).known, false);
  assert.equal(board.status, 'ready');
}
board.runUntil(0);
check([1, 3]);
```

## 断言

```typescript
for (const [index, expected] of [[1.6, 2.4], [1, 3], [3, 3], [null, null], [1, 3]].entries()) {
  context.inputs.command.send(index + 1);
  board.runUntil(index + 1);
  check(expected);
}
board.dispose();
assert.equal(board.status, 'disposed');
```
