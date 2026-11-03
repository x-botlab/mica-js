---
format: mica-case/v1
id: atomic-memory-write-no-partial
kind: simulation
---

# 跨尾部写入不产生部分修改

## 规范来源

[docs/spec/memory.rst](../../../../docs/spec/memory.rst)

<!-- prettier-ignore -->
> 每次读取或写入同步完成，自身不推进仿真时间。运行时 MUST 在写入前校验全部参数及完整范围；失败时，该次操作不修改任何目标字节。

## 验收义务

前提：2 字节公开 `memory` 先写入 [17, 34]，再从偏移 1 写入 16 位值 65535，该写入范围越过存储末尾。

操作：通过真实 adapter 编译模型，推进到 0 并捕获本次推进的错误。

预期：越界写入报告执行故障，两个公开字节精确保持 [17, 34]。

## 模型

<!-- prettier-ignore -->
```ddl
device Probe {
  output channel out: number(capacity: 8);
  public memory data[2];
  process start { store8(data, 0, 17); store8(data, 1, 34); store16le(data, 1, 65535); }
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
const { board, context } = await device(
  adapter,
  await adapter.compileDDL(modelSource),
  {},
  description,
);
t.after(() => board.dispose());
fault(board, () => board.runUntil(0));
```

## 断言

```typescript
assert.deepEqual([...context.memory.data], [17, 34]);
```
