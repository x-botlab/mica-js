---
kind: compile
---

# static-ddl-record-string-field

## 规范来源

[docs/spec/language/types.rst](../../../../docs/spec/language/types.rst)

<!-- prettier-ignore -->
> 记录是 device 内的具名不可变值，允许零个字段，字段名唯一、全部必填，字段类型仅为 number 或 bool。记录保持扁平。

## 验收义务

前提：记录字段声明为 string。

操作：编译该 device 定义。

预期：记录字段类型超出 number、bool，该定义被静态拒绝并给出非空诊断消息；同特性合法形式见 `static-ddl-forward-types-functions`。

## 输入

```ddl
device StaticFixture {
record Item { name: string; }
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
