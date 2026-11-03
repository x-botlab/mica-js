---
kind: compile
---

# static-ddl-pure-now-transitive

## 规范来源

[docs/spec/language/functions.rst](../../../../docs/spec/language/functions.rst)

## 验收义务

前提：pure fn 经另一 pure fn 间接调用 now。

操作：调用真实 adapter 的 compileDDL 编译输入。

预期：编译拒绝该输入；inner 自身直接违反 pure 限制，因此不能由此断言独立验证了调用图传播。

## 输入

```ddl
device StaticFixture {
pure fn outer() -> number {
return inner();
}
pure fn inner() -> number {
return now();
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
await assert.rejects(compile, '拒绝 pure 函数经辅助 pure 调用读取 now。');
```
