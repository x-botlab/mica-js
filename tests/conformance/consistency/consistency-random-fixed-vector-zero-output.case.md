---
kind: simulation
---

# consistency-random-fixed-vector-zero-output

## 规范来源

[docs/spec/execution/random.rst](../../../docs/spec/execution/random.rst)

<!-- prettier-ignore -->
> 表内列出连续八次调用的整数输出 r；实际 number 结果逐项除以 4_294_967_296。状态分量与输出均以十进制表示。

[docs/spec/execution/random.rst](../../../docs/spec/execution/random.rst)

<!-- prettier-ignore -->
> * - [0, 0, 0, 1]
>   - 0, 0, 5760, 11802240, 2699105920, 137178368, 1670727104, 65994905

[docs/spec/execution/random.rst](../../../docs/spec/execution/random.rst)

<!-- prettier-ignore -->
> 实例的 ``randomState`` 如果给出，MUST 恰有四个符合本章要求的 uint32，且不能全零；它直接成为该实例初始状态，不再与主种子混合。

[docs/spec/execution/random.rst](../../../docs/spec/execution/random.rst)

<!-- prettier-ignore -->
> 一次调用恰好推进一次状态，不额外合并两个输出，也不跳过零输出。

## 验收义务

前提：实例以 randomState [0, 0, 0, 1] 覆盖初始状态，板 seed 为 4294967295；模型过程连续调用 random 八次并把结果发送到输出通道。

操作：创建真实板并推进到 0，读取输出通道的投递值。

预期：八次投递值逐项等于规范第三行固定整数向量除以 4294967296，均位于 [0, 1)，且零输出不被跳过。

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
      "randomState": [0, 0, 0, 1]
    }
  ],
  "nets": []
}
```

## 执行步骤

```typescript
const { library } = await importModule('./fixture.mjs');
const integers = [0, 0, 5760, 11802240, 2699105920, 137178368, 1670727104, 65994905];

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
