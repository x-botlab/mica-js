---
kind: compile
---

# static-ir-branch-result-escape

## 规范来源

[docs/spec/ir/schema.rst](../../../../docs/spec/ir/schema.rst)

<!-- prettier-ignore -->
> 编号必须在可见位置定义并支配其使用。外层值和槽可以进入子区域；分支、循环体与计算子区域的临时结果不能泄露到外层。

[docs/spec/ir/validation.rst](../../../../docs/spec/ir/validation.rst)

<!-- prettier-ignore -->
> * - IR_SCOPE
>   - 句柄归属、支配关系或局部可见性错误。

## 验收义务

前提：手工 DeviceIR 的函数体在 if 的 yes 分支内定义结果编号，if 之后再以该编号作为 returnValue 的输入。

操作：通过真实 adapter 的 createDeviceLibrary 登记该模型，并记录器件工厂调用次数。

预期：登记被拒绝，诊断包含 IR_SCOPE；器件工厂调用次数为零。

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
              "kind": "bool",
              "value": true
            }
          },
          {
            "kind": "if",
            "condition": 0,
            "yes": {
              "operations": [
                {
                  "kind": "constant",
                  "result": 1,
                  "type": {
                    "kind": "number"
                  },
                  "constant": {
                    "kind": "number",
                    "value": 7
                  }
                }
              ]
            }
          },
          {
            "kind": "returnValue",
            "value": 1
          }
        ]
      },
      "returns": {
        "kind": "number"
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
assert.throws(register, (error) => assertModelValidationError(error, 'IR_SCOPE'));
assert.equal(factoryCalls, 0, 'IR validation must precede all factory calls');
```
