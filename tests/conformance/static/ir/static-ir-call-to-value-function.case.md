---
kind: compile
---

# static-ir-call-to-value-function

## 规范来源

[docs/spec/ir/schema.rst](../../../../docs/spec/ir/schema.rst)

<!-- prettier-ignore -->
> 无返回 call 只绑定无返回值函数；丢弃有值调用结果时仍生成 callValue。

[docs/spec/ir/validation.rst](../../../../docs/spec/ir/validation.rst)

<!-- prettier-ignore -->
> * - IR_TYPE
>   - 类型、运算、签名、声明位置或非空证明不匹配。

## 验收义务

前提：手工 DeviceIR 声明返回 number 的函数 compute 与无返回值函数 sink；sink 的函数体用无返回 call 调用 compute。

操作：通过真实 adapter 的 createDeviceLibrary 登记该模型，并记录器件工厂调用次数。

预期：登记被拒绝，诊断包含 IR_TYPE；器件工厂调用次数为零。

## 输入

```json
{
  "kind": "device",
  "name": "CallSignature",
  "declarations": [
    {
      "kind": "function",
      "name": "compute",
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
              "kind": "number"
            },
            "constant": {
              "kind": "number",
              "value": 1
            }
          },
          {
            "kind": "returnValue",
            "value": 0
          }
        ]
      }
    },
    {
      "kind": "function",
      "name": "sink",
      "pure": false,
      "params": [],
      "body": {
        "operations": [
          {
            "kind": "call",
            "name": "compute",
            "pure": false,
            "args": []
          }
        ]
      }
    },
    {
      "kind": "start",
      "body": {
        "operations": [
          {
            "kind": "call",
            "name": "sink",
            "pure": false,
            "args": []
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
