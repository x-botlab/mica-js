---
format: mica-case/v1
id: static-ir-resource-parameter-not-value
kind: compile
---

# static-ir-resource-parameter-not-value

## 规范来源

[docs/spec/ir/schema.rst](../../../../docs/spec/ir/schema.rst)

<!-- prettier-ignore -->
> 函数资源参数只能是 pin / memory 引用。它们保持所属实例身份，不经参数读取操作变成普通值；``parameter`` 产值操作仅用于值形参，index 按参数声明表从零计数。

[docs/spec/ir/validation.rst](../../../../docs/spec/ir/validation.rst)

<!-- prettier-ignore -->
> * - IR_TYPE
>   - 类型、运算、签名、声明位置或非空证明不匹配。

## 验收义务

前提：手工 DeviceIR 的函数第 0 号形参类型为 pin，函数体用 parameter 操作以该 index 产生 number 结果。

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
      "params": [
        {
          "name": "target",
          "type": {
            "kind": "pin"
          }
        }
      ],
      "body": {
        "operations": [
          {
            "kind": "parameter",
            "index": 0,
            "result": 0,
            "type": {
              "kind": "number"
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
