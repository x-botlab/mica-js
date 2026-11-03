---
format: mica-case/v1
id: static-ir-missing-value-region-yield
kind: compile
---

# static-ir-missing-value-region-yield

## 规范来源

[docs/spec/ir/schema.rst](../../../../docs/spec/ir/schema.rst)

<!-- prettier-ignore -->
> 每条正常结束路径使用 ``yield`` 交付声明类型的值；yield 只结束当前计算区域，与调度意义的让出执行无关。

[docs/spec/ir/validation.rst](../../../../docs/spec/ir/validation.rst)

<!-- prettier-ignore -->
> * - IR_CONTROL_FLOW
>   - 非法跳转、不可达后缀、未穷尽选择、缺失正常返回或 yield。

## 验收义务

前提：手工 DeviceIR 的 select 的 yes 分支产生结果后自然结束，没有 yield；no 分支以 yield 结束。

操作：通过真实 adapter 的 createDeviceLibrary 登记该模型，并记录器件工厂调用次数。

预期：登记被拒绝，诊断包含 IR_CONTROL_FLOW；器件工厂调用次数为零。

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
                "kind": "number"
              },
              "body": {
                "operations": [
                  {
                    "kind": "constant",
                    "result": 2,
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
                      "value": 2
                    }
                  },
                  {
                    "kind": "yield",
                    "value": 3
                  }
                ]
              }
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
assert.throws(register, (error) => assertModelValidationError(error, 'IR_CONTROL_FLOW'));
assert.equal(factoryCalls, 0);
```
