---
kind: compile
---

# static-ddl-missing-match-arm

## 规范来源

[docs/spec/language/statements.rst](../../../../docs/spec/language/statements.rst)

<!-- prettier-ignore -->
> match 必须穷尽。bool 和枚举可以列出全部值；可空类型还须覆盖 none。number、string 以及不能逐项列举的值类型需要 ``_``；bytes 不提供内容模式。

## 验收义务

前提：bool match 只有 true 分支且无兜底。

操作：编译该 device 定义。

预期：编译拒绝该定义。

## 输入

```ddl
device StaticFixture {
fn choose(flag: bool) -> number { match flag { true => { return 1; } } }
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
await assert.rejects(compile, '拒绝缺少 false 且没有兜底的 bool match。');
```
