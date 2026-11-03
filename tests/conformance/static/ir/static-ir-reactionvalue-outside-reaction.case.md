---
format: mica-case/v1
id: static-ir-reactionvalue-outside-reaction
kind: compile
---

# static-ir-reactionvalue-outside-reaction

## 规范来源

[docs/spec/ir/schema.rst](../../../../docs/spec/ir/schema.rst)

<!-- prettier-ignore -->
> 它们只在本 reaction 的 body 及其词法嵌套区域合法，不能进入 capture、其他入口、辅助函数或 JIT 指令；函数 parameter 不能替代这些操作。

[docs/spec/ir/validation.rst](../../../../docs/spec/ir/validation.rst)

<!-- prettier-ignore -->
> 跨执行体句柄或在 capture / 函数中读取 reaction 绑定属于 IR_SCOPE

## 验收义务

前提：手工 DeviceIR 的普通函数体用 reactionValue 读取 previous 绑定，该函数不在任何 reaction 声明内。

操作：通过真实 adapter 的 createDeviceLibrary 登记该模型，并记录器件工厂调用次数。

预期：登记被拒绝，诊断包含 IR_SCOPE；器件工厂调用次数为零。

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
            "kind": "reactionValue",
            "binding": "previous",
            "result": 0,
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
assert.throws(register, (error) => assertModelValidationError(error, 'IR_SCOPE'));
assert.equal(factoryCalls, 0);
```
