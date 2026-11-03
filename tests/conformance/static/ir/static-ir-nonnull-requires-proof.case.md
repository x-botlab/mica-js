---
format: mica-case/v1
id: static-ir-nonnull-requires-proof
kind: compile
---

# static-ir-nonnull-requires-proof

## 规范来源

[docs/spec/ir/validation.rst](../../../../docs/spec/ir/validation.rst)

<!-- prettier-ignore -->
> ``nonNull`` 要求对应值在当前位置已证明非空；缺少证明报告 IR_TYPE。它只是经证明的类型收窄，不是可能在运行时失败的强制解包。

## 验收义务

前提：手工 DeviceIR 先以 optional 类型产生 none 常量，再对该结果使用 nonNull，路径上没有非空证明。

操作：通过真实 adapter 的 createDeviceLibrary 登记该模型，并记录器件工厂调用次数。

预期：登记被拒绝，诊断包含 IR_TYPE；器件工厂调用次数为零。

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
              "kind": "optional",
              "inner": {
                "kind": "number"
              }
            },
            "constant": {
              "kind": "none"
            }
          },
          {
            "kind": "nonNull",
            "value": 0,
            "result": 1,
            "type": {
              "kind": "number"
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
assert.throws(register, (error) => assertModelValidationError(error, 'IR_TYPE'));
assert.equal(factoryCalls, 0);
```
