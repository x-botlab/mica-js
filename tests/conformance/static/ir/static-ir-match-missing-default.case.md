---
kind: compile
---

# static-ir-match-missing-default

## 规范来源

[docs/spec/ir/validation.rst](../../../../docs/spec/ir/validation.rst)

<!-- prettier-ignore -->
> 控制流检查分支穷尽、模式重复、最近循环跳转、函数正常返回路径、计算区域 yield 与路径终结后的后缀。

[docs/spec/language/statements.rst](../../../../docs/spec/language/statements.rst)

<!-- prettier-ignore -->
> match 必须穷尽。bool 和枚举可以列出全部值；可空类型还须覆盖 none。number、string 以及不能逐项列举的值类型需要 ``_``；bytes 不提供内容模式。

[docs/spec/ir/validation.rst](../../../../docs/spec/ir/validation.rst)

<!-- prettier-ignore -->
> * - IR_CONTROL_FLOW
>   - 非法跳转、不可达后缀、未穷尽选择、缺失正常返回或 yield。

## 验收义务

前提：手工 DeviceIR 的 void 函数以 number 形参为匹配值，match 只有数值 0 一个分支且没有 otherwise。

操作：通过真实 adapter 的 createDeviceLibrary 登记该模型，并记录器件工厂调用次数。

预期：登记被拒绝，诊断包含 IR_CONTROL_FLOW；器件工厂调用次数为零。

## 输入

```json
{
  "kind": "device",
  "name": "MatchExhaustive",
  "declarations": [
    {
      "kind": "function",
      "name": "choose",
      "pure": false,
      "params": [
        {
          "name": "mode",
          "type": {
            "kind": "number"
          }
        }
      ],
      "body": {
        "operations": [
          {
            "kind": "parameter",
            "result": 0,
            "type": {
              "kind": "number"
            },
            "index": 0
          },
          {
            "kind": "match",
            "value": 0,
            "arms": [
              {
                "pattern": {
                  "kind": "number",
                  "value": 0
                },
                "body": {
                  "operations": [
                    {
                      "kind": "return"
                    }
                  ]
                }
              }
            ]
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
assert.throws(register, (error) => assertModelValidationError(error, 'IR_CONTROL_FLOW'));
assert.equal(factoryCalls, 0);
```
