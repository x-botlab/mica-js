---
format: mica-case/v1
id: semantics-start-sees-injected-input-before-notification-process
kind: simulation
---

# semantics-start-sees-injected-input-before-notification-process

## 规范来源

[docs/spec/execution/scheduling.rst](../../../../docs/spec/execution/scheduling.rst)

## 验收义务

前提：暂存数字11和wake通知，另有未变化的state观察过程。

操作：首次推进至0。

预期：输出[11,20]，start消费输入先于通知过程，未变化观察过程不输出。

## 模型

<!-- prettier-ignore -->
```ddl
device SemanticProbe {
        input channel incoming: number(capacity: 2);
        input notification wake;
        output channel out: number(capacity: 8);
        state x: number = 7;
        process observe on x { out.send(99); }
        process notified on wake { out.send(20); }
        process start { let n = await incoming.receive(); out.send(n); }
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
  {
    create(ctx) {
      ctx.inputs.incoming.send(11);
      ctx.inputs.wake.notify();
    },
  },
  description,
);
t.after(board.dispose.bind(board));

assert.equal(batches.length, 0);
board.runUntil(0);
```

## 断言

```typescript
assert.deepEqual(values(batches), [11, 20]);

board.dispose();
```
