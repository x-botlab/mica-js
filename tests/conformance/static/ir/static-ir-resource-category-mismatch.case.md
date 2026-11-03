---
kind: compile
---

# static-ir-resource-category-mismatch

## 规范来源

[docs/spec/ir/schema.rst](../../../../docs/spec/ir/schema.rst)

<!-- prettier-ignore -->
> pin / memory 引用使用类别加名称，或当前函数参数的位置。

[docs/spec/ir/validation.rst](../../../../docs/spec/ir/validation.rst)

<!-- prettier-ignore -->
> * - IR_REFERENCE
>   - 名称不存在、类别不匹配、声明重复或资源归属错误。

## 验收义务

前提：器件只声明名为 target 的 pin，函数体却用 memoryLength 引用 memory target。

操作：通过真实 adapter 的 createDeviceLibrary 登记该模型，并记录器件工厂调用次数。

预期：登记被拒绝，诊断包含 IR_REFERENCE；器件工厂调用次数为零。

## 输入

```json
{
  "kind": "device",
  "name": "Category",
  "declarations": [
    { "kind": "pin", "name": "target" },
    {
      "kind": "function",
      "name": "probe",
      "pure": false,
      "params": [],
      "body": {
        "operations": [
          {
            "kind": "memoryLength",
            "memory": { "kind": "memory", "name": "target" },
            "result": 0,
            "type": { "kind": "number" }
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
let factoryCalls = 0;
const register = () =>
  adapter.createDeviceLibrary([
    {
      id: 'category',
      model: input,
      create() {
        factoryCalls++;
        return { sync() {}, dispose() {} };
      },
    },
  ]);
```

## 断言

```typescript
assert.throws(register, (error) => assertModelValidationError(error, 'IR_REFERENCE'));
assert.equal(factoryCalls, 0);
```
