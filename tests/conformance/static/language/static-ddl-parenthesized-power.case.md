---
format: mica-case/v1
id: static-ddl-parenthesized-power
kind: compile
---

# static-ddl-parenthesized-power

## 规范来源

[docs/spec/language/expressions.rst](../../../../docs/spec/language/expressions.rst)

## 验收义务

前提：一元幂左值带括号，数值字面量含分隔符。

操作：编译该定义。

预期：接受带括号幂和合法字面量分隔符。

## 输入

```ddl
device StaticFixture {
const value = (-2) ** 2; const size = 1_000;
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
assert.ok(model && typeof model === 'object', '接受带括号的一元幂左值与合法字面量分隔符。');
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
