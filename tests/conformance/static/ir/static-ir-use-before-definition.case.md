---
kind: compile
---

# static-ir-use-before-definition

## 规范来源

[docs/spec/ir/schema.rst](../../../../docs/spec/ir/schema.rst)

<!-- prettier-ignore -->
> 编号必须在可见位置定义并支配其使用。

[docs/spec/ir/validation.rst](../../../../docs/spec/ir/validation.rst)

<!-- prettier-ignore -->
> * - IR_SCOPE
>   - 句柄归属、支配关系或局部可见性错误。

## 验收义务

前提：手工 DeviceIR 的 unary 操作先引用结果编号 1，随后才由 constant 操作定义该编号。

操作：通过真实 adapter 的 createDeviceLibrary 登记该模型，并记录器件工厂调用次数。

预期：登记被拒绝，诊断包含 IR_SCOPE；器件工厂调用次数为零。

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
            "kind": "unary",
            "operator": "negate",
            "value": 1,
            "result": 0,
            "type": {
              "kind": "number"
            }
          },
          {
            "kind": "constant",
            "result": 1,
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
assert.throws(register, (error) => assertModelValidationError(error, 'IR_SCOPE'));
assert.equal(factoryCalls, 0);
```
