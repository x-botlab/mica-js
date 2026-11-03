---
kind: compile
---

# static-ddl-reaction-sync-effects

## 规范来源

[docs/spec/language/functions.rst](../../../../docs/spec/language/functions.rst)

## 验收义务

前提：reaction 体包含 state 写入、`now`、`random`、同步调用、输出发送和无值 return。

操作：编译该定义。

预期：接受这些同步效果。

## 输入

```ddl
device StaticFixture {
state count: number = 0;
output channel outgoing: number(capacity: 2);
fn update() {
count = count + 1;
}
reaction observe on count as (before, after) {
update();
const time = now();
outgoing.send(random());
return;
}
}
```

## 执行步骤

```typescript
const model = await adapter.compileDDL(input);
let factoryCalls = 0;
```

## 断言

```typescript
assert.ok(
  model && typeof model === 'object',
  '接受 reaction 内 state 写入、now、random、同步调用、输出发送和无值 return。',
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
