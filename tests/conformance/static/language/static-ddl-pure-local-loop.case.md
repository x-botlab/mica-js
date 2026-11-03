---
format: mica-case/v1
id: static-ddl-pure-local-loop
kind: compile
---

# static-ddl-pure-local-loop

## 规范来源

[docs/spec/language/functions.rst](../../../../docs/spec/language/functions.rst)

## 验收义务

前提：pure 函数内使用局部 let、有限 while 循环和 state 读取。

操作：编译该定义。

预期：接受该 pure 函数，局部更新与循环合法。

## 输入

```ddl
device StaticFixture {
state count: number = 1;
     pure fn read() -> number {
       let total = 0;
       while total < 3 { total = total + 1; }
       assert total == 3;
       return count + total;
     }
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
  '接受 pure 函数的局部 let 更新、有限循环、state 读取和断言。',
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
