---
format: mica-case/v1
id: static-ddl-empty-device
kind: compile
---

# static-ddl-empty-device

## 规范来源

[docs/spec/appendices/grammar.rst](../../../../docs/spec/appendices/grammar.rst)

<!-- prettier-ignore -->
> device = "device", identifier, [ "(", [ properties ], ")" ], "{", { member }, "}" ;

## 验收义务

前提：文件中仅有一个没有成员的 device。

操作：编译该 device 定义，并把产物登记到器件库。

预期：编译成功，产物可通过器件库登记。

## 输入

```ddl
device StaticFixture {

}
```

## 执行步骤

```typescript
assert.equal(typeof adapter.compileDDL, 'function');
const model = await adapter.compileDDL(input);
let factoryCalls = 0;
```

## 断言

```typescript
assert.ok(model && typeof model === 'object', '接受无成员的单 device 文件。');
assert.equal(model.kind, 'device');
assert.equal(model.name, 'StaticFixture');
assert.ok(Array.isArray(model.declarations));
const library = adapter.createDeviceLibrary([
  {
    id: 'static/fixture',
    model,
    create() {
      factoryCalls++;
      return { sync() {}, dispose() {} };
    },
  },
]);
assert.ok(library && typeof library === 'object');
assert.equal(factoryCalls, 0, 'Library registration must not invoke factories');
```
