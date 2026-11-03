---
kind: simulation
---

# 非整数偏移按原值拒绝且不改字节

## 规范来源

[docs/spec/memory.rst](../../../../docs/spec/memory.rst)

<!-- prettier-ignore -->
> 偏移以字节计，MUST 是非负安全整数。对于长度 ``N``、偏移 ``offset``、访问宽度 ``width``，完整访问范围须满足 ``offset <= N && width <= N - offset``。运行时按原值校验偏移，不对偏移隐式取整或回绕。

<!-- prettier-ignore -->
> 运行时 MUST 在写入前校验全部参数及完整范围；失败时，该次操作不修改任何目标字节。

## 验收义务

前提：2 字节公开存储先写入首字节 7；偏移来自可变 `state`，其值为 0.5，因此不是可静态折叠的字面量。

操作：通过真实 adapter 编译模型并推进到 0，捕获本次推进的错误。

预期：运行时按原值拒绝非整数偏移而不是取整为 0 或 1；本次推进失败，首字节仍为 7，后续写入不发生。合法非对齐整数偏移由 `atomic-memory-big-endian` 等用例覆盖，本条只否定非整数偏移。

## 模型

<!-- prettier-ignore -->
```ddl
device Probe {
  public memory data[2];
  state badOffset: number = 0.5;
  process start {
    store8(data, 0, 7);
    const value = load8(data, badOffset);
    store8(data, 1, value);
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
const { device, fault } = await importModule('../fixture.mjs');
const { board, context, batches } = await device(
  adapter,
  await adapter.compileDDL(modelSource),
  {},
  description,
);
t.after(board.dispose.bind(board));

fault(board, () => board.runUntil(0));
```

## 断言

```typescript
assert.deepEqual([...context.memory.data], [7, 0]);
assert.equal(batches.length, 0);
```
