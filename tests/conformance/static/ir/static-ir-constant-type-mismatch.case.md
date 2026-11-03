---
kind: compile
---

# static-ir-constant-type-mismatch

## 规范来源

[docs/spec/ir/schema.rst](../../../../docs/spec/ir/schema.rst)

<!-- prettier-ignore -->
> 每个产值操作都含 result 与 type；该 type 是待核对信息，而不是允许调用方自由指定的类型断言。

[docs/spec/ir/validation.rst](../../../../docs/spec/ir/validation.rst)

<!-- prettier-ignore -->
> * - IR_TYPE
>   - 类型、运算、签名、声明位置或非空证明不匹配。

## 验收义务

前提：手工 DeviceIR 的 constant 操作声明结果类型为 bool，常量载荷却是 number 1。

操作：通过真实 adapter 的 createDeviceLibrary 登记该模型，并记录器件工厂调用次数。

预期：登记被拒绝，诊断包含 IR_TYPE；器件工厂调用次数为零。

## 输入

```json
{
  "kind": "device",
  "name": "ManualFixture",
  "declarations": [
    {
      "kind": "function",
      "name": "read",
      "pure": false,
      "params": [],
      "body": {
        "operations": [
          {
            "kind": "constant",
            "result": 0,
            "type": {
              "kind": "bool"
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
assert.throws(register, (error) => assertModelValidationError(error, 'IR_TYPE'));
assert.equal(factoryCalls, 0, 'IR validation must precede all factory calls');
```
