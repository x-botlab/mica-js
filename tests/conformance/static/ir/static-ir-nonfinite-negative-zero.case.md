---
kind: compile
---

# static-ir-nonfinite-negative-zero

## 规范来源

[docs/spec/ir/schema.rst](../../../../docs/spec/ir/schema.rst)

## 验收义务

前提：手工 number 常量包含 NaN、正负无穷大和负零。

操作：使用真实 adapter 登记该 DeviceIR。

预期：接受这些常量并保留数值语义；不声称已验证运行数值保存。

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
        "operations": [
          {
            "kind": "constant",
            "result": 0,
            "type": {
              "kind": "number"
            },
            "constant": {
              "kind": "number",
              "value": "NaN"
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
              "value": "Infinity"
            }
          },
          {
            "kind": "constant",
            "result": 2,
            "type": {
              "kind": "number"
            },
            "constant": {
              "kind": "number",
              "value": "-Infinity"
            }
          },
          {
            "kind": "constant",
            "result": 3,
            "type": {
              "kind": "number"
            },
            "constant": {
              "kind": "number",
              "value": "-0"
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
const model = input;
model.declarations[0].body.operations[0].constant.value = NaN;
model.declarations[0].body.operations[1].constant.value = Infinity;
model.declarations[0].body.operations[2].constant.value = -Infinity;
model.declarations[0].body.operations[3].constant.value = -0;
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
const library = register();
assert.ok(library && typeof library === 'object');
assert.equal(factoryCalls, 0, 'IR validation must precede all factory calls');
```
