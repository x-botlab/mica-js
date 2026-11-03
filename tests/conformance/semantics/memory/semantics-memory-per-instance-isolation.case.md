---
kind: simulation
---

# 同一定义的两个实例存储互不影响

## 规范来源

[docs/spec/memory.rst](../../../../docs/spec/memory.rst)

<!-- prettier-ignore -->
> 运行时为每个实例独立分配存储，初始字节全部为零。两个实例声明同名 ``memory``，仍拥有各自的内容。

[docs/spec/assembly.rst](../../../../docs/spec/assembly.rst)

<!-- prettier-ignore -->
> 同一定义的模型及编译结果可以复用；每个实例独立拥有状态、存储、通道与适配对象。

## 验收义务

前提：一个带 `public memory slot[1]` 的模型装配为两个实例，属性值分别为 1 与 2；两个启动过程都写入同名存储。

操作：通过真实 adapter 编译模型、建立含两个实例的板并推进到 0，在各适配对象的 `sync` 中读取本实例的公开存储。

预期：两个实例读到的字节分别是 [1] 与 [2]；同名存储不共享，装配顺序既决定 `sync` 次序也不混合内容。

## 模型

<!-- prettier-ignore -->
```ddl
device Probe(value: number) {
  public memory slot[1];
  process start {
    store8(slot, 0, value);
  }
}
```

## 装配

```json
{
  "instances": [
    {
      "id": "first",
      "type": "probe",
      "props": {
        "value": 1
      }
    },
    {
      "id": "second",
      "type": "probe",
      "props": {
        "value": 2
      }
    }
  ],
  "nets": []
}
```

## 执行步骤

```typescript
const observed = [];
const model = await adapter.compileDDL(modelSource);
const library = adapter.createDeviceLibrary([
  {
    id: 'probe',
    model,
    create(ctx) {
      return {
        sync() {
          observed.push([ctx.props.value, [...ctx.memory.slot]]);
        },
        dispose() {},
      };
    },
  },
]);
const board = adapter.createBoard(library, description);
t.after(board.dispose.bind(board));

board.runUntil(0);
```

## 断言

```typescript
assert.deepEqual(observed, [
  [1, [1]],
  [2, [2]],
]);
assert.equal(board.status, 'ready');
```
