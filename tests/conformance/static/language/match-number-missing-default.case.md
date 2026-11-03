---
format: mica-case/v1
id: language-atomic-match-number-missing-default
kind: compile
---

# match-number-missing-default

## 规范来源

[docs/spec/language/statements.rst](../../../../docs/spec/language/statements.rst)

<!-- prettier-ignore -->
> match 必须穷尽。bool 和枚举可以列出全部值；可空类型还须覆盖 none。number、string 以及不能逐项列举的值类型需要 ``_``；bytes 不提供内容模式。

## 验收义务

前提：number match 只列出一个数值模式，没有兜底分支。

操作：编译该 device 定义。

预期：编译拒绝该定义。

## 输入

<!-- prettier-ignore -->
```ddl
device Atomic {
fn choose(value: number) { match value { 1 => {} } }
}
```

## 执行步骤

```typescript
const { validateDDL } = await importModule('../assertions.mjs');
const compile = () => validateDDL(adapter, input);
```

## 断言

```typescript
await assert.rejects(compile);
```
