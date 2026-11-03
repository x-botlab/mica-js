---
kind: compile
---

# static-ir-select-branch-yield-type-mismatch

## 规范来源

[docs/spec/ir/schema.rst](../../../../docs/spec/ir/schema.rst)

<!-- prettier-ignore -->
> 前者条件及区域结果为 bool；select 条件为 bool，两分支结果与声明类型一致。

[docs/spec/ir/validation.rst](../../../../docs/spec/ir/validation.rst)

<!-- prettier-ignore -->
> * - IR_TYPE
>   - 类型、运算、签名、声明位置或非空证明不匹配。

## 验收义务

前提：手工 DeviceIR 的函数体声明 number 返回类型，其中 select 结果也为 number，但 yes 分支的值区域声明为 bool 并 yield 一个 bool 结果。

操作：通过真实 adapter 的 createDeviceLibrary 登记该模型，并记录器件工厂调用次数。

预期：登记被拒绝，诊断包含 IR_TYPE；器件工厂调用次数为零。

## 输入

```json
{
  "kind": "device",
  "name": "SelectIR",
  "declarations": [
    {
      "kind": "function",
      "name": "probe",
      "pure": false,
      "params": [],
      "returns": {
        "kind": "number"
      },
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
            "kind": "select",
            "result": 1,
            "type": {
              "kind": "number"
            },
            "condition": 0,
            "yes": {
              "type": {
                "kind": "bool"
              },
              "body": {
                "operations": [
                  {
                    "kind": "constant",
                    "result": 2,
                    "type": {
                      "kind": "bool"
                    },
                    "constant": {
                      "kind": "bool",
                      "value": false
                    }
                  },
                  {
                    "kind": "yield",
                    "value": 2
                  }
                ]
              }
            },
            "no": {
              "type": {
                "kind": "number"
              },
              "body": {
                "operations": [
                  {
                    "kind": "constant",
                    "result": 3,
                    "type": {
                      "kind": "number"
                    },
                    "constant": {
                      "kind": "number",
                      "value": 1
                    }
                  },
                  {
                    "kind": "yield",
                    "value": 3
                  }
                ]
              }
            }
          },
          {
            "kind": "returnValue",
            "value": 1
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
      id: 'static/manual',
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
