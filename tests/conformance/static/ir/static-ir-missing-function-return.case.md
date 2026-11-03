---
kind: compile
---

# static-ir-missing-function-return

## 规范来源

[docs/spec/ir/validation.rst](../../../../docs/spec/ir/validation.rst)

<!-- prettier-ignore -->
> 控制流检查分支穷尽、模式重复、最近循环跳转、函数正常返回路径、计算区域 yield 与路径终结后的后缀。

[docs/spec/ir/validation.rst](../../../../docs/spec/ir/validation.rst)

<!-- prettier-ignore -->
> * - IR_CONTROL_FLOW
>   - 非法跳转、不可达后缀、未穷尽选择、缺失正常返回或 yield。

## 验收义务

前提：手工 DeviceIR 的函数声明 returns 为 number，函数体是空操作序列，可自然结束而没有 returnValue。

操作：通过真实 adapter 的 createDeviceLibrary 登记该模型，并记录器件工厂调用次数。

预期：登记被拒绝，诊断包含 IR_CONTROL_FLOW；器件工厂调用次数为零。

## 输入

```json
{
  "kind": "device",
  "name": "ManualFixture",
  "declarations": [
    {
      "kind": "function",
      "name": "read",
      "pure": false,
      "params": [],
      "body": {
        "operations": []
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
assert.throws(register, (error) => assertModelValidationError(error, 'IR_CONTROL_FLOW'));
assert.equal(factoryCalls, 0, 'IR validation must precede all factory calls');
```
