---
format: mica-case/v1
id: host-topic-registration-snapshot-and-synchronous-nesting
kind: simulation
---

# host-topic-registration-snapshot-and-synchronous-nesting

## 规范来源

[docs/spec/javascript/host.rst](../../../docs/spec/javascript/host.rst)

## 验收义务

前提：首监听器在外层发布时释放第二监听器、增加第三监听器，并嵌套发布另一负载。

操作：执行一次外层 publish 并记录回调顺序和负载引用。

预期：嵌套分发只含首、第三监听器，外层快照仍调用第二监听器；外层 payload 保持原引用，板保持 ready。

## 模型

<!-- prettier-ignore -->
```ddl
device HostProbe {  }
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
const { device } = await importModule('./fixture.mjs');

const { board } = await device(adapter, await adapter.compileDDL(modelSource), {}, description);
t.after(board.dispose.bind(board));

const log = [];
const outer = { label: 'outer' };
const nested = { label: 'nested' };
const payloads = [];
let second;
board.topics.onDidReceive((message) => {
  log.push(`first:${message.payload.label}`);
  if (message.payload === outer) {
    second.dispose();
    board.topics.onDidReceive((inner) => log.push(`third:${inner.payload.label}`));
    board.topics.publish('topic', nested);
  }
});
second = board.topics.onDidReceive((message) => {
  payloads.push(message.payload);
  log.push(`second:${message.payload.label}`);
});
board.topics.publish('topic', outer);
```

## 断言

```typescript
assert.deepEqual(log, ['first:outer', 'first:nested', 'third:nested', 'second:outer']);
assert.equal(payloads.length, 1);
assert.equal(payloads[0], outer);
assert.equal(board.status, 'ready');

board.dispose();
```
