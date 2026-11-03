---
format: mica-case/v1
id: static-ir-pure-now
kind: compile
---

# static-ir-pure-now

## 规范来源

[docs/spec/ir/schema.rst](../../../../docs/spec/ir/schema.rst)

<!-- prettier-ignore -->
> 所有效果都从实际节点和静态调用图推导。call 的 pure 字段表示此调用要求显式 pure fn，不能作为目标纯性的证明。

[docs/spec/ir/validation.rst](../../../../docs/spec/ir/validation.rst)

<!-- prettier-ignore -->
> * - IR_EFFECT
>   - 所在上下文禁止的读取、写入、调用或挂起效果。

## 验收义务

前提：手工 DeviceIR 的函数自报 pure 为 true，函数体内含 now 操作并返回其结果。

操作：通过真实 adapter 的 createDeviceLibrary 登记该模型，并记录器件工厂调用次数。

预期：登记被拒绝，诊断包含 IR_EFFECT；器件工厂调用次数为零。

## 输入

```json
{
  "kind": "device",
  "name": "ManualFixture",
  "declarations": [
    {
      "kind": "function",
      "name": "read",
      "pure": true,
      "params": [],
      "body": {
        "operations": [
          {
            "kind": "now",
            "result": 0,
            "type": {
              "kind": "number"
            }
          },
          {
            "kind": "returnValue",
            "value": 0
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
assert.throws(register, (error) => assertModelValidationError(error, 'IR_EFFECT'));
assert.equal(factoryCalls, 0, 'IR validation must precede all factory calls');
```
