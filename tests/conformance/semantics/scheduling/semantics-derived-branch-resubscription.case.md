---
kind: simulation
---

# Derived 观察随纯函数分支切换依赖

## 规范来源

[调度与片段边界](../../../../docs/spec/execution/scheduling.rst)。

## 验收义务

通过 pure 函数选择两个 state 之一，反复切换选择分支并分别修改当前及非当前分支。每个边界的 previous/current 必须来自当轮选择的最终值；非当前分支的修改不产生反应，切回后必须读到该分支最新值。切换前后数值相同时也必须更新依赖订阅，之后仅当前分支变化触发反应。固定 state 的直接观察与 derived 观察同时存在，并保持声明顺序。

## 模型

```ddl
device BranchObservation {
  state chooseLeft: bool = true;
  state left: number = 1;
  state right: number = 10;
  output channel out: number(capacity: 32);
  output channel direct: number(capacity: 16);
  pure fn selected() -> number {
    if chooseLeft { return left; }
    return right;
  }
  derived chosen: number = selected();
  reaction observe on chosen as (previous, current) {
    out.send(previous);
    out.send(current);
  }
  reaction observeLeft on left as (previous, current) { direct.send(current); }
  process start {
    left = 2;
    await ticks(0);
    right = 11;
    await ticks(0);
    chooseLeft = false;
    await ticks(0);
    left = 3;
    await ticks(0);
    right = 12;
    await ticks(0);
    chooseLeft = true;
    await ticks(0);
    left = 4;
    await ticks(0);
    right = 4;
    chooseLeft = false;
    await ticks(0);
    left = 5;
    await ticks(0);
    right = 5;
    await ticks(0);
    chooseLeft = true;
    await ticks(0);
    right = 6;
    await ticks(0);
    left = 6;
  }
}
```

## 装配

```json
{"instances":[{"id":"probe","type":"probe"}],"nets":[]}
```

## 执行步骤

```typescript
const { device, values } = await importModule('../fixture.mjs');
const { board, batches } = await device(adapter, await adapter.compileDDL(modelSource), {}, description);
t.after(() => board.dispose());
board.runUntil(0);
```

## 断言

```typescript
assert.deepEqual(values(batches), [1, 2, 2, 11, 11, 12, 12, 3, 3, 4, 4, 5, 5, 6]);
assert.deepEqual(values(batches, 'direct'), [2, 3, 4, 5, 6]);
assert.equal(board.status, 'ready');
```
