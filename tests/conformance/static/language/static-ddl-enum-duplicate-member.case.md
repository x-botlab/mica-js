---
kind: compile
---

# static-ddl-enum-duplicate-member

## 规范来源

[docs/spec/language/types.rst](../../../../docs/spec/language/types.rst)

<!-- prettier-ignore -->
> 枚举在 device 内声明，至少一个成员，成员名唯一，使用 ``Mode.idle`` 引用。每个枚举保留具名类型身份；即使两个类型成员同名，也不能互换。成员没有公开数值编码，不提供与 number 的转换。

[docs/spec/language/lexical.rst](../../../../docs/spec/language/lexical.rst)

<!-- prettier-ignore -->
> 枚举成员和记录字段各自拥有内部名称空间，其内部名称必须唯一。

## 验收义务

前提：枚举重复声明同名成员 `idle`。

操作：编译该 device 定义。

预期：枚举内部名称重复，该定义被静态拒绝并给出非空诊断消息；同特性合法形式见 `static-ddl-match-enum-exhaustive`。

## 输入

```ddl
device StaticFixture {
enum Mode { idle, active, idle }
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
