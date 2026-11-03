---
format: mica-case/v1
id: static-ir-empty-model
kind: compile
---

# static-ir-empty-model

## 规范来源

[docs/spec/ir/schema.rst](../../../../docs/spec/ir/schema.rst)

[docs/spec/assembly.rst](../../../../docs/spec/assembly.rst)

## 验收义务

前提：使用下列手工 DeviceIR 输入及真实 adapter。

操作：登记模型到器件库，记录工厂调用次数。

预期：接受无声明的手工 DeviceIR 登记；登记不调用工厂。工厂调用次数保持为零。

## 输入

```json
{
  "kind": "device",
  "name": "ManualFixture",
  "declarations": []
}
```

## 执行步骤

```typescript
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
const library = register();
assert.ok(library && typeof library === 'object');
assert.equal(factoryCalls, 0, 'IR validation must precede all factory calls');
```
