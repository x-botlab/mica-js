---
kind: compile
---

# forward-function

## 规范来源

[docs/spec/language/lexical.rst](../../../../docs/spec/language/lexical.rst)

<!-- prettier-ignore -->
> 类型、函数和器件级创建期依赖允许前向引用。函数调用图与创建期依赖图分别检查无环；derived 依赖图也必须无环，见 :doc:`functions` 与 :doc:`declarations`。

## 验收义务

前提：先声明的 first 仅调用后声明且无递归的 second。

操作：编译该 device 定义，并把产物登记到器件库。

预期：编译成功，产物可通过器件库登记。

## 输入

<!-- prettier-ignore -->
```ddl
device Atomic {
fn first() -> number { return second(); }
fn second() -> number { return 1; }
}
```

## 执行步骤

```typescript
const model = await adapter.compileDDL(typeof input === 'string' ? input : input.source);
let factoryCalls = 0;
```

## 断言

```typescript
assert.equal(model.kind, 'device');
assert.equal(model.name, 'Atomic');
const library = adapter.createDeviceLibrary([
  {
    id: 'language/atomic',
    model,
    create() {
      factoryCalls++;
      return { sync() {}, dispose() {} };
    },
  },
]);
assert.ok(library);
assert.equal(factoryCalls, 0);
```
