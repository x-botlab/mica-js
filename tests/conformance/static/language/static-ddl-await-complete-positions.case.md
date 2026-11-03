---
format: mica-case/v1
id: static-ddl-await-complete-positions
kind: compile
---

# static-ddl-await-complete-positions

## 规范来源

[docs/spec/language/statements.rst](../../../../docs/spec/language/statements.rst)

## 验收义务

前提：过程内包含独立 `ticks` 等待、`receive` 结果初始化和赋值。

操作：调用真实 adapter 的 `compileDDL` 编译输入。

预期：接受该定义，等待形式与完整初始化、赋值位置合法。

## 输入

```ddl
device StaticFixture {
input channel incoming: number(capacity: 2);
     process start { await ticks(1); const first = await incoming.receive(); let next = 0; next = await incoming.receive(); }
}
```

## 执行步骤

```typescript
assert.equal(typeof adapter.compileDDL, 'function');
const model = await adapter.compileDDL(input);
let factoryCalls = 0;
```

## 断言

```typescript
assert.ok(
  model && typeof model === 'object',
  '接受过程内独立 ticks 等待以及 receive 完整初始化与赋值。',
);
assert.equal(model.kind, 'device');
assert.equal(model.name, 'StaticFixture');
assert.ok(Array.isArray(model.declarations));
const library = adapter.createDeviceLibrary([
  {
    id: 'static/fixture',
    model,
    create() {
      factoryCalls++;
      return { sync() {}, dispose() {} };
    },
  },
]);
assert.ok(library && typeof library === 'object');
assert.equal(factoryCalls, 0, 'Library registration must not invoke factories');
```
