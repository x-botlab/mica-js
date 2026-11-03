---
format: mica-case/v1
id: static-ddl-initial-props-pure
kind: compile
---

# static-ddl-initial-props-pure

## 规范来源

[docs/spec/electrical.rst](../../../../docs/spec/electrical.rst)

[docs/spec/language/functions.rst](../../../../docs/spec/language/functions.rst)

## 验收义务

前提：pin 初值经创建期 pure 函数读取属性并构造电阻支路。

操作：编译该定义。

预期：接受该创建期初值，pure 函数可读取属性与 const。

## 输入

```ddl
device StaticFixture(resistance: number default 1000) {
       const scale = 2;
       pure fn bias(target: pin) -> intent { return resistor(to: target, resistance: resistance * scale); }
       pin reference;
       pin probe = bias(reference);
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
  '接受初始意图经创建期 pure 函数读取属性和 const 构造支路。',
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
