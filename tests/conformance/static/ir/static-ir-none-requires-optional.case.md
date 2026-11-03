---
format: mica-case/v1
id: static-ir-none-requires-optional
kind: compile
---

# static-ir-none-requires-optional

## 规范来源

[docs/spec/ir/schema.rst](../../../../docs/spec/ir/schema.rst)

<!-- prettier-ignore -->
> none 常量的结果类型必须为一个确定的 optional 类型。

[docs/spec/ir/validation.rst](../../../../docs/spec/ir/validation.rst)

<!-- prettier-ignore -->
> * - IR_TYPE
>   - 类型、运算、签名、声明位置或非空证明不匹配。

## 验收义务

前提：手工 DeviceIR 的 constant 载荷为 none，结果类型却是非可空 number。

操作：通过真实 adapter 的 createDeviceLibrary 登记该模型，并记录器件工厂调用次数。

预期：登记被拒绝，诊断包含 IR_TYPE；器件工厂调用次数为零。

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
            "result": 0,
            "type": {
              "kind": "number"
            },
            "constant": {
              "kind": "none"
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
assert.throws(register, (error) => assertModelValidationError(error, 'IR_TYPE'));
assert.equal(factoryCalls, 0);
```
