---
kind: simulation
---

# host-device-topic-failure-faults-before-event-without-rethrow

## 规范来源

[docs/spec/javascript/host.rst](../../../docs/spec/javascript/host.rst)

[docs/spec/errors.rst](../../../docs/spec/errors.rst)

## 验收义务

前提：两个器件话题监听器中首个抛错，首故障监听器尝试同板非法目标推进。

操作：宿主发布合法话题，随后在故障板上再次发布。

预期：首次发布正常返回且先观察 faulted，第二器件监听器不执行；事件内推进报 INVALID_CALL_STATE，新发布报 BOARD_FAULTED，首故障只发一次。

## 模型

<!-- prettier-ignore -->
```ddl
device HostProbe {}
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
const { device, diagnostic } = await importModule('./fixture.mjs');

const cause = new Error('topic failure');
const log = [];
const { board } = await device(
  adapter,
  await adapter.compileDDL(modelSource),
  {
    create(ctx) {
      ctx.topics.onDidReceive(() => {
        log.push('first');
        throw cause;
      });
      ctx.topics.onDidReceive(() => log.push('forbidden'));
    },
  },
  description,
);
t.after(board.dispose.bind(board));

const errors = [];
const nestedErrors = [];
board.onDidError((error) => {
  errors.push(error);
  log.push(board.status);
  try {
    board.runUntil('invalid');
  } catch (nestedError) {
    nestedErrors.push(nestedError.code);
  }
});
```

## 断言

```typescript
assert.doesNotThrow(() => board.topics.publish('topic', 7));
assert.deepEqual(log, ['first', 'faulted']);
assert.equal(errors.length, 1);
assert.deepEqual(nestedErrors, ['INVALID_CALL_STATE']);
assert.equal(errors[0].cause, cause);
assert.equal(errors[0].phase, 'topic');
assert.throws(() => board.topics.publish('topic', 8), diagnostic('BOARD_FAULTED'));
assert.equal(errors.length, 1);

board.dispose();
```
