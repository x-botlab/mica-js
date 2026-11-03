---
format: mica-case/v1
id: language-atomic-contextual-name
kind: compile
---

# contextual-name

## 规范来源

[docs/spec/language/lexical.rst](../../../../docs/spec/language/lexical.rst)

<!-- prettier-ignore -->
> ``input``、``output`` 与 ``public`` 是声明上下文中的修饰符，``channel`` 与 ``notification`` 在端点声明中识别。其他名称位置仍接受这些拼写，例如 ``fn output()`` 和 ``pin out;``。

## 验收义务

前提：device 将 input 用作 pin 名称，并将 output 用作函数名称。

操作：编译该 device 定义，并把产物登记到器件库。

预期：编译成功，产物可通过器件库登记。

## 输入

<!-- prettier-ignore -->
```ddl
device Atomic {
pin input;
fn output() {}
}
```

## 执行步骤

```typescript
const model = await adapter.compileDDL(typeof input === 'string' ? input : input.source);
let factoryCalls = 0;
```

## 断言

```typescript
assert.equal(model.kind, 'device');
assert.equal(model.name, 'Atomic');
const library = adapter.createDeviceLibrary([
  {
    id: 'language/atomic',
    model,
    create() {
      factoryCalls++;
      return { sync() {}, dispose() {} };
    },
  },
]);
assert.ok(library);
assert.equal(factoryCalls, 0);
```
