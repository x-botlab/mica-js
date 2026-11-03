---
format: mica-case/v1
id: language-atomic-identifier-ascii-shape
kind: compile
---

# identifier-ascii-shape

## 规范来源

[docs/spec/language/lexical.rst](../../../../docs/spec/language/lexical.rst)

<!-- prettier-ignore -->
> 标识符大小写敏感，匹配 ``[A-Za-z_][A-Za-z0-9_]*``。

## 验收义务

前提：器件级 const 使用符合词形规则的 _a0 作为名称。

操作：编译该 device 定义，并把产物登记到器件库。

预期：编译成功，产物可通过器件库登记。

## 输入

<!-- prettier-ignore -->
```ddl
device Atomic {
const _a0 = 1;
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
