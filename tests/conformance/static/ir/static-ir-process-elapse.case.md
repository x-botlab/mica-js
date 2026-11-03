---
kind: compile
---

# static-ir-process-elapse

## 规范来源

[docs/spec/ir/validation.rst](../../../../docs/spec/ir/validation.rst)

<!-- prettier-ignore -->
> * - process
>   - 普通同步效果，另有 wait 和 input channel receive。
>   - 拒绝 redirect、JIT elapse / waitUntil / stop。

[docs/spec/ir/validation.rst](../../../../docs/spec/ir/validation.rst)

<!-- prettier-ignore -->
> * - IR_EFFECT
>   - 所在上下文禁止的读取、写入、调用或挂起效果。

## 验收义务

前提：手工 DeviceIR 的 start 过程体直接使用 elapse，时长为常量 0。

操作：通过真实 adapter 的 createDeviceLibrary 登记该模型，并记录器件工厂调用次数。

预期：登记被拒绝，诊断包含 IR_EFFECT；器件工厂调用次数为零。

## 输入

```json
{
  "kind": "device",
  "name": "ProcessElapse",
  "declarations": [
    {
      "kind": "start",
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
            "kind": "elapse",
            "duration": 0
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
