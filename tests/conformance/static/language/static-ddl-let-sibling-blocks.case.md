---
format: mica-case/v1
id: static-ddl-let-sibling-blocks
kind: compile
---

# static-ddl-let-sibling-blocks

## 规范来源

[docs/spec/language/statements.rst](../../../../docs/spec/language/statements.rst)

## 验收义务

前提：if 与 else 的兄弟块各自声明并修改同名 let。

操作：编译输入，并将产物交给真实 adapter 的 createDeviceLibrary。

预期：编译成功，返回器件模型，并通过 createDeviceLibrary 最终校验；接受 let 更新及兄弟块复用局部名。

## 输入

```ddl
device StaticFixture {
fn change(flag: bool) { if flag { let value = 1; value = 2; } else { let value = 3; value = 4; } }
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
assert.ok(model && typeof model === 'object', '接受 let 更新及兄弟块复用局部名。');
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
