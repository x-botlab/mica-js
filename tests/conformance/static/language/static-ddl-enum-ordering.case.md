---
kind: compile
---

# static-ddl-enum-ordering

## 规范来源

[docs/spec/language/types.rst](../../../../docs/spec/language/types.rst)

<!-- prettier-ignore -->
> 枚举支持同类型相等比较与 match；不支持大小排序。内置枚举使用相同规则，成员含义由 :doc:`/electrical` 和 :doc:`/channels` 维护。

## 验收义务

前提：同一枚举的两个成员使用 `<` 比较。

操作：编译该 device 定义。

预期：枚举不提供大小排序，该定义被静态拒绝并给出非空诊断消息；同特性合法形式见 `static-ddl-match-enum-exhaustive`。

## 输入

```ddl
device StaticFixture {
enum Mode { idle, active }
fn ordered() -> bool { return Mode.idle < Mode.active; }
}
```

## 执行步骤

```typescript
const compile = () => adapter.compileDDL(input);
```

## 断言

```typescript
await assert.rejects(compile, (error) => {
  assert.ok(error instanceof Error, '编译拒绝必须抛出 Error。');
  assert.ok(error.message.length > 0, '编译诊断必须给出非空消息。');
  return true;
});
```
