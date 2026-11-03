---
format: mica-case/v1
id: static-ir-duplicate-declaration
kind: compile
---

# static-ir-duplicate-declaration

## 规范来源

[docs/spec/ir/validation.rst](../../../../docs/spec/ir/validation.rst)

<!-- prettier-ignore -->
> 声明检查名称唯一、合法类型位置、参数及字段重复、前向引用匹配、启动入口唯一、端点方向与配置，以及创建期图、derived 图、同步调用图无环。

[docs/spec/ir/validation.rst](../../../../docs/spec/ir/validation.rst)

<!-- prettier-ignore -->
> * - IR_REFERENCE
>   - 名称不存在、类别不匹配、声明重复或资源归属错误。

## 验收义务

前提：手工 DeviceIR 声明两个同名 pin，其余声明构成最小上下文。

操作：通过真实 adapter 的 createDeviceLibrary 登记该模型，并记录器件工厂调用次数。

预期：登记被拒绝，诊断包含 IR_REFERENCE；器件工厂调用次数为零。

## 输入

```json
{
  "kind": "device",
  "name": "ManualFixture",
  "declarations": [
    {
      "kind": "pin",
      "name": "probe"
    },
    {
      "kind": "pin",
      "name": "probe"
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
assert.throws(register, (error) => assertModelValidationError(error, 'IR_REFERENCE'));
assert.equal(factoryCalls, 0, 'IR validation must precede all factory calls');
```
