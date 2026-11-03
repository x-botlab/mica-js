---
format: mica-case/v1
id: static-ddl-empty-record
kind: compile
---

# static-ddl-empty-record

## 规范来源

[docs/spec/language/types.rst](../../../../docs/spec/language/types.rst)

<!-- prettier-ignore -->
> 记录是 device 内的具名不可变值，允许零个字段，字段名唯一、全部必填，字段类型仅为 number 或 bool。记录保持扁平。字面量从注解、实参形参、返回类型或发送目标获得期望类型；缺少该上下文时要求显式注解。

## 验收义务

前提：device 内声明零字段记录，并以目标类型初始化空记录。

操作：编译该 device 定义，并把产物登记到器件库。

预期：编译成功，产物可通过器件库登记。

## 输入

```ddl
device StaticFixture {
record Empty {} const value: Empty = {};
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
assert.ok(model && typeof model === 'object', '接受具名空记录及其有目标类型的字面量。');
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
