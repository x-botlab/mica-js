---
format: mica-case/v1
id: static-ir-wrong-root-kind
kind: compile
---

# static-ir-wrong-root-kind

## 规范来源

[docs/spec/ir/schema.rst](../../../../docs/spec/ir/schema.rst)

<!-- prettier-ignore -->
> ``DeviceIR`` 描述一个自包含 device，``declarations`` 按声明顺序保存类型、属性、常量、资源、函数、过程与创建期断言。

[docs/spec/ir/validation.rst](../../../../docs/spec/ir/validation.rst)

<!-- prettier-ignore -->
> * - IR_SCHEMA
>   - 不符合节点字段、判别值或基础结构。

## 验收义务

前提：手工输入的根 kind 为 block，却带 declarations 并作为器件定义登记。

操作：通过真实 adapter 的 createDeviceLibrary 登记该模型，并记录器件工厂调用次数。

预期：登记被拒绝，诊断包含 IR_SCHEMA；器件工厂调用次数为零。

## 输入

```json
{
  "kind": "block",
  "name": "ManualFixture",
  "declarations": []
}
```

## 执行步骤

```typescript
const { assertModelValidationError } = await importModule('../assertions.mjs');
const model = input;
let factoryCalls = 0;
const register = () =>
  adapter.createDeviceLibrary([
    {
      id: 'static/manual',
      model,
      create() {
        factoryCalls++;
        return { sync() {}, dispose() {} };
      },
    },
  ]);
```

## 断言

```typescript
assert.throws(register, (error) => assertModelValidationError(error, 'IR_SCHEMA'));
assert.equal(factoryCalls, 0, 'IR validation must precede all factory calls');
```
