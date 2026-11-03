---
kind: compile
---

# static-ir-reaction-source-type-mismatch

## 规范来源

[docs/spec/ir/schema.rst](../../../../docs/spec/ir/schema.rst)

<!-- prettier-ignore -->
> sourcePath 是非空静态路径数组，根须为 state、derived 或 pin.sample；路径最终类型必须与 sourceType 严格匹配。

[docs/spec/ir/validation.rst](../../../../docs/spec/ir/validation.rst)

<!-- prettier-ignore -->
> 源或捕获类型不匹配、不可比较结果属于 IR_TYPE

## 验收义务

前提：手工 DeviceIR 的 reaction 以 number state count 为源，sourceType 与响应体 reactionValue 结果都声明为 string。

操作：通过真实 adapter 的 createDeviceLibrary 登记该模型，并记录器件工厂调用次数。

预期：登记被拒绝，诊断包含 IR_TYPE；器件工厂调用次数为零。

## 输入

```json
{
  "kind": "device",
  "name": "ReactionSourceType",
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
        "kind": "string"
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
              "kind": "string"
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
