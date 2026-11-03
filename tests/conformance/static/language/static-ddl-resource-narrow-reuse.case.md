---
kind: compile
---

# static-ddl-resource-narrow-reuse

## 规范来源

[docs/spec/language/types.rst](../../../../docs/spec/language/types.rst)

<!-- prettier-ignore -->
> 对每次可能变化的 state、derived 或 sample 路径读取，不沿用先前另一读取的检查；先保存到局部再检查。

## 验收义务

前提：函数检查可空 state 后重新读取它并作数值运算。

操作：编译该 device 定义。

预期：编译拒绝该定义。

## 输入

```ddl
device StaticFixture {
state value: number? = none;
fn read() -> number {
if value != none {
return value + 1;
}
return 0;
}
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
await assert.rejects(compile, '拒绝将一次 state 非空检查复用于另一次资源读取。');
```
