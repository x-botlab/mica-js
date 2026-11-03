---
kind: simulation
---

# sync 内嵌套推进按阶段拒绝

## 规范来源

[docs/spec/javascript/host.rst](../../../docs/spec/javascript/host.rst)

<!-- prettier-ignore -->
> 每个板独立检查调用阶段，宿主在其器件回调、话题或诊断事件分发栈中不能嵌套推进或销毁同一块板；这不封锁独立板对象，但回调再次进入仍忙碌的原板时照常拒绝。

<!-- prettier-ignore -->
> 被拒绝调用本身不改变板状态；异常逸出器件回调时仍按该回调的未捕获异常处理。

## 验收义务

前提：两块独立板共用同一模型与装配；A 的 `sync` 捕获嵌套 `runUntil`，B 的 `sync` 让该拒绝逸出。

操作：推进 A 到 5，再推进 B 到 2。

预期：A 的嵌套调用以 INVALID_CALL_STATE 拒绝且被拒绝调用不推进、不改变状态，A 保持 ready 且时间为 5；B 的逸出异常按器件回调未捕获异常处理，整板 faulted、时间为 2，本次推进抛出 DEVICE_CALLBACK_FAILED。

## 模型

<!-- prettier-ignore -->
```ddl
device HostProbe {
  output channel out: number(capacity: 2);
  process start {
    out.send(7);
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
const { diagnostic } = await importModule('./fixture.mjs');
const model = await adapter.compileDDL(modelSource);

let caught;
let boardA;
const libraryA = adapter.createDeviceLibrary([
  {
    id: 'probe',
    model,
    create() {
      return {
        sync() {
          try {
            boardA.runUntil(1);
          } catch (error) {
            caught = error;
          }
        },
        dispose() {},
      };
    },
  },
]);
boardA = adapter.createBoard(libraryA, description);
t.after(boardA.dispose.bind(boardA));
boardA.runUntil(5);

let boardB;
const libraryB = adapter.createDeviceLibrary([
  {
    id: 'probe',
    model,
    create() {
      return {
        sync() {
          boardB.runUntil(1);
        },
        dispose() {},
      };
    },
  },
]);
boardB = adapter.createBoard(libraryB, description);
t.after(boardB.dispose.bind(boardB));
```

## 断言

```typescript
assert.equal(caught.code, 'INVALID_CALL_STATE');
assert.equal(boardA.status, 'ready');
assert.equal(boardA.time, 5);

assert.throws(() => boardB.runUntil(2), diagnostic('DEVICE_CALLBACK_FAILED'));
assert.equal(boardB.status, 'faulted');
assert.equal(boardB.time, 2);
```
