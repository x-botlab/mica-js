---
kind: compile
---

# static-ddl-forward-types-functions

## 规范来源

[docs/spec/language/lexical.rst](../../../../docs/spec/language/lexical.rst)

[docs/spec/language/functions.rst](../../../../docs/spec/language/functions.rst)

## 验收义务

前提：函数返回后声明的记录类型，并调用后声明的函数。

操作：编译该定义。

预期：接受记录类型与函数的前向引用。

## 输入

```ddl
device StaticFixture {
fn make() -> Item {
return helper();
}
fn helper() -> Item {
return { value: 1 };
}
record Item { value: number; }
}
```

## 执行步骤

```typescript
const model = await adapter.compileDDL(input);
let factoryCalls = 0;
```

## 断言

```typescript
assert.ok(model && typeof model === 'object', '接受 device 内记录类型与函数的前向引用。');
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
