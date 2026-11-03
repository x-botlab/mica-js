---
format: mica-case/v1
id: atomic-time-unsafe-target
kind: simulation
---

# 非安全整数目标被拒绝且板不变

## 规范来源

[docs/spec/execution/index.rst](../../../../docs/spec/execution/index.rst)

<!-- prettier-ignore -->
> 仿真执行中的未捕获时间错误遵循 :doc:`/errors` 的整板故障规则。宿主推进调用先检查对象有效性、当前阶段与同板重入、所需板状态，通过后才校验目标；非法目标抛 TypeError 或 RangeError。拒绝该调用本身不改变板状态；若异常逸出器件回调，则按该回调的未捕获异常处理，见 :doc:`/javascript/host`。

## 验收义务

前提：已创建一块尚未推进的板，当前仿真时间为 0。

操作：调用 `runUntil(Number.MAX_SAFE_INTEGER + 1)`，该目标不是安全整数且超出合法时间戳范围。

预期：调用抛出 `RangeError`；板时间仍为 0、状态仍为 `ready`，且没有交付批次。

## 模型

<!-- prettier-ignore -->
```ddl
device Probe {
  output channel out: number(capacity: 8);

  process start { out.send(1); }
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
const { device } = await importModule('../fixture.mjs');
const { board, batches } = await device(
  adapter,
  await adapter.compileDDL(modelSource),
  {},
  description,
);
t.after(() => board.dispose());
assert.throws(() => board.runUntil(Number.MAX_SAFE_INTEGER + 1), RangeError);
```

## 断言

```typescript
assert.equal(board.time, 0);
assert.equal(board.status, 'ready');
assert.equal(batches.length, 0);
```
