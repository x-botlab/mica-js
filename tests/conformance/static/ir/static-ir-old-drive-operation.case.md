---
format: mica-case/v1
id: static-ir-old-drive-operation
kind: compile
---

# static-ir-old-drive-operation

## 规范来源

[docs/spec/ir/validation.rst](../../../../docs/spec/ir/validation.rst)

<!-- prettier-ignore -->
> * - IR_SCHEMA
>   - 不符合节点字段、判别值或基础结构。

## 验收义务

前提：手工 DeviceIR 的函数体使用 kind 为 drive 的操作节点，该判别值不在当前操作集合中。

操作：通过真实 adapter 的 createDeviceLibrary 登记该模型，并记录器件工厂调用次数。

预期：登记被拒绝，诊断包含 IR_SCHEMA；器件工厂调用次数为零。

## 输入

```json
{
  "kind": "device",
  "name": "ManualFixture",
  "declarations": [
    {
      "kind": "function",
      "name": "oldOperation",
      "pure": false,
      "params": [],
      "body": {
        "operations": [
          {
            "kind": "drive"
          }
        ]
      }
    }
  ]
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
