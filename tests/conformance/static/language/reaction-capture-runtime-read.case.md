---
format: mica-case/v1
id: language-atomic-reaction-capture-runtime-read
kind: compile
---

# reaction-capture-runtime-read

## 规范来源

[docs/spec/language/functions.rst](../../../../docs/spec/language/functions.rst)

<!-- prettier-ignore -->
> 捕获表达式遵循现有纯表达式规则，可以读取属性、常量、state、derived、sample 和 memory，调用 pure fn；不另设更窄的读取集合。每项捕获独立求值，不能引用 previous / current、自身或其他 capture 名称。

## 验收义务

前提：capture 调用只读取 state 的 pure fn，不使用创建期读取限制。

操作：编译该 device 定义，并把产物登记到器件库。

预期：编译成功，产物可通过器件库登记。

## 输入

<!-- prettier-ignore -->
```ddl
device Atomic {
state count: number = 0;
pure fn read() -> number { return count; }
reaction observe on count as (before, after) capture saved = read() {}
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
