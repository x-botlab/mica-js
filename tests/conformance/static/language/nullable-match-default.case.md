---
format: mica-case/v1
id: language-atomic-nullable-match-default
kind: compile
---

# nullable-match-default

## 规范来源

[docs/spec/language/statements.rst](../../../../docs/spec/language/statements.rst)

<!-- prettier-ignore -->
> 局部被匹配值在具体非空分支收窄；若前支已排除 none，后续 ``_`` 分支可按非空类型使用。

## 验收义务

前提：number? 参数先匹配 none，再在兜底分支参与加法。

操作：编译该 device 定义，并把产物登记到器件库。

预期：编译成功，产物可通过器件库登记。

## 输入

<!-- prettier-ignore -->
```ddl
device Atomic {
fn read(value: number?) -> number { match value { none => { return 0; } _ => { return value + 1; } } }
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
