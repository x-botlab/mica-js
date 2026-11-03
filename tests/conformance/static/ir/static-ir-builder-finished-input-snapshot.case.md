---
format: mica-case/v1
id: static-ir-builder-finished-input-snapshot
kind: compile
---

# static-ir-builder-finished-input-snapshot

## 规范来源

[docs/spec/ir/builder.rst](../../../../docs/spec/ir/builder.rst)

<!-- prettier-ignore -->
> finish 交付公开可检查且不可变的 DeviceIR 或 BlockIR，不交付可执行 JavaScript。

[docs/spec/ir/validation.rst](../../../../docs/spec/ir/validation.rst)

<!-- prettier-ignore -->
> 成功返回捕获的递归不可变快照；后续修改调用方的数组、节点、字节输入或来源对象不改变该结果。

## 验收义务

前提：DeviceBuilder 以调用方持有的枚举成员数组、memory 描述对象与来源对象构造声明，finish 之后修改这些对象并改写成员。

操作：修改后登记模型，再实际装配并创建板。

预期：模型保留原枚举成员、原来源标签与长度为 2 的公开 memory；板状态为 ready。

## 输入

```json
{}
```

## 执行步骤

```typescript
const builder = adapter.createDeviceBuilder();
const source = { label: 'original' };
const options = { name: 'data', public: true, length: 2, source };
const members = ['first', 'second'];
builder.enum({ name: 'Choice', members });
builder.memory(options);
const model = builder.finish();
options.length = 9;
source.label = 'changed';
members[0] = 'changed';
let context;
const library = adapter.createDeviceLibrary([
  {
    id: 'snapshot',
    model,
    create(ctx) {
      context = ctx;
      return { sync() {}, dispose() {} };
    },
  },
]);
const board = adapter.createBoard(library, {
  instances: [{ id: 'one', type: 'snapshot' }],
  nets: [],
});
t.after(board.dispose.bind(board));
```

## 断言

```typescript
assert.deepEqual(model.declarations.find((d) => d.kind === 'enum').members, ['first', 'second']);
assert.equal(model.declarations.find((d) => d.kind === 'memory').source.label, 'original');
assert.deepEqual([...context.memory.data], [0, 0]);
assert.equal(board.status, 'ready');
```
