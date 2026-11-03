---
format: mica-case/v1
id: static-ir-initial-runtime-read
kind: compile
---

# static-ir-initial-runtime-read

## 规范来源

[docs/spec/ir/validation.rst](../../../../docs/spec/ir/validation.rst)

<!-- prettier-ignore -->
> 全部调用链只读取属性、常量及值形参；资源引用只标识身份，不读取 state、derived、sample 或 memory 内容与长度。返回非可空 intent。

[docs/spec/ir/validation.rst](../../../../docs/spec/ir/validation.rst)

<!-- prettier-ignore -->
> * - IR_EFFECT
>   - 所在上下文禁止的读取、写入、调用或挂起效果。

## 验收义务

前提：手工 DeviceIR 的 pin.initial 体先用 read 操作读取本实例 state，再以该结果作为 resistor 的电阻值，最终返回 intent。

操作：通过真实 adapter 的 createDeviceLibrary 登记该模型，并记录器件工厂调用次数。

预期：登记被拒绝，诊断包含 IR_EFFECT；器件工厂调用次数为零。

## 输入

```json
{
  "kind": "device",
  "name": "ManualFixture",
  "declarations": [
    {
      "kind": "state",
      "name": "resistance",
      "type": {
        "kind": "number"
      },
      "initial": {
        "type": {
          "kind": "number"
        },
        "body": {
          "operations": [
            {
              "kind": "constant",
              "result": 0,
              "type": {
                "kind": "number"
              },
              "constant": {
                "kind": "number",
                "value": 1000
              }
            },
            {
              "kind": "returnValue",
              "value": 0
            }
          ]
        }
      }
    },
    {
      "kind": "pin",
      "name": "reference"
    },
    {
      "kind": "pin",
      "name": "probe",
      "initial": {
        "type": {
          "kind": "intent"
        },
        "body": {
          "operations": [
            {
              "kind": "read",
              "result": 0,
              "type": {
                "kind": "number"
              },
              "resource": "state",
              "name": "resistance"
            },
            {
              "kind": "resistor",
              "result": 1,
              "type": {
                "kind": "intent"
              },
              "to": {
                "kind": "pin",
                "name": "reference"
              },
              "resistance": 0
            },
            {
              "kind": "returnValue",
              "value": 1
            }
          ]
        }
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
assert.throws(register, (error) => assertModelValidationError(error, 'IR_EFFECT'));
assert.equal(factoryCalls, 0, 'IR validation must precede all factory calls');
```
