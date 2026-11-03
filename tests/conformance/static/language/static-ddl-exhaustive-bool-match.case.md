---
format: mica-case/v1
id: static-ddl-exhaustive-bool-match
kind: compile
---

# static-ddl-exhaustive-bool-match

## 规范来源

[docs/spec/language/statements.rst](../../../../docs/spec/language/statements.rst)

## 验收义务

前提：bool 匹配包含 true 与 false 两个返回值分支。

操作：编译该定义。

预期：接受穷尽 match，各分支返回值类型一致。

## 输入

```ddl
device StaticFixture {
fn choose(flag: bool) -> number { match flag { true => { return 1; } false => { return 0; } } }
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
assert.ok(model && typeof model === 'object', '接受 bool 穷尽 match 各分支返回的有值函数。');
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
