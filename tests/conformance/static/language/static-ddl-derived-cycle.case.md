---
kind: compile
---

# static-ddl-derived-cycle

## 规范来源

[docs/spec/language/declarations.rst](../../../../docs/spec/language/declarations.rst)

<!-- prettier-ignore -->
> derived 显式给出类型和纯表达式，允许调用 pure fn。依赖可包含属性、常量、state、sample、memory 读取及其他 derived，沿函数调用图静态收集且必须无环。

## 验收义务

前提：两个 derived 的表达式相互依赖。

操作：编译该 device 定义。

预期：编译拒绝该定义。

## 输入

```ddl
device StaticFixture {
derived first: number = second;
derived second: number = first;
}
```

## 执行步骤

```typescript
const compile = async () => {
  await adapter.compileDDL(input);
};
```

## 断言

```typescript
await assert.rejects(compile, '拒绝 derived 静态依赖环。');
```
