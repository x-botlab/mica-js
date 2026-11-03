---
format: mica-case/v1
id: consistency-builder-ddl-value-snapshot
kind: comparison
---

# consistency-builder-ddl-value-snapshot

## 规范来源

[docs/spec/ir/builder.rst](../../../docs/spec/ir/builder.rst)

<!-- prettier-ignore -->
> 动态值句柄表示运行时执行到该操作取得的结果。资源再次变化不会使已有句柄重新读取；需要当前值时，显式生成新的读取操作。

## 验收义务

前提：Builder 与 DDL 各构造一个等价过程：把 data[0] 置 1，读取该值保存，把 data[0] 改为 9，再把保存值写入 data[1]。

操作：在同一板上装配两条路径的实例并推进到 0。

预期：两个实例的公开 memory data 都精确为 [9,1,0]，保存值保留读取时的 1 而不被后续写入重读。

## 对照输入

```json
{
  "source": "device Snapshot { public memory data[3]; process start { store8(data,0,1); let saved:number=load8(data,0); store8(data,0,9); store8(data,1,saved); } }"
}
```

## 执行步骤

```typescript
const builder = adapter.createDeviceBuilder();
builder.memory({ name: 'data', public: true, length: 3 });
builder.start((body) => {
  body.store8('data', 0, 1);
  const saved = body.load8('data', 0);
  body.store8('data', 0, 9);
  body.store8('data', 1, saved);
});
const built = builder.finish();
const compiled = await adapter.compileDDL(inputs.source);
const contexts = [];
const outputs = [];
const library = adapter.createDeviceLibrary(
  [
    ['built', built],
    ['ddl', compiled],
  ].map(([id, model]) => ({
    id,
    model,
    create(ctx) {
      contexts.push(ctx);
      const messages = [];
      outputs.push(messages);
      return {
        sync(batch) {
          if (batch.outputs.out) messages.push(...batch.outputs.out.map((m) => [...m.value]));
        },
        dispose() {},
      };
    },
  })),
);
const board = adapter.createBoard(library, {
  instances: [
    { id: 'built', type: 'built' },
    { id: 'ddl', type: 'ddl' },
  ],
  nets: [],
});
t.after(board.dispose.bind(board));
board.runUntil(0);
```

## 断言

```typescript
assert.equal(contexts.length, 2);
for (const ctx of contexts) assert.deepEqual([...ctx.memory.data], [9, 1, 0]);
```
