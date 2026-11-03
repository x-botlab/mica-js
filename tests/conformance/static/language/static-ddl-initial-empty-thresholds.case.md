---
format: mica-case/v1
id: static-ddl-initial-empty-thresholds
kind: compile
---

# static-ddl-initial-empty-thresholds

## 规范来源

[docs/spec/language/declarations.rst](../../../../docs/spec/language/declarations.rst)

[docs/spec/electrical.rst](../../../../docs/spec/electrical.rst)

## 验收义务

前提：pin 分别省略初值、显式空意图和带成对阈值的空初值。

操作：编译该定义。

预期：接受三种形式；阈值成对保留，空意图为合法初值。

## 输入

```ddl
device StaticFixture {
pin omitted; pin explicit = []; pin measured(low: 0.8, high: 2.0) = [];
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
assert.ok(model && typeof model === 'object', '接受省略初值、显式空意图及带成对阈值的空初值。');
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
