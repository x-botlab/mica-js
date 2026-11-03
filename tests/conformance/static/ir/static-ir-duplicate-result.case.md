---
kind: compile
---

# static-ir-duplicate-result

## 规范来源

[docs/spec/ir/schema.rst](../../../../docs/spec/ir/schema.rst)

<!-- prettier-ignore -->
> 一个结果编号在同一独立执行体内只定义一次，局部槽编号也只声明一次。

[docs/spec/ir/validation.rst](../../../../docs/spec/ir/validation.rst)

<!-- prettier-ignore -->
> 单个原因同时违反多项要求时可以报告其最直接的类别；固定码用于分类，不要求实现制造重复诊断。

## 验收义务

前提：手工 DeviceIR 的同一函数体中，两个 constant 操作都定义结果编号 0。

操作：通过真实 adapter 的 createDeviceLibrary 登记该模型，并记录器件工厂调用次数。

预期：登记被拒绝，诊断包含 IR_SCHEMA 或 IR_SCOPE 之一；器件工厂调用次数为零。

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
              "kind": "number"
            },
            "constant": {
              "kind": "number",
              "value": 1
            }
          },
          {
            "kind": "constant",
            "result": 0,
            "type": {
              "kind": "number"
            },
            "constant": {
              "kind": "number",
              "value": 2
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
assert.throws(register, (error) => {
  const codes = error?.diagnostic?.cause?.diagnostics?.map((item) => item.code) ?? [];
  const code = codes.find((item) => item === 'IR_SCHEMA' || item === 'IR_SCOPE');
  assert.ok(code, 'duplicate result must be rejected by schema or scope validation');
  return assertModelValidationError(error, code);
});
assert.equal(factoryCalls, 0);
```
