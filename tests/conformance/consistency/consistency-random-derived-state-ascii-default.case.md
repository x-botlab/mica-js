---
format: mica-case/v1
id: consistency-random-derived-state-ascii-default
kind: comparison
---

# consistency-random-derived-state-ascii-default

## 规范来源

[docs/spec/execution/random.rst](../../../docs/spec/execution/random.rst)

## 验收义务

前提：板 seed 为 0，实例 ID 为 `node`；模型在启动过程连续调用 `random()` 八次并发送结果。

操作：分别以未覆盖状态的派生流和显式四字状态流建立板，推进到 0，比较八次输出；再重排实例顺序重复一次。

预期：派生流与显式四字状态流逐项相等；重排实例不改变该实例的结果。

## 对照输入

```json
{
  "models": {
    "randomProbe": "device RandomProbe {\n    output channel out: number(capacity: 16); process start {\n  let i: number = 0;\n  while i < 8 { out.send(random()); i = i + 1; }\n}\n  }"
  },
  "parameters": {
    "label": "ascii-default",
    "id": "node",
    "seed": 0,
    "state": [707525232, 509745386, 1308297789, 731779076]
  }
}
```

## 执行步骤

```typescript
const { library } = await importModule('./fixture.mjs');
const { label, id, seed, state } = inputs.parameters;

const probe = await library(adapter, await adapter.compileDDL(inputs.models.randomProbe));
let board = probe.create([{ id }, { id: 'explicit', randomState: state }], { seed });
const expected = [
  2670760867, 963817264, 528299477, 3364408969, 1082480006, 1967984333, 115247405, 579795310,
].map((value) => value / 4294967296);
t.after(board.dispose.bind(board));

board.runUntil(0);
assert.deepEqual(probe.delivered.get('explicit'), expected);
assert.equal(expected.length, 8);
assert.deepEqual(probe.delivered.get(id), expected);

board.dispose();

probe.delivered.clear();
board = probe.create([{ id: 'explicit', randomState: state }, { id }], { seed });
t.after(board.dispose.bind(board));

board.runUntil(0);
```

## 断言

```typescript
assert.deepEqual(probe.delivered.get(id), expected);
assert.deepEqual(probe.delivered.get('explicit'), expected);

board.dispose();
```
