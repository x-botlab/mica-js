---
kind: simulation
---

# consistency-random-fixed-vector-ordinary

## 规范来源

[docs/spec/execution/random.rst](../../../docs/spec/execution/random.rst)

<!-- prettier-ignore -->
> 表内列出连续八次调用的整数输出 r；实际 number 结果逐项除以 4_294_967_296。状态分量与输出均以十进制表示。

[docs/spec/execution/random.rst](../../../docs/spec/execution/random.rst)

<!-- prettier-ignore -->
> * - [1, 2, 3, 4]
>   - 11520, 0, 5927040, 70819200, 2031721883, 1637235492, 1287239034, 3734860849

[docs/spec/execution/random.rst](../../../docs/spec/execution/random.rst)

<!-- prettier-ignore -->
> 显式覆盖 ``randomState: [1, 2, 3, 4]`` 时，任意合法主种子和实例 ID 都使用本章第一组 xoshiro128** 输出向量，而不是使用上述派生状态。

## 验收义务

前提：实例以 randomState [1, 2, 3, 4] 覆盖初始状态，板 seed 为 4294967295；模型过程连续调用 random 八次并把结果发送到输出通道。

操作：创建真实板并推进到 0，读取输出通道的投递值。

预期：八次投递值逐项等于规范第一行固定整数向量除以 4294967296，均位于 [0, 1)；显式状态不与板 seed 混合。

## 模型

<!-- prettier-ignore -->
```ddl
device RandomProbe {
  output channel out: number(capacity: 16);
  process start {
    let i: number = 0;
    while i < 8 {
      out.send(random());
      i = i + 1;
    }
  }
}
```

## 装配

```json
{
  "instances": [
    {
      "id": "node",
      "type": "random",
      "randomState": [1, 2, 3, 4]
    }
  ],
  "nets": []
}
```

## 执行步骤

```typescript
const { library } = await importModule('./fixture.mjs');
const integers = [11520, 0, 5927040, 70819200, 2031721883, 1637235492, 1287239034, 3734860849];

const probe = await library(adapter, await adapter.compileDDL(modelSource));
const board = probe.create(description.instances, { seed: 4294967295 });
t.after(board.dispose.bind(board));

board.runUntil(0);
```

## 断言

```typescript
assert.deepEqual(
  probe.delivered.get('node'),
  integers.map((value) => value / 4294967296),
);
assert.ok(probe.delivered.get('node').every((value) => value >= 0 && value < 1));

board.dispose();
```
