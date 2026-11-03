---
format: mica-case/v1
id: consistency-random-derived-state-utf8
kind: comparison
---

# consistency-random-derived-state-utf8

## 规范来源

[docs/spec/execution/random.rst](../../../docs/spec/execution/random.rst)

## 验收义务

前提：板 seed 为 0，实例 ID 为 `节点`；模型在启动过程连续调用 `random()` 八次并发送结果。

操作：按 UTF-8 派生状态与显式四字状态建立两条路径，推进到 0，比较输出。

预期：两条路径的八次结果逐项相等；未配对代理项按 U+FFFD 替换，不做 Unicode 规范化。

## 对照输入

```json
{
  "models": {
    "randomProbe": "device RandomProbe {\n    output channel out: number(capacity: 16); process start {\n  let i: number = 0;\n  while i < 8 { out.send(random()); i = i + 1; }\n}\n  }"
  },
  "parameters": {
    "label": "utf8",
    "id": "节点",
    "seed": 0,
    "state": [3809353869, 4108939103, 3288804777, 4173018801]
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
  2219433220, 950521881, 4131998255, 1005164961, 1318886308, 2619859052, 1982881648, 2844669246,
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
