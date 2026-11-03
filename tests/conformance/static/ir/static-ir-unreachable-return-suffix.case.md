---
format: mica-case/v1
id: static-ir-unreachable-return-suffix
kind: compile
---

# static-ir-unreachable-return-suffix

## 规范来源

[docs/spec/ir/schema.rst](../../../../docs/spec/ir/schema.rst)

<!-- prettier-ignore -->
> return / returnValue 结束所属函数或独立计算体；过程和 reaction 响应体的 return 结束本次运行。所有必然终结节点之后继续追加同路径操作均拒绝。

[docs/spec/ir/validation.rst](../../../../docs/spec/ir/validation.rst)

<!-- prettier-ignore -->
> * - IR_CONTROL_FLOW
>   - 非法跳转、不可达后缀、未穷尽选择、缺失正常返回或 yield。

## 验收义务

前提：手工 DeviceIR 的无返回值函数体先以 return 结束路径，随后追加 constant 操作。

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
            "kind": "return"
          },
          {
            "kind": "constant",
            "result": 0,
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
assert.throws(register, (error) => assertModelValidationError(error, 'IR_CONTROL_FLOW'));
assert.equal(factoryCalls, 0);
```
