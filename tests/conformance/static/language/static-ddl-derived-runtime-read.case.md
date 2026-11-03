---
format: mica-case/v1
id: static-ddl-derived-runtime-read
kind: compile
---

# static-ddl-derived-runtime-read

## 规范来源

[docs/spec/language/declarations.rst](../../../../docs/spec/language/declarations.rst)

<!-- prettier-ignore -->
> derived 显式给出类型和纯表达式，允许调用 pure fn。依赖可包含属性、常量、state、sample、memory 读取及其他 derived，沿函数调用图静态收集且必须无环。

## 验收义务

前提：derived 经 pure fn 读取 state。

操作：编译该 device 定义，并把产物登记到器件库。

预期：编译成功，产物可通过器件库登记。

## 输入

```ddl
device StaticFixture {
state count: number = 1; pure fn read() -> number { return count; } derived next: number = read();
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
assert.ok(model && typeof model === 'object', '接受 derived 经 pure 函数读取运行时 state。');
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
