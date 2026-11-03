---
format: mica-case/v1
id: static-ddl-same-process-receive
kind: compile
---

# static-ddl-same-process-receive

## 规范来源

[docs/spec/language/builtins.rst](../../../../docs/spec/language/builtins.rst)

<!-- prettier-ignore -->
> ``await endpoint.receive()`` 从 input channel 取得一个负载值，可以将结果丢弃。

## 验收义务

前提：同一过程在两个完整初始化右侧依次接收同一 input channel。

操作：编译该 device 定义，并把产物登记到器件库。

预期：编译成功，产物可通过器件库登记；不声称验证实际消费和恢复。

## 输入

```ddl
device StaticFixture {
input channel incoming: number(capacity: 2); process start { const first = await incoming.receive(); const second = await incoming.receive(); }
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
assert.ok(model && typeof model === 'object', '接受同一过程的两个接收位置。');
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
