---
format: mica-case/v1
id: static-ddl-bytes-channel-config
kind: compile
---

# static-ddl-bytes-channel-config

## 规范来源

[docs/spec/language/declarations.rst](../../../../docs/spec/language/declarations.rst)

[docs/spec/channels.rst](../../../../docs/spec/channels.rst)

## 验收义务

前提：输入和输出 bytes 通道分别给出 `maxLength` 与 `capacity`（顺序不同）。

操作：编译该定义。

预期：接受两个通道的 bytes 配置，保留容量和长度上限。

## 输入

```ddl
device StaticFixture {
input channel incoming: bytes(maxLength: 256, capacity: 8); output channel outgoing: bytes(capacity: 4, maxLength: 64, overflow: Overflow.error);
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
  '接受 bytes 端点 maxLength 和 capacity；不声称验证发送长度边界。',
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
