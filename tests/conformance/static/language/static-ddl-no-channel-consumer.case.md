---
format: mica-case/v1
id: static-ddl-no-channel-consumer
kind: compile
---

# static-ddl-no-channel-consumer

## 规范来源

[docs/spec/language/declarations.rst](../../../../docs/spec/language/declarations.rst)

<!-- prettier-ignore -->
> 方向以 DDL 为参照，声明必须显式 input 或 output。通道的 capacity 必填，overflow 可省略；bytes 通道另需 maxLength，其他负载不能带该选项。选项名不可重复，容量、上限与策略均为创建期表达式。

## 验收义务

前提：device 只声明带 capacity 的 number input channel。

操作：编译该 device 定义，并把产物登记到器件库。

预期：编译成功，产物可通过器件库登记；本例不声称验证消费调度。

## 输入

```ddl
device StaticFixture {
input channel incoming: number(capacity: 2);
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
assert.ok(model && typeof model === 'object', '接受无人接收的 input channel。');
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
