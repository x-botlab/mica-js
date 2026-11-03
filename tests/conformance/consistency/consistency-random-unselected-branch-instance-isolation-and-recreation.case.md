---
kind: comparison
---

# consistency-random-unselected-branch-instance-isolation-and-recreation

## 规范来源

[docs/spec/execution/random.rst](../../../docs/spec/execution/random.rst)

[docs/spec/language/statements.rst](../../../docs/spec/language/statements.rst)

## 验收义务

前提：模型含 `if false` 中的 `random()` 调用、等待和两个实例；另以等价描述重建板。

操作：比较未选中分支路径与基线路径，交错推进两个实例；随后重建等价配置并再次推进。

预期：未选中分支不消耗随机流；两个实例的流互不影响；重建从相同初始流重现；JIT 重编译部分不受影响。

## 对照输入

```json
{
  "models": {
    "randomProbe": "device RandomProbe {\n  output channel out: number(capacity: 16);\n  process start {\n    if false {\n      out.send(random());\n    }\n    out.send(random());\n    await ticks(1);\n    out.send(random());\n  }\n}"
  }
}
```

## 执行步骤

```typescript
const { library } = await importModule('./fixture.mjs');

const probe = await library(adapter, await adapter.compileDDL(inputs.models.randomProbe));
for (let round = 0; round < 2; round++) {
  probe.delivered.clear();
  const board = probe.create([
    { id: 'a', randomState: [1, 2, 3, 4] },
    { id: 'b', randomState: [1, 2, 3, 4] },
  ]);
  try {
    board.runUntil(0);
    assert.deepEqual(probe.delivered.get('a'), [11520 / 4294967296]);
    assert.deepEqual(probe.delivered.get('b'), [11520 / 4294967296]);
    board.runUntil(1);
    assert.deepEqual(probe.delivered.get('a'), [11520 / 4294967296, 0]);
    assert.deepEqual(probe.delivered.get('b'), [11520 / 4294967296, 0]);
  } finally {
    board.dispose();
  }
}
```

## 断言

```typescript
assert.deepEqual(
  [...probe.delivered.entries()],
  [
    ['a', [11520 / 4294967296, 0]],
    ['b', [11520 / 4294967296, 0]],
  ],
);
```
