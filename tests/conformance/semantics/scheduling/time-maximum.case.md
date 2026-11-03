---
format: mica-case/v1
id: atomic-time-maximum
kind: simulation
---

# 最大时间戳保持精确

## 规范来源

[docs/spec/execution/index.rst](../../../../docs/spec/execution/index.rst)

<!-- prettier-ignore -->
> 时间戳表示相对起点的位置，时长表示两个位置之间的间隔。两者的合法范围均为 0 至 7_200_000_000_000_000 ps，包含端点。

## 验收义务

前提：启动过程等待规范允许的最大时长 7_200_000_000_000_000 ps，没有其他定时器。

操作：把仿真推进到时间范围的上端点。

预期：板时间与唯一输出值都精确等于 7_200_000_000_000_000，不因数值精度改变。

## 模型

<!-- prettier-ignore -->
```ddl
device Probe {
  output channel out: number(capacity: 8);

  process start { await ticks(7_200_000_000_000_000); out.send(now()); }
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
const { device, values } = await importModule('../fixture.mjs');
const { board, batches } = await device(
  adapter,
  await adapter.compileDDL(modelSource),
  {},
  description,
);
t.after(() => board.dispose());
board.runUntil(7_200_000_000_000_000);
```

## 断言

```typescript
assert.equal(board.time, 7_200_000_000_000_000);
assert.deepEqual(values(batches), [7_200_000_000_000_000]);
```
