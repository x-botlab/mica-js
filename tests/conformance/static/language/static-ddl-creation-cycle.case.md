---
format: mica-case/v1
id: static-ddl-creation-cycle
kind: compile
---

# static-ddl-creation-cycle

## 规范来源

[docs/spec/language/declarations.rst](../../../../docs/spec/language/declarations.rst)

<!-- prettier-ignore -->
> 定义阶段即拒绝默认值或 const 的静态依赖环，不因某次实例提供了值而接受有环定义。

## 验收义务

前提：两个器件级 const 的初始化互相引用。

操作：编译该 device 定义。

预期：编译拒绝该定义。

## 输入

```ddl
device StaticFixture {
const first: number = second; const second: number = first;
}
```

## 执行步骤

```typescript
assert.equal(typeof adapter.compileDDL, 'function');
const compile = async () => {
  await adapter.compileDDL(input);
};
```

## 断言

```typescript
await assert.rejects(compile, '拒绝创建期 const 的静态依赖环。');
```
