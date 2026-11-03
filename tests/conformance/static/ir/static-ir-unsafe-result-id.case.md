---
format: mica-case/v1
id: static-ir-unsafe-result-id
kind: compile
---

# static-ir-unsafe-result-id

## 规范来源

[docs/spec/ir/schema.rst](../../../../docs/spec/ir/schema.rst)

<!-- prettier-ignore -->
> ``ResultId`` 与 ``LocalId`` 均为非负安全整数，但拥有独立编号空间。

[docs/spec/ir/validation.rst](../../../../docs/spec/ir/validation.rst)

<!-- prettier-ignore -->
> * - IR_SCHEMA
>   - 不符合节点字段、判别值或基础结构。

## 验收义务

前提：手工 DeviceIR 的 constant 操作把 result 写成 9007199254740992。

操作：通过真实 adapter 的 createDeviceLibrary 登记该模型，并记录器件工厂调用次数。

预期：登记被拒绝，诊断包含 IR_SCHEMA；器件工厂调用次数为零。

## 输入

```json
{
  "kind": "device",
  "name": "AtomicIR",
  "declarations": [
    {
      "kind": "function",
      "name": "probe",
      "pure": false,
      "params": [],
      "body": {
        "operations": [
          {
            "kind": "constant",
            "result": 9007199254740992,
            "type": {
              "kind": "number"
            },
            "constant": {
              "kind": "number",
              "value": 1
            }
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
      id: 'atomic',
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
assert.throws(register, (error) => assertModelValidationError(error, 'IR_SCHEMA'));
assert.equal(factoryCalls, 0);
```
