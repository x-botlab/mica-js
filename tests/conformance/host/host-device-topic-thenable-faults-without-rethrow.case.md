---
kind: simulation
---

# 器件话题回调返回 thenable 立即故障

## 规范来源

[docs/spec/javascript/host.rst](../../../docs/spec/javascript/host.rst)

<!-- prettier-ignore -->
> 合法 publish 开始后，器件监听器抛错、返回 thenable 或调用 reportError 导致的投递故障由运行时捕获：先标记 faulted，同步发布首个 onDidError，再停止后续器件分发，publish 自身正常返回，不向发布者重新抛出该投递故障。嵌套发布采用同一规则。

## 验收义务

前提：`ready` 板上唯一的器件话题监听器返回一个 thenable。

操作：宿主发布一次合法话题，捕获首故障事件，再对故障板发布第二次。

预期：首次 publish 不抛错但板已 `faulted`；只分发一次 onDidError，码为 ASYNC_HOOK_RESULT、阶段为 topic；再次发布按守卫顺序直接以 BOARD_FAULTED 拒绝。

## 模型

```ddl
device HostProbe {}
```

## 装配

```json
{ "instances": [{ "id": "probe", "type": "probe" }], "nets": [] }
```

## 执行步骤

```typescript
const { device, diagnostic } = await importModule('./fixture.mjs');
const errors = [];
const { board } = await device(
  adapter,
  await adapter.compileDDL(modelSource),
  {
    create(ctx) {
      ctx.topics.onDidReceive(() => ({ then() {} }));
    },
  },
  description,
);
t.after(board.dispose.bind(board));
board.onDidError((error) => errors.push(error));

board.topics.publish('topic', 7);
```

## 断言

```typescript
assert.equal(board.status, 'faulted');
assert.equal(errors.length, 1);
assert.equal(errors[0].code, 'ASYNC_HOOK_RESULT');
assert.equal(errors[0].phase, 'topic');
assert.throws(() => board.topics.publish('topic', 7), diagnostic('BOARD_FAULTED'));
```
