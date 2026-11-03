---
format: mica-case/v1
id: static-ddl-explicit-infinity
kind: compile
---

# static-ddl-explicit-infinity

## 规范来源

[docs/spec/language/expressions.rst](../../../../docs/spec/language/expressions.rst)

## 验收义务

前提：常量使用显式 `Infinity`、`-Infinity`、`NaN` 与 `-0`。

操作：编译该定义。

预期：接受这些 number 常量，保留字面量语义。

## 输入

```ddl
device StaticFixture {
const positive = Infinity; const negative = -Infinity; const nanValue = NaN; const zero = -0;
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
assert.ok(
  model && typeof model === 'object',
  '接受显式 Infinity、NaN 与负零 number 常量；不声称验证运行算术结果。',
);
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
