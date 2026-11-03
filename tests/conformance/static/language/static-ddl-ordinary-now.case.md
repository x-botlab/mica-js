---
kind: compile
---

# static-ddl-ordinary-now

## 规范来源

[docs/spec/language/builtins.rst](../../../../docs/spec/language/builtins.rst)

<!-- prettier-ignore -->
> now 是只读但具有时间依赖的操作，不消耗 random 的序列状态。普通 fn、process、reaction 响应体和 JIT 执行路径可调用；pure fn、derived、创建期表达式与条件等待谓词拒绝调用，效果检查沿调用图传播。

## 验收义务

前提：普通 fn 调用 now，启动过程调用该函数。

操作：编译该 device 定义，并把产物登记到器件库。

预期：编译成功，产物可通过器件库登记；不声称验证时间结果。

## 输入

```ddl
device StaticFixture {
fn read() -> number {
return now();
}
process start {
const saved = read();
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
  '接受普通 fn 与 process 执行路径读取 now；不声称验证时间结果。',
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
