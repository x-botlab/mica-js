---
kind: compile
---

# static-ddl-direct-resource-parameters

## 规范来源

[docs/spec/language/types.rst](../../../../docs/spec/language/types.rst)

## 验收义务

前提：pure 函数接收直接 pin 与 memory 引用作为资源形参。

操作：编译该定义。

预期：接受直接资源参数，资源形参保持实例身份。

## 输入

```ddl
device StaticFixture {
pin probe;
memory data[1];
pure fn read(p: pin, m: memory) -> bool {
return p == probe && load8(m, 0) == 0;
}
derived ready: bool = read(probe, data);
}
```

## 执行步骤

```typescript
const model = await adapter.compileDDL(input);
let factoryCalls = 0;
```

## 断言

```typescript
assert.ok(model && typeof model === 'object', '接受直接 pin 与 memory 引用传给对应资源形参。');
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
