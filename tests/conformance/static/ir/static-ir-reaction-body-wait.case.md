---
kind: compile
---

# static-ir-reaction-body-wait

## 规范来源

[docs/spec/ir/validation.rst](../../../../docs/spec/ir/validation.rst)

<!-- prettier-ignore -->
> 响应体只允许无值 return 或自然结束，禁止 returnValue、等待、receive、redirect 及 JIT 专有控制操作，效果限制沿所有被调用函数传播。

[docs/spec/ir/validation.rst](../../../../docs/spec/ir/validation.rst)

<!-- prettier-ignore -->
> * - IR_EFFECT
>   - 所在上下文禁止的读取、写入、调用或挂起效果。

## 验收义务

前提：手工 DeviceIR 的 reaction 响应体在取值之后追加 wait，时长为常量 0。

操作：通过真实 adapter 的 createDeviceLibrary 登记该模型，并记录器件工厂调用次数。

预期：登记被拒绝，诊断包含 IR_EFFECT；器件工厂调用次数为零。

## 输入

```json
{
  "kind": "device",
  "name": "ReactionWait",
  "declarations": [
    {
      "kind": "state",
      "name": "count",
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
                "value": 0
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
      "kind": "reaction",
      "name": "watch",
      "sourcePath": ["count"],
      "sourceType": {
        "kind": "number"
      },
      "previous": "old",
      "current": "now",
      "captures": [],
      "body": {
        "operations": [
          {
            "kind": "reactionValue",
            "binding": "current",
            "result": 0,
            "type": {
              "kind": "number"
            }
          },
          {
            "kind": "constant",
            "result": 1,
            "type": {
              "kind": "number"
            },
            "constant": {
              "kind": "number",
              "value": 0
            }
          },
          {
            "kind": "wait",
            "duration": 1
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
assert.throws(register, (error) => assertModelValidationError(error, 'IR_EFFECT'));
assert.equal(factoryCalls, 0);
```
