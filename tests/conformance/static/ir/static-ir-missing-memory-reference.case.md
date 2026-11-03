---
format: mica-case/v1
id: static-ir-missing-memory-reference
kind: compile
---

# static-ir-missing-memory-reference

## 规范来源

[docs/spec/ir/validation.rst](../../../../docs/spec/ir/validation.rst)

<!-- prettier-ignore -->
> 未解析引用必须在接纳为可执行代码前完成检查。

[docs/spec/ir/validation.rst](../../../../docs/spec/ir/validation.rst)

<!-- prettier-ignore -->
> * - IR_REFERENCE
>   - 名称不存在、类别不匹配、声明重复或资源归属错误。

## 验收义务

前提：手工 DeviceIR 的 memoryLength 操作引用名为 missing 的 memory，器件没有该资源。

操作：通过真实 adapter 的 createDeviceLibrary 登记该模型，并记录器件工厂调用次数。

预期：登记被拒绝，诊断包含 IR_REFERENCE；器件工厂调用次数为零。

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
            "kind": "memoryLength",
            "memory": {
              "kind": "memory",
              "name": "missing"
            },
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
assert.throws(register, (error) => assertModelValidationError(error, 'IR_REFERENCE'));
assert.equal(factoryCalls, 0);
```
