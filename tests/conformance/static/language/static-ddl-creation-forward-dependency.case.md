---
kind: compile
---

# static-ddl-creation-forward-dependency

## 规范来源

[docs/spec/language/lexical.rst](../../../../docs/spec/language/lexical.rst)

<!-- prettier-ignore -->
> 类型、函数和器件级创建期依赖允许前向引用。函数调用图与创建期依赖图分别检查无环；derived 依赖图也必须无环，见 :doc:`functions` 与 :doc:`declarations`。

## 验收义务

前提：器件级 const 引用后声明的 const，state 初值引用前者。

操作：编译该 device 定义，并把产物登记到器件库。

预期：编译成功，产物可通过器件库登记。

## 输入

```ddl
device StaticFixture {
const first = second + 1;
const second = 2;
state count: number = first;
}
```

## 执行步骤

```typescript
const model = await adapter.compileDDL(input);
let factoryCalls = 0;
```

## 断言

```typescript
assert.ok(model && typeof model === 'object', '接受创建期 const 的无环前向依赖。');
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
